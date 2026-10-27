import type { Db } from '../db/client.js';
import { ASSUMPTIONS } from '../config/assumptions.js';
import { CAPS } from './allocation.js';
import { loadMfMetadata } from './mf-metadata.js';
import { heldFunds } from './mf-ranking.js';
import { evaluateSwitches } from './mf-switch.js';
import { loadPositions, type Position } from './networth.js';
import { FUND_TYPE_LABEL, byGap, midBps, type FundBuy, type FundCandidates, type FundType, type RangeRow } from './fund-types.js';

export { FUND_TYPE_LABEL, byGap, midBps, type FundBuy, type FundCandidates, type FundType, type RangeRow };

/**
 * Spec §7 (funds-first): the fund mix review — fund types, the owner-approved range
 * table, the proposal for the current horizon, and the actual mix of equity funds.
 *
 * Goal-blind by construction: the horizon is FI year (`ownerBirthYear + fiTargetAge`)
 * from ASSUMPTIONS, never the goal tracker or funded status.
 */

export type Band = '15+' | '7-15';

export const CORE_TYPES = ['NIFTY50', 'NEXT50', 'FLEXI', 'US'] as const;
export const NON_CORE_TYPES = ['LARGE_ACTIVE', 'MID', 'SMALL'] as const;
const ALL_TYPES: FundType[] = ['NIFTY50', 'NEXT50', 'FLEXI', 'LARGE_ACTIVE', 'MID', 'SMALL', 'US'];

export interface FundTyping { type: FundType; topUp: boolean }

/**
 * Keyed by ISIN, the scheme identity shared by the seed, INDmoney and AMFI. Every ISIN
 * here was confirmed present on a production instrument on 2026-10-26.
 * LARGE_ACTIVE keeps topUp true: its range row's `newMoney: false` already blocks new money.
 */
export const FUND_TYPE_BY_ISIN: Record<string, FundTyping> = {
  INF109K012M7: { type: 'NIFTY50', topUp: true },       // ICICI Pru Nifty 50 Index Direct
  INF732E01037: { type: 'NIFTY50', topUp: true },       // Nippon Nifty BeES
  INF879O01027: { type: 'FLEXI', topUp: true },         // Parag Parikh Flexi Cap Direct
  INF109K016L0: { type: 'LARGE_ACTIVE', topUp: true },  // ICICI Pru Large Cap Direct
  INF179K01XQ0: { type: 'MID', topUp: true },           // HDFC Mid Cap Direct
  INF247L01445: { type: 'MID', topUp: true },           // Motilal Oswal Midcap Direct
  INF194KB1AL4: { type: 'SMALL', topUp: true },         // Bandhan Small Cap Direct
  INF732E01045: { type: 'NEXT50', topUp: false },       // Junior BeES — §8: kept, not topped up
};

/**
 * Fallback for held funds with no ISIN anywhere — consulted only when neither the
 * instrument nor any canonical sibling carries one.
 */
const FUND_TYPE_BY_ID: Record<string, FundTyping> = {
  // Live Junior BeES: INDmoney gives no ISIN and no canonical link to NSE:JUNIORBEES.
  'IND:INDS20619': { type: 'NEXT50', topUp: false },
  // Vanguard S&P 500 is US-listed and has no Indian ISIN; INDmoney reports it under two
  // ids. §8: kept, not topped up — the US SIP goes to a new index mutual fund.
  'IND:VOO': { type: 'US', topUp: false },
  'IND:118951': { type: 'US', topUp: false },
};

/** Spec §7 reasons, verbatim. */
const REASON: Record<FundType, string> = {
  NIFTY50: 'low-cost core; the anchor',
  NEXT50: 'next 50 largest, cheap',
  FLEXI: 'manager can go mid and abroad',
  LARGE_ACTIVE: 'overlaps the Nifty 50 index; held, never topped up',
  MID: 'long horizon can sit through deeper falls',
  SMALL: 'same, deeper falls still',
  US: 'country diversification (IPS §3.4 core)',
};

/** [min%, max%] per type, spec §7, owner-approved 2026-10-23. */
const row = (type: FundType, min: number, max: number): RangeRow =>
  ({ type, minBps: min * 100, maxBps: max * 100, newMoney: type !== 'LARGE_ACTIVE', reason: REASON[type] });

export const RANGE_TABLE: Record<Band, RangeRow[]> = {
  '15+': [
    row('NIFTY50', 35, 50), row('NEXT50', 0, 10), row('FLEXI', 15, 25), row('LARGE_ACTIVE', 0, 0),
    row('MID', 10, 20), row('SMALL', 5, 10), row('US', 5, 10),
  ],
  '7-15': [
    row('NIFTY50', 50, 65), row('NEXT50', 0, 5), row('FLEXI', 10, 20), row('LARGE_ACTIVE', 0, 0),
    row('MID', 5, 10), row('SMALL', 0, 5), row('US', 5, 10),
  ],
};

/** FI year minus the current Asia/Kolkata calendar year. */
export function horizonYears(nowIso: string): number {
  const istYear = new Date(Date.parse(nowIso) + 330 * 60_000).getUTCFullYear();
  return ASSUMPTIONS.ownerBirthYear + ASSUMPTIONS.fiTargetAge - istYear;
}

export function bandFor(years: number): Band | null {
  if (years >= 15) return '15+';
  if (years >= 7) return '7-15';
  return null;
}

export function proposeMix(nowIso: string):
  | { horizonYears: number; band: Band; ranges: RangeRow[] }
  | { horizonYears: number; band: null; reason: string } {
  const years = horizonYears(nowIso);
  const band = bandFor(years);
  if (band === null) {
    return { horizonYears: years, band: null, reason: 'the range table has no row under 7 years — owner decision needed' };
  }
  return { horizonYears: years, band, ranges: RANGE_TABLE[band] };
}

export interface SignedMix { id: number; asOf: string; band: Band; horizonYears: number; ranges: RangeRow[] }

/**
 * Decision 3: the owner signs the current proposal whole. The band in the request is what
 * the page showed; if the proposal has moved since, the signature is refused.
 */
export async function approveMix(db: Db, req: { band: Band }, nowIso: string): Promise<{ id: number }> {
  const p = proposeMix(nowIso);
  if (p.band === null) throw new Error(p.reason);
  if (req.band !== p.band) throw new Error('the proposal changed — reload /funds');
  return db.withTransaction(async (tx) => {
    // Objects, never JSON.stringify: postgres-js would store a jsonb string. A bare array of
    // objects would also serialise to jsonb (the server declares $3's type); the {ranges}
    // wrapper is harmless, not required.
    const [r] = await tx.query<{ id: number | string }>(
      `insert into fund_mix_signed (horizon_years, horizon_band, ranges, as_of, source)
       values ($1, $2, ($3::jsonb)->'ranges', $4, 'owner-signed') returning id`,
      [p.horizonYears, p.band, { ranges: p.ranges }, nowIso],
    );
    const id = Number(r!.id);
    await tx.query(
      `insert into audit_log (entity, entity_id, action, actor, payload)
       values ('fund_mix', $1, 'SIGNED', 'owner', $2::jsonb)`,
      [String(id), { rowId: id, band: p.band, horizonYears: p.horizonYears }],
    );
    return { id };
  });
}

/** The signing in force: the latest row. */
export async function loadSignedMix(db: Db): Promise<SignedMix | null> {
  const [r] = await db.query<{ id: number | string; as_of: string; horizon_band: Band; horizon_years: number; ranges: RangeRow[] | string }>(
    `select id, to_char(as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as_of, horizon_band, horizon_years, ranges
       from fund_mix_signed order by id desc limit 1`,
  );
  if (!r) return null;
  return {
    id: Number(r.id), asOf: r.as_of, band: r.horizon_band, horizonYears: Number(r.horizon_years),
    // Robust to a jsonb string (a stringified write on postgres-js); none is written here.
    ranges: typeof r.ranges === 'string' ? JSON.parse(r.ranges) as RangeRow[] : r.ranges,
  };
}

const YEAR_MS = 365 * 86_400_000;

/**
 * A signable proposal is "new" when its band differs from the signed one, or the signing
 * is 365 days old or more. Nothing signed yet: this is the first proposal, not a new one.
 * No proposal (under 7 years): nothing to sign, and the page shows the reason instead.
 */
export function newProposalReady(
  signed: SignedMix | null, proposal: ReturnType<typeof proposeMix>, nowIso: string,
): boolean {
  if (signed === null || proposal.band === null) return false;
  return proposal.band !== signed.band || Date.parse(nowIso) - Date.parse(signed.asOf) >= YEAR_MS;
}

/** Midpoints scaled to sum to exactly 10 000 bps; each is floored and the remainder goes to NIFTY50. */
export function normalisedMidpointsBps(ranges: RangeRow[]): Record<FundType, number> {
  const total = ranges.reduce((s, r) => s + midBps(r), 0);
  const out = Object.fromEntries(ALL_TYPES.map((t) => [t, 0])) as Record<FundType, number>;
  if (total === 0) return out;
  for (const r of ranges) out[r.type] = Math.floor((midBps(r) * 10_000) / total);
  out.NIFTY50 += 10_000 - Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}

export interface SipSuggestion {
  fundType: FundType | null; instrumentId: string | null; fundName: string;
  currentPaise: bigint; suggestedPaise: bigint; reason: string;
}

export interface SipInput { instrumentId: string; fundName: string; type: FundType | null; topUp: boolean; amountPaise: bigint }

const ROUND_PAISE = 10_000n; // ₹100
const NON_CORE_CAP_BPS = 3_000n;
/** A type with no held top-uppable fund. US and Next 50 are named from the index fund chooser. */
const newFundLabel = (t: FundType, names: Partial<Record<FundType, string>>): string =>
  names[t] ?? (t === 'US' || t === 'NEXT50' ? 'no eligible fund open — see below' : `no held ${FUND_TYPE_LABEL[t]} fund can take new money`);

/**
 * Decision 10: the typed SIP total re-split toward the signed mix. Never a sale: every
 * amount is ≥ ₹0 and the total is unchanged. Untyped SIPs keep their amount.
 * Weights: mid + max(0, mid − actual) bps, 0 for a no-new-money type; non-core (MID, SMALL,
 * LARGE_ACTIVE) capped at 30% with core scaled up. Within a type: pro rata to its top-uppable
 * SIPs, else the largest held top-uppable fund, else a new-fund row. Each row is floored to
 * ₹100; the remainder goes to the largest Nifty 50 row (the anchor).
 */
export function suggestSips(i: {
  sips: SipInput[]; ranges: RangeRow[]; actualBps: Record<FundType, number>;
  heldByType: Record<FundType, { instrumentId: string; name: string; valuePaise: bigint; topUp: boolean }[]>;
  /** The new fund to open per type, e.g. `chooseIndexFund(...).top.name` for US and NEXT50. */
  newFundNames?: Partial<Record<FundType, string>>;
}): SipSuggestion[] {
  const typed = i.sips.filter((s) => s.type !== null);
  const total = typed.reduce((a, s) => a + s.amountPaise, 0n);
  const range = new Map(i.ranges.map((r) => [r.type, r]));
  const weight = (t: FundType): bigint => {
    const r = range.get(t);
    return r === undefined || !r.newMoney ? 0n : BigInt(midBps(r) + Math.max(0, midBps(r) - i.actualBps[t]));
  };
  const isNonCore = (t: FundType) => (NON_CORE_TYPES as readonly FundType[]).includes(t);
  const all = ALL_TYPES.reduce((a, t) => a + weight(t), 0n);
  const nonCore = ALL_TYPES.filter(isNonCore).reduce((a, t) => a + weight(t), 0n);
  const capped = nonCore * 10_000n > all * NON_CORE_CAP_BPS;
  const typePaise = (t: FundType): bigint => {
    if (!capped) return (total * weight(t)) / all;
    return isNonCore(t)
      ? (total * NON_CORE_CAP_BPS * weight(t)) / (10_000n * nonCore)
      : (total * (10_000n - NON_CORE_CAP_BPS) * weight(t)) / (10_000n * (all - nonCore));
  };

  const rows: SipSuggestion[] = [];
  let anchor: SipSuggestion | null = null;
  for (const t of ALL_TYPES) {
    const mine = typed.filter((s) => s.type === t);
    if (weight(t) === 0n) {
      for (const s of mine) rows.push({ fundType: t, instrumentId: s.instrumentId, fundName: s.fundName, currentPaise: s.amountPaise, suggestedPaise: 0n, reason: '0% new money — held, never topped up' });
      continue;
    }
    for (const s of mine.filter((x) => !x.topUp)) {
      rows.push({ fundType: t, instrumentId: s.instrumentId, fundName: s.fundName, currentPaise: s.amountPaise, suggestedPaise: 0n, reason: 'kept, not topped up' });
    }
    const amount = typePaise(t);
    let to: { instrumentId: string | null; fundName: string; amountPaise: bigint }[] = mine.filter((x) => x.topUp);
    if (to.length === 0) {
      if (amount === 0n) continue;
      const held = i.heldByType[t].filter((h) => h.topUp).sort((a, b) => (b.valuePaise > a.valuePaise ? 1 : b.valuePaise < a.valuePaise ? -1 : 0))[0];
      to = [held ? { instrumentId: held.instrumentId, fundName: held.name, amountPaise: 0n } : { instrumentId: null, fundName: newFundLabel(t, i.newFundNames ?? {}), amountPaise: 0n }];
    }
    const current = to.reduce((a, s) => a + s.amountPaise, 0n);
    const r = range.get(t)!;
    const why = `${bpsText(Number((amount * 10_000n) / (total || 1n)))} of SIPs to ${FUND_TYPE_LABEL[t]} `
      + `(midpoint ${bpsText(midBps(r))}, actual ${bpsText(i.actualBps[t])}${capped && isNonCore(t) ? '; non-core capped at 30%' : ''})`;
    for (const s of to) {
      const share = current === 0n ? amount : (amount * s.amountPaise) / current;
      const row: SipSuggestion = { fundType: t, instrumentId: s.instrumentId, fundName: s.fundName, currentPaise: s.amountPaise, suggestedPaise: (share / ROUND_PAISE) * ROUND_PAISE, reason: why };
      rows.push(row);
      if (t === 'NIFTY50' && (anchor === null || row.currentPaise > anchor.currentPaise)) anchor = row;
    }
  }
  if (anchor !== null) {
    anchor.suggestedPaise += total - rows.reduce((a, r) => a + r.suggestedPaise, 0n);
    anchor.reason += '; takes the ₹100 rounding remainder';
  }
  for (const s of i.sips.filter((x) => x.type === null)) {
    rows.push({ fundType: null, instrumentId: s.instrumentId, fundName: s.fundName, currentPaise: s.amountPaise, suggestedPaise: s.amountPaise, reason: 'type unknown — kept as is' });
  }
  return rows;
}

/**
 * The ISIN comes from the instrument or any instrument sharing its canonical_id. In
 * production only the seed siblings (MF:*, NSE:*) carry an ISIN; the live IND:* rows
 * and the canonical ids themselves do not.
 */
export async function typeOf(db: Db, instrumentId: string): Promise<FundTyping | null> {
  const [r] = await db.query<{ isin: string | null; sibling_isin: string | null }>(
    `select i.isin,
            (select s.isin from instruments s
              where s.canonical_id = i.canonical_id and s.isin is not null
              order by s.id limit 1) as sibling_isin
       from instruments i where i.id = $1`,
    [instrumentId],
  );
  const isin = r?.isin ?? r?.sibling_isin ?? null;
  if (isin !== null) return FUND_TYPE_BY_ISIN[isin] ?? null;
  return FUND_TYPE_BY_ID[instrumentId] ?? null;
}

export interface ActualMix {
  totalPaise: bigint;
  byType: Record<FundType, {
    valuePaise: bigint;
    shareBps: number;
    holdings: { instrumentId: string; name: string; kind: string; valuePaise: bigint; topUp: boolean }[];
  }>;
  untyped: { instrumentId: string; name: string; valuePaise: bigint }[];
}

const isEquityFund = (p: Position) => p.assetClass === 'EQUITY' && (p.kind === 'MF' || p.kind === 'ETF');

/** Equity funds merged per instrument (a fund held in two accounts is one holding). */
function fundsOf(positions: Position[]): Map<string, { name: string; kind: string; valuePaise: bigint }> {
  const out = new Map<string, { name: string; kind: string; valuePaise: bigint }>();
  for (const p of positions.filter(isEquityFund)) {
    const f = out.get(p.instrumentId);
    if (f) f.valuePaise += p.valuePaise;
    else out.set(p.instrumentId, { name: p.name, kind: p.kind, valuePaise: p.valuePaise });
  }
  return out;
}

async function mixOf(db: Db, positions: Position[]): Promise<ActualMix> {
  const byType = Object.fromEntries(
    ALL_TYPES.map((t) => [t, { valuePaise: 0n, shareBps: 0, holdings: [] }]),
  ) as unknown as ActualMix['byType'];
  const untyped: ActualMix['untyped'] = [];
  let totalPaise = 0n;
  for (const [instrumentId, f] of fundsOf(positions)) {
    totalPaise += f.valuePaise;
    const t = await typeOf(db, instrumentId);
    if (t === null) {
      untyped.push({ instrumentId, name: f.name, valuePaise: f.valuePaise });
      continue;
    }
    byType[t.type].valuePaise += f.valuePaise;
    byType[t.type].holdings.push({ instrumentId, name: f.name, kind: f.kind, valuePaise: f.valuePaise, topUp: t.topUp });
  }
  // Floored bps. A zero total leaves every share 0, which the page renders as "unknown".
  if (totalPaise > 0n) {
    for (const t of ALL_TYPES) byType[t].shareBps = Number((byType[t].valuePaise * 10_000n) / totalPaise);
  }
  return { totalPaise, byType, untyped };
}

export async function loadActualMix(db: Db): Promise<ActualMix> {
  return mixOf(db, await loadPositions(db));
}

export interface Finding { kind: 'overlap' | 'cost' | 'scheme_cap'; text: string; instrumentId: string | null }

const ACTIVE_TYPES = new Set<FundType>(['FLEXI', 'LARGE_ACTIVE', 'MID', 'SMALL']);
const MIN_COST_PEERS = 5;
const pctText = (bps: number) => `${(bps / 100).toFixed(2)}%`;

export async function loadFindings(db: Db): Promise<Finding[]> {
  const positions = await loadPositions(db);
  const mix = await mixOf(db, positions);
  const out: Finding[] = [];

  // Overlap: an active large-cap fund mostly owns the Nifty 50 the index fund already holds.
  if (mix.byType.NIFTY50.valuePaise > 0n) {
    for (const h of mix.byType.LARGE_ACTIVE.holdings) {
      out.push({ kind: 'overlap', instrumentId: h.instrumentId,
        text: `${h.name} overlaps the Nifty 50 index you already hold; held, never topped up` });
    }
  }

  // Cost: a held active fund against the median expense ratio of its AMFI-category peers
  // in the universe (MFU:* rows priced by `enrichUniverse`).
  const active = new Set(ALL_TYPES.filter((t) => ACTIVE_TYPES.has(t))
    .flatMap((t) => mix.byType[t].holdings.map((h) => h.instrumentId)));
  const held = (await heldFunds(db, positions)).filter((h) => active.has(h.instrumentId));
  if (held.length > 0) {
    const metadata = await loadMfMetadata(db);
    const canon = new Map((await db.query<{ id: string; canonical_id: string | null }>(
      `select id, canonical_id from instruments where id = any($1::text[])`, [held.map((h) => h.instrumentId)],
    )).map((r) => [r.id, r.canonical_id]));
    const peerBps = new Map<string, number[]>();
    // Iterate by key: the map also files each row under its canonical id.
    for (const [key, m] of metadata) {
      if (key !== m.instrumentId || !key.startsWith('MFU:') || m.category === null || m.expenseRatioBps === null) continue;
      peerBps.set(m.category, [...(peerBps.get(m.category) ?? []), m.expenseRatioBps]);
    }
    for (const h of held) {
      const c = canon.get(h.instrumentId) ?? null;
      const own = (metadata.get(h.instrumentId) ?? (c === null ? undefined : metadata.get(c))
        ?? metadata.get(h.navInstrumentId))?.expenseRatioBps ?? null;
      const peers = h.category === null ? [] : (peerBps.get(h.category) ?? []);
      if (peers.length < MIN_COST_PEERS) {
        out.push({ kind: 'cost', instrumentId: h.instrumentId, text: `cost not compared: ${peers.length} peers` });
        continue;
      }
      if (own === null) {
        out.push({ kind: 'cost', instrumentId: h.instrumentId, text: 'cost not compared: expense ratio unknown' });
        continue;
      }
      const s = [...peers].sort((a, b) => a - b);
      const lo = s[(s.length - 1) >> 1]!;
      const hi = s[s.length >> 1]!;
      // own > (lo + hi) / 2, in integers.
      if (own * 2 > lo + hi) {
        out.push({ kind: 'cost', instrumentId: h.instrumentId,
          text: `${h.name} costs ${pctText(own)} a year against a ${h.category} median of ${pctText((lo + hi) / 2)} (${s.length} peers)` });
      }
    }
  }

  // Scheme cap (IPS §3.5): one fund above 35% of the whole loadPositions total.
  const portfolio = positions.reduce((s, p) => s + p.valuePaise, 0n);
  const capBps = BigInt(Math.round(CAPS.singleMfScheme * 10_000));
  for (const [instrumentId, f] of fundsOf(positions)) {
    if (f.valuePaise * 10_000n > portfolio * capBps) {
      out.push({ kind: 'scheme_cap', instrumentId,
        text: `${f.name} is ${pctText(Number((f.valuePaise * 10_000n) / portfolio))} of the portfolio, above the ${pctText(Number(capBps))} single-scheme cap` });
    }
  }
  return out;
}

const bpsText = (bps: number) => `${bps / 100}%`;

/**
 * Decisions 7–9: the held funds this month's money may go to, in the order the sizer tries
 * them (largest type gap, then larger holding, then id). Against the signed mix only.
 * Midpoints are the raw range midpoints, as /funds shows them: they sum to 97.5%, so every
 * type can sit at or above its midpoint at once — normalised ones sum to 100% and would
 * hold stocks back forever. Never a sale: an overweight type simply gets no candidate.
 */
export async function loadFundCandidates(db: Db, asOf: string): Promise<FundCandidates> {
  const signed = await loadSignedMix(db);
  if (signed === null) return { approved: false, buys: [], typesBelowMidpoint: [], excluded: [] };
  const mix = await loadActualMix(db);
  const range = new Map(signed.ranges.map((r) => [r.type, r]));
  const below = (t: FundType) => {
    const r = range.get(t);
    return r !== undefined && r.newMoney && mix.byType[t].shareBps < midBps(r);
  };
  const typesBelowMidpoint = signed.ranges.map((r) => r.type).filter(below);

  const excluded: FundCandidates['excluded'] = mix.untyped.map((u) => ({ instrumentId: u.instrumentId, name: u.name, reason: 'type unknown' }));
  const buys: FundBuy[] = [];
  let switches: Awaited<ReturnType<typeof evaluateSwitches>> | null = null;
  for (const t of ALL_TYPES) {
    const r = range.get(t);
    const actualBps = mix.byType[t].shareBps;
    for (const h of mix.byType[t].holdings) {
      const out = (reason: string) => excluded.push({ instrumentId: h.instrumentId, name: h.name, reason });
      if (r === undefined || !r.newMoney) { out('0% new money'); continue; }
      if (!h.topUp) { out('kept, not topped up'); continue; }
      if (!below(t)) { out(`at or above midpoint (${bpsText(actualBps)} vs ${bpsText(midBps(r))})`); continue; }
      let quality: string;
      if (!ACTIVE_TYPES.has(t) || h.kind === 'ETF') {
        quality = h.kind === 'ETF' ? 'ETF — exempt' : 'index fund — exempt';
      } else {
        switches ??= await evaluateSwitches(db, asOf);
        const s = switches.find((x) => x.heldInstrumentId === h.instrumentId);
        // cohortSize counts the category's scored peers, not the held fund: n = cohortSize + 1.
        if (s === undefined || s.cohortSize === 0) { out('no category cohort on record'); continue; }
        if (s.challengerId !== null) { out(`flagged for a switch to ${s.challengerName ?? s.challengerId}`); continue; }
        const n = s.cohortSize + 1;
        if (s.heldRank > Math.ceil(n / 2)) { out(`rank ${s.heldRank} of ${n} — not in the top half`); continue; }
        quality = `rank ${s.heldRank} of ${n} in ${s.category}`;
      }
      buys.push({ instrumentId: h.instrumentId, name: h.name, kind: h.kind, fundType: t, gapBps: midBps(r) - actualBps,
        actualBps, midBps: midBps(r), minBps: r.minBps, maxBps: r.maxBps, heldPaise: h.valuePaise, quality });
    }
  }
  buys.sort(byGap);
  return { approved: true, buys, typesBelowMidpoint, excluded };
}

