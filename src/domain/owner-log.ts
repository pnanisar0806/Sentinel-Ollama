import type { Db } from '../db/client.js';
import { formatInr, type Paise } from '../money/paise.js';
import { istDate, istMonth } from './sips.js';
import { GROUPS, type ReversalEntity } from './reversals.js';
import { idleBankCash, loadBucketBalances, loadSpLabels } from './bucket-balances.js';
import { loadPositions } from './networth.js';
import { fromMicro, heldAfterSales, instrumentMeta, loadLiveSales, toMicro } from './owner-sales.js';
import { typeOf } from './fund-mix.js';
import { FUND_TYPE_LABEL } from './fund-types.js';

/**
 * What the owner did outside Sentinel, told to it from the web app (/log).
 *
 * Each entry is a fact the rest of the system reads — a goal deposit is what the cash
 * ceiling excuses and what the buckets report counts — and each lands in `audit_log`
 * with `actor = 'owner'`, which is where the timeline reads it back from.
 */

export type GoalMoveKind = 'sip' | 'maturity' | 'vest' | 'withdrawal';

// The owner's today is the India date: at 01:30 IST the UTC date is still yesterday, and
// a purchase made that morning is not "in the future".
const today = (now: string): string => istDate(now);

/** YYYY-MM-DD and a real calendar day: 2026-02-30 and 2026-13-45 are refused. */
function assertRealDate(on: string): void {
  const d = new Date(`${on}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== on) throw new Error(`not a date: ${on}`);
}

function assertDate(on: string, now: string): void {
  assertRealDate(on);
  if (on > today(now)) throw new Error(`${on} is in the future`);
}

async function audit(db: Db, entity: string, entityId: string, action: string, payload: object): Promise<void> {
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload) values ($1, $2, $3, 'owner', $4::jsonb)`,
    [entity, entityId, action, payload],
  );
}

/** Money into (or out of) a goal bucket. The amount is entered positive; a withdrawal is stored negative. */
export async function logGoalMove(
  db: Db,
  m: { bucketId: string; occurredOn: string; amountPaise: bigint; kind: GoalMoveKind; note: string },
  now = new Date().toISOString(),
): Promise<void> {
  if (m.amountPaise <= 0n) throw new Error('the amount must be positive');
  assertDate(m.occurredOn, now);
  const [bucket] = await db.query<{ name: string }>(`select name from buckets where id = $1`, [m.bucketId]);
  if (!bucket) throw new Error(`no goal ${m.bucketId}`);
  const signed = m.kind === 'withdrawal' ? -m.amountPaise : m.amountPaise;
  await db.withTransaction(async (tx) => {
    await lockBuckets(tx, [m.bucketId]);
    const [row] = await tx.query<{ id: string }>(
      `insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, note, as_of, source)
       values ($1, $2, $3, $4, $5, $6, 'owner-web') returning id::text`,
      [m.bucketId, m.occurredOn, signed.toString(), m.kind, m.note.trim(), now],
    );
    await audit(tx, 'bucket_flow', m.bucketId, 'LOGGED', {
      on: m.occurredOn, amountPaise: signed.toString(), kind: m.kind, note: m.note.trim(), bucket: bucket.name,
      rowId: row!.id, source: 'owner-web',
    });
  });
}

/** The row lock `reverseEntry` takes, so a write and a reversal touching one bucket serialise. */
async function lockBuckets(tx: Db, ids: string[]): Promise<void> {
  await tx.query(`select id from buckets where id = any($1::text[]) for update`, [ids]);
}

type Pot = 'B2' | 'B3' | 'B4' | 'SP';
export type EarmarkEnd = 'FI' | Pot;
const EARMARK_ENDS: readonly string[] = ['FI', 'B2', 'B3', 'B4', 'SP'];
const SPEND_SOURCES: readonly string[] = ['B2', 'B3', 'B4', 'SP', 'BANK'];
/** Pots held as bank cash; a move between two of them needs only the source balance. */
const CASH_POTS: readonly string[] = ['B3', 'SP'];

function spLabel(label: string | undefined): string {
  const l = (label ?? '').trim();
  if (l === '') throw new Error('Planned spending needs a label');
  if (l.length > 80) throw new Error('a label is limited to 80 characters');
  return l;
}

/**
 * A bucket source's name and live balance (reversed flows skipped; RSU value never counts,
 * spec §7.6); for SP, the open label's. Call under `lockBuckets`.
 */
async function available(tx: Db, id: Pot, label: string | null): Promise<{ name: string; where: string; paise: bigint }> {
  const [b] = await tx.query<{ name: string }>(`select name from buckets where id = $1`, [id]);
  if (!b) throw new Error(`no bucket ${id}`);
  if (id !== 'SP') return { name: b.name, where: b.name, paise: (await loadBucketBalances(tx)).get(id) ?? 0n };
  const pot = (await loadSpLabels(tx)).find((p) => p.label === label);
  if (!pot) throw new Error(`no open ${b.name} pot "${label}"`);
  return { name: b.name, where: `${b.name}: ${label}`, paise: pot.balancePaise };
}

function cover(where: string, have: bigint, amount: bigint, verb: string): void {
  if (have < amount) throw new Error(`${where} holds ${formatInr(have as Paise)}; cannot ${verb} ${formatInr(amount as Paise)}`);
}

async function writeFlow(
  tx: Db, f: { bucket: Pot; on: string; amount: bigint; kind: 'earmark' | 'spend' | 'sale'; label: string | null; note: string }, now: string,
): Promise<string> {
  const [row] = await tx.query<{ id: string }>(
    `insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, note, label, as_of, source)
     values ($1, $2, $3, $4, $5, $6, $7, 'owner-web') returning id::text`,
    [f.bucket, f.on, f.amount.toString(), f.kind, f.note, f.label, now]);
  return row!.id;
}

/**
 * Set money aside (spec §3.3, §7.3, §7.6): −X on a bucket source, +X on a bucket
 * destination. FI is not a bucket, so its side writes no row; its corpus moves by
 * construction. `fiCorpusPaise` is the caller's FI corpus (web: `loadGoalTracker`) — src/
 * may not read goal status. The audit row's id is the reversal key.
 */
export async function logEarmark(
  db: Db,
  e: { on: string; from: EarmarkEnd; to: EarmarkEnd; amountPaise: bigint; label?: string | undefined; expectedOn?: string | undefined; note: string; fiCorpusPaise?: bigint | null | undefined },
  now = new Date().toISOString(),
): Promise<void> {
  if (e.amountPaise <= 0n) throw new Error('the amount must be positive');
  assertDate(e.on, now);
  if (!EARMARK_ENDS.includes(e.from) || !EARMARK_ENDS.includes(e.to)) throw new Error(`cannot earmark from ${e.from} to ${e.to}`);
  if (e.from === e.to) throw new Error('an earmark moves money between two different places');
  const label = e.from === 'SP' || e.to === 'SP' ? spLabel(e.label) : null;
  const expectedOn = e.expectedOn?.trim() || null;
  if (expectedOn !== null) assertRealDate(expectedOn);
  const note = e.note.trim();
  await db.withTransaction(async (tx) => {
    const pots = [e.from, e.to].filter((b): b is Pot => b !== 'FI');
    await lockBuckets(tx, pots);
    let fromName = 'FI';
    if (e.from === 'FI') {
      if (e.fiCorpusPaise == null) throw new Error('FI corpus is unknown; cannot earmark from FI');
      cover('FI', e.fiCorpusPaise, e.amountPaise, 'earmark');
    } else {
      const a = await available(tx, e.from, e.from === 'SP' ? label : null);
      cover(a.where, a.paise, e.amountPaise, 'earmark');
      fromName = a.name;
    }
    // Money landing in a cash pot (B3, SP) must be in the bank: FI, B2 and B4 may sit in
    // invested assets, and sizing and the cash ceiling hold B3 + SP back from bank cash.
    if (CASH_POTS.includes(e.to) && !CASH_POTS.includes(e.from)) {
      const idle = idleBankCash(await loadPositions(tx), await loadBucketBalances(tx));
      if (idle === null) throw new Error('bank balance is unknown; cannot earmark into a cash pot');
      cover('Idle bank cash', idle, e.amountPaise, 'earmark');
    }
    const toName = e.to === 'FI'
      ? 'FI' : (await tx.query<{ name: string }>(`select name from buckets where id = $1`, [e.to]))[0]!.name;
    const rowIds: string[] = [];
    for (const [bucket, amount] of [[e.from, -e.amountPaise], [e.to, e.amountPaise]] as const) {
      if (bucket === 'FI') continue;
      rowIds.push(await writeFlow(tx, { bucket, on: e.on, amount, kind: 'earmark', label: bucket === 'SP' ? label : null, note }, now));
    }
    await audit(tx, 'earmark', `${e.from}>${e.to}`, 'LOGGED', {
      source: 'owner-web', rowIds, on: e.on, from: e.from, to: e.to, amountPaise: e.amountPaise.toString(),
      label, expectedOn, note, fromName, toName,
    });
  });
}

/**
 * Money spent (spec §3.2): −X (kind 'spend') on a bucket, or on an SP label. A BANK spend
 * writes no flow — the balance sync already sees it — only the audit row.
 */
export async function logSpend(
  db: Db,
  s: { on: string; amountPaise: bigint; purpose: string; from: Pot | 'BANK'; label?: string | undefined; note: string },
  now = new Date().toISOString(),
): Promise<void> {
  if (s.amountPaise <= 0n) throw new Error('the amount must be positive');
  assertDate(s.on, now);
  if (!SPEND_SOURCES.includes(s.from)) throw new Error(`cannot spend from ${s.from}`);
  const purpose = s.purpose.trim();
  if (purpose === '') throw new Error('a spend needs a purpose');
  if (purpose.length > 120) throw new Error('a purpose is limited to 120 characters');
  const label = s.from === 'SP' ? spLabel(s.label) : null;
  const note = s.note.trim();
  await db.withTransaction(async (tx) => {
    const rowIds: string[] = [];
    let fromName = 'my bank';
    if (s.from !== 'BANK') {
      await lockBuckets(tx, [s.from]);
      const a = await available(tx, s.from, label);
      cover(a.where, a.paise, s.amountPaise, 'spend');
      fromName = a.name;
      // The flow's note is the purpose: a refused reversal names it ("reverse the ₹1.2L Hotels … first").
      rowIds.push(await writeFlow(tx, { bucket: s.from, on: s.on, amount: -s.amountPaise, kind: 'spend', label, note: purpose }, now));
    }
    await audit(tx, 'spend', s.from, 'LOGGED', {
      source: 'owner-web', rowIds, on: s.on, from: s.from, amountPaise: s.amountPaise.toString(), purpose, label, note, fromName,
    });
  });
}

/**
 * A sale or redemption the owner made (spec §3.1): an `owner_sales` row and, with a
 * destination, a +proceeds flow (kind 'sale') into that pot, under one audit row keyed for
 * reversal. Proceeds into B3 or SP need no idle-cash check: logged once the money reaches
 * the bank (§7.7), they are new cash. A surviving manual-seed holding (no feed, e.g. US:NOW)
 * may not be oversold; a synced one is not checked, its feed is the truth. Never touches
 * the envelope or sizing: proceeds are not budget.
 */
export async function logSale(
  db: Db,
  s: { on: string; instrumentId: string; units: number | null; proceedsPaise: bigint; destination: Pot | null; label?: string | undefined; note: string },
  now = new Date().toISOString(),
): Promise<void> {
  if (s.proceedsPaise <= 0n) throw new Error('the amount must be positive');
  assertDate(s.on, now);
  const [inst] = await db.query<{ kind: string; name: string }>(`select kind, name from instruments where id = $1`, [s.instrumentId]);
  if (!inst) throw new Error(`no holding ${s.instrumentId}`);
  if (inst.kind === 'BOND') throw new Error('a bond redemption is logged on its own form: use the bond redemption form');
  let micro: bigint | null = null;
  if (s.units === null) {
    if (inst.kind !== 'MF') throw new Error('units sold are required for anything but a mutual fund');
  } else {
    if (!Number.isFinite(s.units) || s.units <= 0) throw new Error('units sold must be positive');
    const m = Math.round(s.units * 1e6);
    if (Math.abs(m - s.units * 1e6) > 1e-3) throw new Error('units sold are limited to 6 decimal places');
    micro = BigInt(m);
  }
  if (s.destination !== null && !(['B2', 'B3', 'B4', 'SP'] as const).includes(s.destination)) throw new Error(`cannot put a sale into ${s.destination}`);
  const label = s.destination === 'SP' ? spLabel(s.label) : null;
  const note = s.note.trim();
  const units = micro === null ? null : fromMicro(micro);
  await db.withTransaction(async (tx) => {
    if (s.destination) await lockBuckets(tx, [s.destination]);
    // Oversell: read the seed row itself, not `loadPositions`, which drops a sold-out
    // holding — a guard keyed on it would switch off at 0 held. The row is the instrument's
    // in the latest manual-seed snapshot (latest snapshot per source, as `loadPositions`);
    // any other source's latest snapshot reporting the instrument makes it synced: no check.
    if (micro !== null) {
      const [h] = await tx.query<{ quantity: string; since: string; synced: boolean }>(
        `with latest as (
           select distinct on (sn.source) sn.id, sn.source from snapshots sn
            order by sn.source, sn.business_date desc, sn.taken_at desc
         )
         select h.quantity::text quantity, (h.as_of at time zone 'Asia/Kolkata')::date::text since,
                exists (select 1 from holdings o join latest lo on lo.id = o.snapshot_id
                         where o.instrument_id = $1 and o.source <> 'manual-seed') synced
           from holdings h join latest l on l.id = h.snapshot_id
          where l.source = 'manual-seed' and h.source = 'manual-seed' and h.instrument_id = $1
          limit 1`, [s.instrumentId]);
      const refuse = (held: bigint) => {
        if (micro > held) throw new Error(`${inst.name} holds ${fromMicro(held)} unit${held === 1_000_000n ? '' : 's'}; cannot sell ${units}`);
      };
      if (h && !h.synced) {
        refuse(heldAfterSales(await loadLiveSales(tx), { instrumentId: s.instrumentId, quantity: h.quantity, since: h.since }).held);
      } else {
        // A synced holding: the most units a feed snapshot reported (summed over accounts), from
        // the last snapshot strictly before the sale onward. The evening sync on the sale day
        // already shows the reduced quantity, so the anchor must be the day before. With no
        // snapshot before the sale, every snapshot counts. Never reported anywhere: holds 0.
        // ponytail: other logged sales are not netted out; a duplicate sale log passes.
        const [f] = await tx.query<{ q: string | null }>(
          `select max(t.q)::text q from (
             select sum(h.quantity) q from holdings h join snapshots sn on sn.id = h.snapshot_id
              where h.instrument_id = $1 and sn.source <> 'manual-seed'
                and sn.business_date >= coalesce((select max(s2.business_date) from snapshots s2 join holdings h2 on h2.snapshot_id = s2.id
                                                   where h2.instrument_id = $1 and s2.source <> 'manual-seed' and s2.business_date < $2::date), '-infinity'::date)
              group by sn.id) t`,
          [s.instrumentId, s.on]);
        refuse(f?.q == null ? 0n : toMicro(f.q));
      }
    }
    const [row] = await tx.query<{ id: string }>(
      `insert into owner_sales (sold_on, instrument_id, units, proceeds_paise, destination, note, as_of, source)
       values ($1, $2, $3, $4, $5, $6, $7, 'owner-web') returning id::text`,
      [s.on, s.instrumentId, units, s.proceedsPaise.toString(), s.destination, note, now]);
    const rowIds: string[] = [];
    let destinationName: string | null = null;
    if (s.destination) {
      destinationName = (await tx.query<{ name: string }>(`select name from buckets where id = $1`, [s.destination]))[0]!.name;
      rowIds.push(await writeFlow(tx, { bucket: s.destination, on: s.on, amount: s.proceedsPaise, kind: 'sale', label, note: `Sold ${inst.name}` }, now));
    }
    await audit(tx, 'owner_sale', s.instrumentId, 'LOGGED', {
      source: 'owner-web', rowId: row!.id, rowIds, on: s.on, instrumentId: s.instrumentId, name: inst.name, units,
      proceedsPaise: s.proceedsPaise.toString(), destination: s.destination, destinationName, label, note,
    });
  });
}

/**
 * A purchase the owner made outside Sentinel (SIP gaps Task 2). It counts against the IST
 * month of `boughtOn` in what remains to invest. `units` is kept as exact decimal text.
 */
export async function logPurchase(
  db: Db,
  p: { boughtOn: string; description: string; amountPaise: bigint; instrumentId?: string | null; units?: string | null; note?: string },
  now = new Date().toISOString(),
): Promise<void> {
  if (p.amountPaise <= 0n) throw new Error('the amount must be positive');
  assertDate(p.boughtOn, now);
  const description = p.description.trim();
  if (description === '') throw new Error('a purchase needs a description');
  if (description.length > 200) throw new Error('a description is limited to 200 characters');
  const note = (p.note ?? '').trim();
  await db.withTransaction(async (tx) => {
    const [row] = await tx.query<{ id: string }>(
      `insert into owner_purchases (bought_on, instrument_id, description, amount_paise, units, note, as_of, source)
       values ($1, $2, $3, $4, $5, $6, $7, 'owner-web') returning id::text`,
      [p.boughtOn, p.instrumentId ?? null, description, p.amountPaise.toString(), p.units ?? null, note, now],
    );
    await audit(tx, 'owner_purchase', row!.id, 'LOGGED', {
      on: p.boughtOn, amountPaise: p.amountPaise.toString(), description,
      instrumentId: p.instrumentId ?? null, units: p.units ?? null, note, rowId: row!.id, source: 'owner-web',
    });
  });
}

export interface SipMove {
  id: string; fromInstrumentId: string; fromName: string; toInstrumentId: string; toName: string;
  amountPaise: bigint; firstMonth: string /* YYYY-MM */; on: string; note: string;
}

/** YYYY-MM one month before `month`. */
const prevMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

export type SipIndexType = 'NIFTY50' | 'NEXT50' | 'US';
const INDEX_TYPES: readonly string[] = ['NIFTY50', 'NEXT50', 'US'] satisfies SipIndexType[];

/**
 * The funds a SIP move may name, with the category it is checked against: `amfiCategory` on
 * the instrument or its canonical sibling, else a switch-universe fund's (`MFU:*`)
 * `metadata.category`. `indexType` is the index an index fund tracks: a registered challenger's
 * `metadata.indexType`, else the fund's type (`typeOf`); null for any other fund. The /log
 * pickers read both, so every pair they offer passes.
 */
export async function sipMoveFunds(
  db: Db, ids: string[], lock = false,
): Promise<{ id: string; name: string; canonicalId: string | null; category: string | null; indexType: SipIndexType | null }[]> {
  const rows = await db.query<{ id: string; name: string; canonicalId: string | null; category: string | null; metaIndexType: string | null }>(
    `select i.id, i.name, i.canonical_id "canonicalId",
            coalesce(${instrumentMeta('i')}->>'amfiCategory',
                     (select ${instrumentMeta('s')}->>'amfiCategory' from instruments s
                       where s.canonical_id = i.canonical_id and s.id <> i.id and ${instrumentMeta('s')}->>'amfiCategory' is not null
                       limit 1),
                     case when i.id like 'MFU:%' then ${instrumentMeta('i')}->>'category' end) category,
            ${instrumentMeta('i')}->>'indexType' "metaIndexType"
       from instruments i where i.id = any($1::text[])${lock ? ' for update of i' : ''}`,
    [ids]);
  return Promise.all(rows.map(async ({ metaIndexType, ...r }) => {
    const t = metaIndexType ?? (await typeOf(db, r.id))?.type ?? null;
    return { ...r, indexType: t !== null && INDEX_TYPES.includes(t) ? t as SipIndexType : null };
  }));
}

/**
 * A SIP moved from one fund to another in the same AMFI category (fund switch spec §3).
 * The category is the one `sipMoveFunds` reads. One active move per "from" fund; a reversed one frees it.
 */
export async function logSipMove(
  db: Db,
  m: { on: string; fromInstrumentId: string; toInstrumentId: string; amountPaise: bigint; firstMonth: string; note: string },
  now = new Date().toISOString(),
): Promise<{ id: string }> {
  if (!m.fromInstrumentId.trim()) throw new Error('pick the fund the SIP moved from');
  if (!m.toInstrumentId.trim()) throw new Error('pick the fund the SIP moved to');
  if (m.fromInstrumentId === m.toInstrumentId) throw new Error('the new fund must differ from the old one');
  if (m.amountPaise <= 0n) throw new Error('the amount must be positive');
  assertDate(m.on, now);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m.firstMonth)) throw new Error(`not a month: ${m.firstMonth}`);
  const earliest = prevMonth(istMonth(now));
  if (m.firstMonth < earliest) throw new Error(`the first month cannot be before ${earliest}`);
  const note = m.note.trim();
  return db.withTransaction(async (tx) => {
    // Row locks on both funds, so two concurrent moves from one fund serialise on the active check.
    const funds = await sipMoveFunds(tx, [m.fromInstrumentId, m.toInstrumentId], true);
    const fund = (id: string) => {
      const f = funds.find((x) => x.id === id);
      if (!f) throw new Error(`no fund ${id}`);
      if (!f.category) throw new Error(`category unknown for ${f.name}`);
      return f as { id: string; name: string; category: string; indexType: SipIndexType | null };
    };
    const from = fund(m.fromInstrumentId);
    const to = fund(m.toInstrumentId);
    if (from.category !== to.category) throw new Error('the new fund must be in the same category');
    // AMFI files every index under one category: Nifty 50 → Next 50 would pass the check above.
    if (from.indexType !== to.indexType) {
      const tracks = (f: { name: string; indexType: SipIndexType | null }) =>
        `${f.name} ${f.indexType === null ? 'is not an index fund' : `tracks the ${FUND_TYPE_LABEL[f.indexType]}`}`;
      throw new Error(`a SIP moves only between funds tracking the same index: ${tracks(from)}, ${tracks(to)}`);
    }
    if ((await loadActiveSipMoves(tx)).some((x) => x.fromInstrumentId === from.id)) {
      throw new Error('a move from this fund is already logged; reverse it first');
    }
    const [row] = await tx.query<{ id: string }>(
      `insert into sip_moves (from_instrument_id, to_instrument_id, amount_paise, first_month, note, occurred_on, as_of, source)
       values ($1, $2, $3, $4, $5, $6, $7, 'owner-web') returning id::text`,
      [from.id, to.id, m.amountPaise.toString(), m.firstMonth, note, m.on, now]);
    await audit(tx, 'sip_move', row!.id, 'LOGGED', {
      on: m.on, fromInstrumentId: from.id, fromName: from.name, toInstrumentId: to.id, toName: to.name,
      amountPaise: m.amountPaise.toString(), firstMonth: m.firstMonth, note, rowId: row!.id, source: 'owner-web',
    });
    return { id: row!.id };
  });
}

/** Every SIP move not reversed, newest first. */
export async function loadActiveSipMoves(db: Db): Promise<SipMove[]> {
  const rows = await db.query<{
    id: string; from_id: string; from_name: string; to_id: string; to_name: string;
    amount_paise: string; first_month: string; on: string; note: string;
  }>(
    `select m.id::text, m.from_instrument_id from_id, f.name from_name, m.to_instrument_id to_id, t.name to_name,
            m.amount_paise::text, m.first_month, m.occurred_on::text "on", m.note
       from sip_moves m
       join instruments f on f.id = m.from_instrument_id
       join instruments t on t.id = m.to_instrument_id
      where not exists (select 1 from log_reversals r where r.entity = 'sip_move' and r.entity_id = m.id::text)
      order by m.id desc`);
  return rows.map((r) => ({
    id: r.id, fromInstrumentId: r.from_id, fromName: r.from_name, toInstrumentId: r.to_id, toName: r.to_name,
    amountPaise: BigInt(r.amount_paise), firstMonth: r.first_month, on: r.on, note: r.note,
  }));
}

export async function completeMilestone(db: Db, id: string, on: string, now = new Date().toISOString()): Promise<void> {
  assertDate(on, now);
  const [m] = await db.query<{ completed_on: string | null; name: string }>(
    `select completed_on::text, name from milestones where id = $1`, [id]);
  if (!m) throw new Error(`no milestone ${id}`);
  if (m.completed_on !== null) throw new Error(`${m.name} is already marked complete on ${m.completed_on}`);
  await db.withTransaction(async (tx) => {
    await tx.query(`update milestones set completed_on = $2 where id = $1`, [id, on]);
    await audit(tx, 'milestone', id, 'COMPLETED', { on, name: m.name });
  });
}

export async function logNote(db: Db, n: { on: string; text: string }, now = new Date().toISOString()): Promise<void> {
  assertDate(n.on, now);
  const text = n.text.trim();
  if (text === '') throw new Error('a note cannot be empty');
  if (text.length > 1000) throw new Error('a note is limited to 1,000 characters');
  await audit(db, 'owner_note', n.on, 'NOTE', { on: n.on, text });
}

export interface TimelineEntry {
  key: string; on: string; at: string; kind: string; summary: string;
  /** The `reverseEntry` key; null for entries written before batch A (no `rowId`) or not by the owner's hand. */
  reversible: { entity: ReversalEntity; entityId: string } | null;
  /** IST date and reason of the reversal, when reversed. */
  reversed: { on: string; reason: string } | null;
}

type Payload = Record<string, unknown>;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function describe(entity: string, entityId: string, action: string, p: Payload): { kind: string; summary: string } {
  const money = (v: unknown) => (typeof v === 'string' ? formatInr(BigInt(v) as Paise) : 'unknown amount');
  switch (`${entity}/${action}`) {
    case 'bucket_flow/LOGGED': {
      const amount = BigInt(String(p['amountPaise'] ?? '0'));
      const verb = amount < 0n ? 'Withdrew' : 'Deposited';
      const abs = (amount < 0n ? -amount : amount).toString();
      return { kind: 'Goal', summary: `${verb} ${money(abs)} ${amount < 0n ? 'from' : 'into'} ${entityId}${p['note'] ? ` — ${String(p['note'])}` : ''}` };
    }
    case 'earmark/LOGGED': {
      const end = (side: 'from' | 'to') => `${String(p[`${side}Name`] ?? p[side])}${p[side] === 'SP' && p['label'] ? `: ${String(p['label'])}` : ''}`;
      return { kind: 'Earmark', summary: `Earmarked ${money(p['amountPaise'])} from ${end('from')} to ${end('to')}` };
    }
    case 'spend/LOGGED': {
      const pot = p['label'] && p['label'] !== p['purpose'] ? `: ${String(p['label'])}` : '';
      return { kind: 'Spend', summary: `Spent ${money(p['amountPaise'])} on ${String(p['purpose'] ?? '')} (from ${String(p['fromName'] ?? p['from'])}${pot})` };
    }
    case 'owner_sale/LOGGED': {
      const to = p['destination'] ? `${String(p['destinationName'] ?? p['destination'])}${p['label'] ? `: ${String(p['label'])}` : ''}` : 'bank';
      return { kind: 'Sale', summary: `Sold ${p['units'] ? `${String(p['units'])} ` : ''}${String(p['name'] ?? entityId)} for ${money(p['proceedsPaise'])} → ${to}` };
    }
    case 'owner_sip_payment/RECORDED': return { kind: 'SIP', summary: `Paid a ${money(p['amountPaise'])} SIP instalment` };
    case 'sip_move/LOGGED': {
      const [y, mo] = String(p['firstMonth'] ?? '').split('-');
      const month = y && mo ? `${MONTHS[Number(mo) - 1] ?? mo} ${y}` : 'unknown month';
      return { kind: 'SIP move', summary: `SIP moved: ${String(p['fromName'] ?? '')} → ${String(p['toName'] ?? '')}, ${money(p['amountPaise'])}/month from ${month}` };
    }
    case 'owner_purchase/LOGGED': return { kind: 'Purchase', summary: `Bought ${money(p['amountPaise'])} of ${String(p['description'] ?? '')}` };
    case 'milestone/COMPLETED': return { kind: 'Milestone', summary: `Completed ${String(p['name'] ?? entityId)}` };
    case 'owner_note/NOTE': return { kind: 'Note', summary: String(p['text'] ?? '') };
    case 'bond_redemption/REDEEMED': return { kind: 'Bond', summary: `Bond redeemed: ${entityId}` };
    case 'bond_redemption/AMOUNT_STATED': return { kind: 'Bond', summary: `Redemption amount stated: ${money(p['amountPaise'])}` };
    case 'rsu_vest/CONFIRMED': return { kind: 'RSU', summary: 'Vest confirmed' };
    default: return { kind: entity, summary: `${entity} ${action}` };
  }
}

/** What the owner did, newest first: their own audit rows, never the system's. */
export async function loadOwnerTimeline(db: Db, limit = 100): Promise<TimelineEntry[]> {
  const rows = await db.query<{ id: string; at: string | Date; entity: string; entity_id: string; action: string; payload: unknown }>(
    `select id::text, at, entity, entity_id, action, payload from audit_log
      where actor = 'owner' and entity in ('bucket_flow', 'milestone', 'owner_note', 'bond_redemption', 'rsu_vest', 'owner_purchase',
        'owner_sip_payment', 'earmark', 'spend', 'owner_sale', 'sip_move')
      order by at desc, id desc limit $1`,
    [limit],
  );
  // ponytail: reads every reversal; filter by the page's keys if the table ever grows large.
  const reversals = new Map((await db.query<{ entity: string; entity_id: string; reason: string; as_of: string | Date }>(
    `select entity, entity_id, reason, as_of from log_reversals`))
    .map((x) => [`${x.entity}|${x.entity_id}`, { on: istDate(new Date(x.as_of).toISOString()), reason: x.reason }]));
  return rows.map((r) => {
    const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload ?? {}) as Payload;
    const at = new Date(r.at).toISOString();
    const on = ['on', 'receivedOn', 'paidOn'].map((k) => p[k]).find((v): v is string => typeof v === 'string') ?? at.slice(0, 10);
    const entity = r.entity as ReversalEntity;
    const entityId = GROUPS.has(entity) ? (Array.isArray(p['rowIds']) ? r.id : null) : typeof p['rowId'] === 'string' ? p['rowId'] : null;
    const reversible = entityId !== null && typeof p['source'] === 'string' && p['source'].startsWith('owner-') ? { entity, entityId } : null;
    const reversed = reversible ? reversals.get(`${entity}|${entityId}`) ?? null : null;
    return { key: r.id, on, at, ...describe(r.entity, r.entity_id, r.action, p), reversible, reversed };
  }).sort((a, b) => (a.on === b.on ? b.at.localeCompare(a.at) : b.on.localeCompare(a.on)));
}
