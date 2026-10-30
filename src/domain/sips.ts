/**
 * Live SIP commitment (spec 2026-10-14 §1.4–1.6) and this month's spend and remaining
 * (SIP gaps Task 2). Reads only `sip_snapshots`, `sips`, `settings_rails`, `order_intents`,
 * `order_transitions`, `owner_purchases`, `owner_sip_payments` and `log_reversals`. Must
 * never import buckets.ts or funded-status.ts: the free envelope feeds sizing, and sizing is
 * behind the no-catch-up firewall.
 */
import type { Db } from '../db/client.js';
import type { SipRow } from '../sources/indmoney.js';
import { railPaise } from './rail-values.js';
import { classify, type AssetClass } from './networth.js';
import { formatInr, type Paise } from '../money/paise.js';

export type StepUpKind = 'percent' | 'rupees' | 'unknown';

/**
 * INDmoney's `step_up_by` carries no unit: 1000 meant ₹1,000 and 10 means 10%.
 * ponytail: ≤100 is read as percent, so a genuine ₹100-or-less rupee step-up is misread.
 * Use the unit if INDmoney ever exposes one. Overview shows the guess as "inferred".
 */
export function inferStepUp(raw: number | null): { kind: StepUpKind | null; inferred: boolean } {
  if (raw === null) return { kind: null, inferred: false };
  if (!Number.isFinite(raw) || raw <= 0) return { kind: 'unknown', inferred: false };
  return { kind: raw <= 100 ? 'percent' : 'rupees', inferred: true };
}

export interface ActiveSip {
  sipId: string; instrumentId: string; fundName: string; fundType: string | null; category: string | null;
  amountPaise: bigint; stepUpRaw: number | null; stepUpKind: StepUpKind | null; stepUpInferred: boolean;
  stepUpFreq: string | null; startDate: string; asOf: string;
}

/**
 * A SIP's asset class: INDmoney's own fund type / category first, the name-based `classify`
 * last. By name alone a money-market, overnight, floater or Banking & PSU SIP — or a gold
 * FoF — reads as EQUITY, and EQUITY inflow pushes an equity overweight toward a sale.
 */
const DEBT_CATEGORY =
  /debt|money market|overnight|liquid|ultra short|low duration|short duration|medium duration|long duration|floater|banking (and|&) psu|corporate bond|credit risk|gilt|dynamic bond|arbitrage/i;
export function sipAssetClass(s: Pick<ActiveSip, 'instrumentId' | 'fundName' | 'fundType' | 'category'>): AssetClass {
  if (/\bgold\b/i.test(`${s.category ?? ''} ${s.fundName}`)) return 'GOLD';
  if (/^debt$/i.test(s.fundType ?? '') || DEBT_CATEGORY.test(s.category ?? '')) return 'DEBT';
  return classify('MF', s.instrumentId, s.fundName);
}

/** `startDate`'s anniversary in `year`. A 29 Feb start falls on 28 Feb in a common year. */
function anniversary(year: number, m: number, d: number): string {
  const day = Math.min(d, new Date(Date.UTC(year, m, 0)).getUTCDate());
  return `${year}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * First anniversary of `startDate` (whole years after it, at least one) on or after `asOf`.
 * The candidate year is max(start + 1, asOf's year); if that year's anniversary is already
 * past, the next year's is necessarily after `asOf`. No loop needed.
 */
function nextAnniversary(startDate: string, asOf: string): string {
  const [y, m, d] = startDate.split('-').map(Number) as [number, number, number];
  const day = asOf.slice(0, 10);
  const year = Math.max(y + 1, Number(day.slice(0, 4)));
  const on = anniversary(year, m, d);
  return on >= day ? on : anniversary(year + 1, m, d);
}

/** The next step-up on or after `asOf`, and the amount it steps to. Null fields when unknowable. */
export function nextStepUp(s: ActiveSip, asOf: string): { on: string | null; amountPaise: bigint | null } {
  if (s.stepUpKind === null || s.stepUpFreq !== 'YEARLY') return { on: null, amountPaise: null };
  const on = nextAnniversary(s.startDate, asOf);
  if (s.stepUpKind === 'unknown' || s.stepUpRaw === null) return { on, amountPaise: null };
  // Rupees to paise exactly; rounding to the whole rupee here would invent up to 50 paise.
  if (s.stepUpKind === 'rupees') return { on, amountPaise: s.amountPaise + BigInt(Math.round(s.stepUpRaw * 100)) };
  // Percent as basis points, exact bigint arithmetic, rounded DOWN to the whole rupee.
  const bps = BigInt(Math.round(s.stepUpRaw * 100));
  return { on, amountPaise: ((s.amountPaise * (10_000n + bps)) / 10_000n / 100n) * 100n };
}

export const SIP_MAX_AGE_DAYS = 7;

/**
 * Step-up classification for storage. A SIP flagged as step-up whose `step_up_by` was
 * missing parses to raw null with a frequency: that is 'unknown', not "no step-up".
 */
function stepUpOf(r: SipRow): { kind: StepUpKind | null; inferred: boolean } {
  if (r.stepUpRaw === null && r.stepUpFreq !== null) return { kind: 'unknown', inferred: false };
  return inferStepUp(r.stepUpRaw);
}

/** One snapshot plus its rows, in one transaction. Returns the snapshot id. */
export async function persistSipSnapshot(db: Db, rows: SipRow[], asOf: string): Promise<number> {
  return db.withTransaction(async (tx) => {
    const [snap] = await tx.query<{ id: string | number }>(
      `insert into sip_snapshots (as_of, source, sip_count) values ($1, 'indmoney', $2) returning id`,
      [asOf, rows.length],
    );
    for (const r of rows) {
      const step = stepUpOf(r);
      await tx.query(
        `insert into sips (snapshot_id, sip_id, instrument_id, isin, fund_name, fund_type, category, frequency,
                           amount_paise, step_up_raw, step_up_kind, step_up_inferred, step_up_freq, start_date, as_of, source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'indmoney')`,
        [snap!.id, r.sipId, r.instrumentId, r.isin, r.fundName, r.fundType, r.category, r.frequency,
          r.amountPaise.toString(), r.stepUpRaw, step.kind, step.inferred, r.stepUpFreq, r.startDate, asOf],
      );
    }
    return Number(snap!.id);
  });
}

/** Asia/Kolkata (UTC+5:30, no DST) calendar date `YYYY-MM-DD` of an instant. Throws on an unparseable one. */
export function istDate(iso: string): string {
  return new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(0, 10);
}
/** Asia/Kolkata calendar month `YYYY-MM` of an instant: "this month" everywhere in month money. */
export function istMonth(iso: string): string {
  return istDate(iso).slice(0, 7);
}

/** The instants [start, end) of an IST month `YYYY-MM`, as timestamptz literals. */
function istMonthBounds(month: string): [string, string] {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
  return [`${month}-01T00:00:00+05:30`, `${next}-01T00:00:00+05:30`];
}

export interface OwnerSipPayment {
  instrumentId: string; fundName: string; paidOn: string; amountPaise: bigint; note: string; asOf: string; source: string;
}

/**
 * Canonical/ISIN aliases (an AMFI row and the IND holding row of one fund) share one key.
 * ponytail: one hop only — a reaches b when they share an ISIN or canonical_id directly; a chain
 * a~b (ISIN) and b~c (canonical_id) does not join a and c. Upgrade: a recursive CTE over both
 * links if such chains ever appear in `instruments`.
 */
export async function sipInstrumentKey(db: Db, instrumentId: string): Promise<string> {
  const [row] = await db.query<{ key: string }>(
    `select min(b.id) key from instruments a join instruments b on b.id=a.id
       or (a.canonical_id is not null and b.canonical_id=a.canonical_id)
       or (a.isin is not null and b.isin=a.isin) where a.id=$1`, [instrumentId]);
  return row?.key ?? instrumentId;
}

/** Owner-recorded SIP payments (`owner_sip_payments`) for the IST month of `now`, skipping reversed ones. */
export async function loadOwnerSipPayments(db: Db, now: string): Promise<OwnerSipPayment[]> {
  const rows = await db.query<{ instrument_id: string; fund_name: string; paid_on: string; amount_paise: string; note: string; as_of: string | Date; source: string }>(
    `select p.instrument_id, i.name fund_name, p.paid_on::text, p.amount_paise::text, p.note, p.as_of, p.source
       from owner_sip_payments p join instruments i on i.id = p.instrument_id where p.month = $1
        and not exists (select 1 from log_reversals r where r.entity = 'owner_sip_payment' and r.entity_id = p.id::text) order by p.id`, [istMonth(now)]);
  return rows.map((r) => ({ instrumentId: r.instrument_id, fundName: r.fund_name, paidOn: r.paid_on,
    amountPaise: BigInt(r.amount_paise), note: r.note, asOf: new Date(r.as_of).toISOString(), source: r.source }));
}

export interface SipCommitment {
  totalPaise: bigint | null; asOf: string | null; stale: boolean; sips: ActiveSip[];
  /** Absent from the latest snapshot, but seen this IST month on or after its instalment day: debited, still counted. */
  departedThisMonth: ActiveSip[];
  /** Owner-recorded payments this IST month; `countedPaise` is what the feed does not already cover for that fund. */
  ownerPaidThisMonth: (OwnerSipPayment & { countedPaise: bigint })[];
  /** Why a fresh snapshot's total is still unknown (a non-MONTHLY SIP). */
  unknownReason?: string;
}

export type SipDbRow = {
  sip_id: string; instrument_id: string; fund_name: string; fund_type: string | null; category: string | null;
  amount_paise: string; step_up_raw: string | null; step_up_kind: StepUpKind | null;
  step_up_inferred: boolean; step_up_freq: string | null; start_date: string; frequency: string;
};
// ::text on amount, raw and date: bigint and numeric exactly, and a `date` never shifted
// by a driver's local-midnight Date.
export const SIP_COLS = `x.sip_id, x.instrument_id, x.fund_name, x.fund_type, x.category, x.frequency, x.amount_paise::text,
  x.step_up_raw::text, x.step_up_kind, x.step_up_inferred, x.step_up_freq, x.start_date::text`;
export const toSip = (r: SipDbRow, asOf: string): ActiveSip => ({
  sipId: r.sip_id, instrumentId: r.instrument_id, fundName: r.fund_name, fundType: r.fund_type, category: r.category,
  amountPaise: BigInt(r.amount_paise), stepUpRaw: r.step_up_raw === null ? null : Number(r.step_up_raw),
  stepUpKind: r.step_up_kind, stepUpInferred: r.step_up_inferred, stepUpFreq: r.step_up_freq,
  startDate: r.start_date, asOf,
});

/**
 * SIPs absent from the latest snapshot but seen earlier this IST month. Each is read from the
 * latest snapshot that contained it; it counts only if that snapshot's IST date is on or after
 * its instalment day this month (start_date's day, clamped to the month) — seen before it and
 * then gone means it was never debited. Reads only this month's snapshots.
 */
async function departedThisMonth(db: Db, latestId: string | number, nowIso: string): Promise<{ sips: ActiveSip[]; odd: SipDbRow[] }> {
  if (Number.isNaN(Date.parse(nowIso))) return { sips: [], odd: [] }; // stale anyway; nothing to place in a month
  const month = istMonth(nowIso);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const rows = await db.query<SipDbRow & { snap_as_of: string | Date }>(
    `select distinct on (x.sip_id) ${SIP_COLS}, s.as_of as snap_as_of
       from sips x join sip_snapshots s on s.id = x.snapshot_id
      where s.as_of >= $2::timestamptz and s.as_of < $3::timestamptz and s.id <> $1
        and x.sip_id not in (select sip_id from sips where snapshot_id = $1)
      order by x.sip_id, s.as_of desc, s.id desc`,
    [latestId, ...istMonthBounds(month)],
  );
  const sips: ActiveSip[] = [];
  const odd: SipDbRow[] = [];
  for (const r of rows) {
    // Any non-MONTHLY SIP seen this month makes the total unknown: no instalment day to test.
    if (r.frequency !== 'MONTHLY') { odd.push(r); continue; }
    const seen = new Date(r.snap_as_of).toISOString();
    if (istDate(seen) >= anniversary(y, m, Number(r.start_date.slice(8, 10)))) sips.push(toSip(r, seen));
  }
  return { sips, odd };
}

/**
 * The latest snapshot is the active set, plus SIPs stopped this month after their instalment
 * (`departedThisMonth`). No snapshot: unknown (null), never zero. A snapshot older than
 * SIP_MAX_AGE_DAYS at the wall-clock `nowIso` keeps its rows for display but its total is
 * unknown. So does any non-MONTHLY SIP: its amount is not a monthly figure, and no conversion
 * is guessed.
 */
export async function loadSipCommitment(db: Db, nowIso: string): Promise<SipCommitment> {
  const [snap] = await db.query<{ id: string | number; as_of: string | Date }>(
    `select id, as_of from sip_snapshots order by as_of desc, id desc limit 1`);
  const ownerPaidThisMonth = (Number.isFinite(Date.parse(nowIso)) ? await loadOwnerSipPayments(db, nowIso) : [])
    .map((p) => ({ ...p, countedPaise: 0n }));
  if (!snap) return { totalPaise: null, asOf: null, stale: true, sips: [], departedThisMonth: [], ownerPaidThisMonth };
  const rows = await db.query<SipDbRow>(
    `select ${SIP_COLS} from sips x where x.snapshot_id = $1 order by x.amount_paise desc, x.sip_id`,
    [snap.id],
  );
  const asOf = new Date(snap.as_of).toISOString();
  // Fails closed: an unparseable clock gives NaN, and NaN reads stale, never fresh.
  const stale = !(Date.parse(nowIso) - Date.parse(asOf) <= SIP_MAX_AGE_DAYS * 86_400_000);
  const sips = rows.map((r) => toSip(r, asOf));
  const departed = await departedThisMonth(db, snap.id, nowIso);
  const odd = [...rows.filter((r) => r.frequency !== 'MONTHLY'), ...departed.odd].map((r) => `${r.fund_name} (${r.frequency})`);
  // Per fund (aliases joined by sipInstrumentKey): the feed's amount, topped up to an owner-recorded
  // monthly total only by what the feed does not already carry — never counted on top of it.
  // No owner payment (the usual month): the plain feed sum, with no per-SIP alias queries.
  const amounts = new Map<string, bigint>();
  if (ownerPaidThisMonth.length === 0) amounts.set('', [...sips, ...departed.sips].reduce((s, x) => s + x.amountPaise, 0n));
  else for (const s of [...sips, ...departed.sips]) {
    const key = await sipInstrumentKey(db, s.instrumentId);
    amounts.set(key, (amounts.get(key) ?? 0n) + s.amountPaise);
  }
  for (const p of ownerPaidThisMonth) {
    const key = await sipInstrumentKey(db, p.instrumentId);
    const covered = amounts.get(key) ?? 0n;
    p.countedPaise = p.amountPaise > covered ? p.amountPaise - covered : 0n;
    amounts.set(key, covered + p.countedPaise);
  }
  const base = { asOf, stale, sips, departedThisMonth: departed.sips, ownerPaidThisMonth };
  if (odd.length > 0) {
    return { ...base, totalPaise: null,
      unknownReason: `SIP commitment unknown: non-MONTHLY SIP ${odd.join(', ')} — its monthly amount is not known` };
  }
  return { ...base, totalPaise: stale ? null : [...amounts.values()].reduce((sum, amount) => sum + amount, 0n) };
}

/**
 * Orders that no longer represent deployed or committed money. Everything else — a draft, a
 * pending approval, a filled order — has the budget spoken for.
 */
export const RELEASED_STATUSES = ['REJECTED', 'EXPIRED', 'CANCELLED', 'BROKER_REJECTED', 'ABANDONED'];

/**
 * SQL over an `order_intents o`: its amount is the latest revision's quantity (a modify writes
 * `order_revisions`, never `order_intents`; `createOrder` writes paise into `quantity`).
 */
export const ORDER_PAISE_SQL = `coalesce((
              select r.quantity from order_revisions r
               where r.order_intent_id = o.id order by r.revision_number desc limit 1
            ), o.quantity)`;

/**
 * SQL over an `order_intents o`: true unless its latest status is in the text[] param `$n`
 * (pass RELEASED_STATUSES). The tie-break (`t.id`) matches `getCurrentStatus` in orders.ts.
 */
export const orderHeldSql = (n: number) => `coalesce((
              select t.to_status from order_transitions t
               where t.order_intent_id = o.id order by t.at desc, t.id desc limit 1
            ), 'DRAFT') <> all($${n}::text[])`;

/** SQL: `col` names a lump sum that is not reversed (batch B §3). Its spending is not the month's. */
export const liveLumpSql = (col: string) =>
  `(${col} is not null and not exists (select 1 from log_reversals x where x.entity = 'lump_sum' and x.entity_id = ${col}::text))`;

export interface MonthSpend { ordersPaise: bigint; ownerPaise: bigint; totalPaise: bigint }

/**
 * What this IST month has already deployed: Sentinel BUY orders (by `order_intents.as_of`)
 * plus purchases the owner logged outside Sentinel (by `bought_on`). A sum of rows, so always
 * known; 0n when there are none.
 *
 * Orders: `createOrder` writes `primary.amountPaise` into `quantity`. Only BUY-shaped intents
 * count — FR-12 caps deployment, and a SELL or REDEEM returns money. Released orders
 * (rejected, expired, …) deployed nothing. SIP instalments are NOT spend: they are already
 * inside the SIP commitment, and counting them here would count them twice.
 *
 * NOT implemented: FR-12's "confirmed-vest-month redeployment allowance". The PRD states it
 * exists but not its size; under-counting it makes the gate stricter, the safe direction. It
 * is on the owner true-up list.
 */
export async function loadMonthSpend(db: Db, nowIso: string, excludeOrderIntentId?: string): Promise<MonthSpend> {
  const month = istMonth(nowIso); // throws on an unparseable clock: fail closed, never 0
  const [from, to] = istMonthBounds(month);
  // `excludeOrderIntentId` leaves out the order being re-gated, so a modify or resurface is
  // measured once, at its new amount, not on top of itself. Spending from an open lump sum
  // (a linked purchase, an order on a lump-sum recommendation) is the lump sum's, not the month's.
  const [o] = await db.query<{ total: string }>(
    `select coalesce(sum(${ORDER_PAISE_SQL}), 0)::text as total
       from order_intents o join recommendations rec on rec.id = o.recommendation_id
      where o.intent = 'BUY'
        and o.as_of >= $1::timestamptz and o.as_of < $2::timestamptz
        and ($4::uuid is null or o.id <> $4::uuid)
        and ${orderHeldSql(3)}
        and not ${liveLumpSql('rec.lump_sum_id')}`,
    [from, to, RELEASED_STATUSES, excludeOrderIntentId ?? null],
  );
  const [p] = await db.query<{ total: string }>(
    `select coalesce(sum(amount_paise), 0)::text as total from owner_purchases p
      where bought_on >= $1::date and bought_on < ($1::date + interval '1 month')
        and not exists (select 1 from log_reversals r where r.entity = 'owner_purchase' and r.entity_id = p.id::text)
        and not ${liveLumpSql('p.lump_sum_id')}`,
    [`${month}-01`],
  );
  // `sum` of a numeric column is a decimal string; money is whole paise.
  const ordersPaise = BigInt(o!.total.split('.')[0]!);
  const ownerPaise = BigInt(p!.total);
  return { ordersPaise, ownerPaise, totalPaise: ordersPaise + ownerPaise };
}

export interface FreeEnvelope {
  envelopePaise: bigint | null; budgetPaise: bigint; tacticalPaise: bigint;
  sipTotalPaise: bigint | null; sipAsOf: string | null;
  /** `goal_setaside_monthly_paise`: budget reserved for house and emergency. The normal plan never invests it. */
  setAsidePaise: bigint;
  /** This IST month's spend (Sentinel BUY orders + owner-logged purchases). Always known. */
  spentPaise: bigint;
  /** max(0, envelope − spent): what is still free to invest. Null iff envelopePaise is null. */
  remainingPaise: bigint | null;
  /** Set whenever envelopePaise or remainingPaise is null or 0: why nothing can be deployed. */
  reason: string | null;
}

/**
 * What may be deployed this month: max(0, min(tactical rail, budget − live SIPs − goal set-aside)), and what
 * remains of it after this month's spend. An unknown SIP total makes the envelope and the
 * remaining amount unknown — never the full budget.
 */
export async function loadFreeEnvelope(db: Db, nowIso: string, excludeOrderIntentId?: string): Promise<FreeEnvelope> {
  const budgetPaise = await railPaise(db, 'monthly_budget_paise');
  const tacticalPaise = await railPaise(db, 'tactical_monthly_paise');
  const setAsidePaise = await railPaise(db, 'goal_setaside_monthly_paise');
  const c = await loadSipCommitment(db, nowIso);
  const spentPaise = (await loadMonthSpend(db, nowIso, excludeOrderIntentId)).totalPaise;
  const env = envelopeOf(budgetPaise, tacticalPaise, setAsidePaise, c);
  const base = { budgetPaise, tacticalPaise, sipTotalPaise: c.totalPaise, sipAsOf: c.asOf, setAsidePaise, spentPaise, ...env };
  if (env.envelopePaise === null) return { ...base, remainingPaise: null };
  const left = env.envelopePaise - spentPaise;
  if (env.envelopePaise > 0n && left <= 0n) {
    return { ...base, remainingPaise: 0n,
      reason: `this month's budget is already deployed (${formatInr(spentPaise as Paise)} spent)` };
  }
  return { ...base, remainingPaise: left > 0n ? left : 0n };
}

/** Why a commitment's total is unknown (`totalPaise === null`). */
export function sipUnknownReason(c: SipCommitment): string {
  return c.asOf === null
    ? 'SIP commitment unknown: INDmoney SIPs have never synced (indmoney-sips)'
    : c.stale ? `SIP commitment unknown: last SIP sync ${c.asOf.slice(0, 10)} is older than ${SIP_MAX_AGE_DAYS} days (indmoney-sips)`
    : c.unknownReason ?? 'SIP commitment unknown';
}

function envelopeOf(budgetPaise: bigint, tacticalPaise: bigint, setAsidePaise: bigint, c: SipCommitment): { envelopePaise: bigint | null; reason: string | null } {
  if (c.totalPaise === null) return { envelopePaise: null, reason: sipUnknownReason(c) };
  if (budgetPaise <= 0n) return { envelopePaise: 0n, reason: 'the monthly budget is set to ₹0' };
  const free = budgetPaise - c.totalPaise;
  if (free <= 0n) return { envelopePaise: 0n, reason: 'SIPs already use the whole budget' };
  const investable = free - setAsidePaise;
  if (investable <= 0n) {
    return { envelopePaise: 0n, reason: `the goal set-aside (${formatInr(setAsidePaise as Paise)} for house and emergency) uses the rest of the budget` };
  }
  const envelopePaise = investable < tacticalPaise ? investable : tacticalPaise;
  if (envelopePaise <= 0n) return { envelopePaise: 0n, reason: 'the tactical rail allows nothing this month' };
  return { envelopePaise, reason: null };
}
