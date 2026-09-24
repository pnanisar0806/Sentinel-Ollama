import type { Db } from '../db/client.js';
import { CAPS, concentration } from './allocation.js';
import { listRedemptionsUntil } from './redemptions.js';
import type { Position } from './networth.js';

/**
 * PRD §6.5 sell / exit triggers, evaluated monthly (FR-15).
 *
 * Everything here is a PAPER object. §6.5 calls sell candidates "first-class", meaning
 * they exist as recommendations of kind `sell` — not that anything executes. No trigger
 * moves money; every one of them still needs fresh human approval.
 *
 * IPS §3.7 sets a 12-month minimum holding period "overridable only by: thesis
 * falsification, red-flag event (fraud/auditor/pledge), or hard-cap breach". Triggers 1,
 * 2 and 3 are exactly that list. Triggers 4 and 5 are NOT overrides, so a candidate they
 * raise inside the minimum hold is surfaced with `blockedByMinimumHold` rather than
 * quietly dropped — the owner should see that the engine wanted out and the IPS said wait.
 */

/** IPS §3.7. */
export const MINIMUM_HOLD_MONTHS = 12;

/** Composite points a challenger must beat the held name by before trigger 5 fires. */
export const BETTER_ALTERNATIVE_MARGIN = 15;

/** §6.5 trigger 5 is rationed: at most one such exit per quarter. */
export const BETTER_ALTERNATIVE_PER_QUARTER = 1;

/**
 * Trigger 6 — the legacy cleanup queue (IPS §3.9, FR-14) — is deliberately not evaluated
 * here. The owner placed the legacy cleanup queue and the LTCG harvest calendar in Phase 2
 * (decision 2026-09-05), and a half-built version that consolidated micro-orphans without
 * the harvest calendar would realise gains in the wrong fiscal year.
 */
export const LEGACY_QUEUE_STUB =
  'Trigger 6 (legacy cleanup queue, IPS §3.9 / FR-14) is a documented Phase 2 stub: it ' +
  'needs the LTCG harvest calendar to spread consolidation across fiscal years, which is ' +
  'Phase 2 scope. Nothing evaluates it in Phase 1.';

export type ExitTrigger =
  | 'falsification'
  | 'red-flag'
  | 'hard-cap'
  | 'underperformance'
  | 'better-alternative'
  | 'credit-maturity';

/** The three triggers IPS §3.7 accepts as overriding the minimum holding period. */
const OVERRIDE_TRIGGERS = new Set<ExitTrigger>(['falsification', 'red-flag', 'hard-cap']);

/**
 * A machine-testable falsification condition, stored inside `recommendations.primary_rec`
 * as `{ instrumentId, falsification: { metric, op, value } }`.
 *
 * The grammar is deliberately closed: a condition we cannot evaluate against a real
 * column is not a condition, it is prose, and FR-11's stored conditions have to be live.
 * `price_paise` carries its value as a decimal STRING — money never round-trips a float.
 */
export interface FalsificationCondition {
  metric: 'price_paise' | 'roce_pct' | 'de_ratio' | 'red_flags';
  op: 'lt' | 'gt';
  value: string | number;
}

export interface BetterAlternative {
  heldInstrumentId: string;
  challengerId: string;
  heldComposite: number;
  challengerComposite: number;
}

export interface ExitState {
  positions: Position[];
  /** FR-31 block list. A blocked instrument produces no exit, in either direction. */
  blockedIds: readonly string[];
  alternatives?: BetterAlternative[];
  /** Benchmark for trigger 4. Defaults to the satellite benchmark. */
  benchmarkSeries?: string;
}

export interface ExitCandidate {
  trigger: ExitTrigger;
  instrumentId: string;
  action: 'SELL' | 'TRIM' | 'REDEEM';
  month: string;
  /** The datum that fired it, not a restatement of the rule. */
  evidence: string;
  ipsClauseRefs: string[];
  /** §3.7: true only for falsification, red flag and hard-cap breach. */
  overridesMinimumHold: boolean;
  /** Months since the oldest open lot; null when nothing dates the position. */
  heldMonths: number | null;
  /** A non-override trigger that would break the §3.7 minimum hold. */
  blockedByMinimumHold: boolean;
  /**
   * What to sell, in paise. A full exit for SELL and REDEEM; for a hard-cap TRIM, the
   * excess that brings the bucket back inside the rail, never more than the position
   * itself holds. NULL when nothing in the portfolio sizes it — an exit candidate for
   * an instrument no position covers is still worth surfacing, but it is not sizeable,
   * and an unknown size is NULL rather than 0.
   */
  amountPaise: bigint | null;
  /** §6.5 candidates are recommendations, never orders. */
  paper: true;
}

const monthStart = (month: string): string => `${month}-01`;

const daysInMonth = (month: string): number =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

/**
 * The monthly run reviews the whole month, so every datum dated within it counts. Cutting
 * at the 1st would evaluate a month's triggers against the previous month's data.
 */
const monthEnd = (month: string): string => `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;

function monthsBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  return (
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    (b.getUTCMonth() - a.getUTCMonth()) -
    (b.getUTCDate() < a.getUTCDate() ? 1 : 0)
  );
}

function asIsoDate(v: string | Date): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

/** Oldest OPEN lot per instrument — what dates a holding for the §3.7 minimum hold. */
async function heldSince(db: Db): Promise<Map<string, string>> {
  const rows = await db.query<{ instrument_id: string; acquired_on: string | Date }>(
    `select instrument_id, min(acquired_on) as acquired_on
       from lots where closed_on is null group by instrument_id`,
  );
  return new Map(rows.map((r) => [r.instrument_id, asIsoDate(r.acquired_on)]));
}

async function latestClose(db: Db, instrumentId: string, onOrBefore: string): Promise<bigint | null> {
  const [row] = await db.query<{ close_paise: string | number | bigint }>(
    `select close_paise from prices_eod
      where instrument_id = $1 and trade_date <= $2
      order by trade_date desc limit 1`,
    [instrumentId, onOrBefore],
  );
  return row === undefined ? null : BigInt(row.close_paise);
}

interface FundamentalsSnapshot {
  rocePct: number | null;
  deRatio: number | null;
  redFlags: number | null;
  asOf: string;
}

async function latestFundamentals(
  db: Db,
  instrumentId: string,
  onOrBefore: string,
): Promise<FundamentalsSnapshot | null> {
  const [row] = await db.query<{
    roce_pct: string | number | null;
    de_ratio: string | number | null;
    red_flags: number | null;
    as_of: string | Date;
  }>(
    `select f.roce_pct, f.de_ratio, f.red_flags, s.as_of
       from fundamentals f join screener_uploads s on s.id = f.upload_id
      where f.instrument_id = $1 and s.as_of <= $2
      order by s.as_of desc, f.upload_id desc limit 1`,
    [instrumentId, onOrBefore],
  );
  if (row === undefined) return null;
  return {
    rocePct: row.roce_pct === null ? null : Number(row.roce_pct),
    deRatio: row.de_ratio === null ? null : Number(row.de_ratio),
    redFlags: row.red_flags,
    asOf: asIsoDate(row.as_of),
  };
}

/** Trailing return in percentage points over `sessions`, from integer bps. */
function trailingPct(closes: bigint[], sessions: number, offset = 0): number | null {
  const end = closes.length - 1 - offset;
  const start = end - sessions;
  if (start < 0) return null;
  const from = closes[start]!;
  if (from <= 0n) return null;
  return Number(((closes[end]! - from) * 10_000n) / from) / 100;
}

const SESSIONS_12M = 252;
const SESSIONS_QUARTER = 63;
const UNDERPERFORMANCE_PP = -20;

function quarterStart(month: string): string {
  const m = Number(month.slice(5, 7));
  const firstOfQuarter = m - ((m - 1) % 3);
  return `${month.slice(0, 4)}-${String(firstOfQuarter).padStart(2, '0')}-01`;
}

function candidate(
  trigger: ExitTrigger,
  instrumentId: string,
  action: ExitCandidate['action'],
  month: string,
  evidence: string,
  ipsClauseRefs: string[],
  held: Map<string, string>,
  amountPaise: bigint | null,
): ExitCandidate {
  const since = held.get(instrumentId);
  const heldMonths = since === undefined ? null : monthsBetween(since, monthEnd(month));
  const overridesMinimumHold = OVERRIDE_TRIGGERS.has(trigger);
  const blockedByMinimumHold =
    !overridesMinimumHold && heldMonths !== null && heldMonths < MINIMUM_HOLD_MONTHS;
  return {
    trigger,
    instrumentId,
    action,
    month,
    evidence: blockedByMinimumHold
      ? `${evidence}. Held ${heldMonths} months — IPS §3.7's ${MINIMUM_HOLD_MONTHS}-month minimum holding period is not overridable by this trigger.`
      : evidence,
    ipsClauseRefs,
    overridesMinimumHold,
    heldMonths,
    blockedByMinimumHold,
    amountPaise,
    paper: true,
  };
}

/**
 * Evaluates §6.5 triggers 1–5 and 7 for `month` ('YYYY-MM'). Trigger 6 is
 * `LEGACY_QUEUE_STUB`.
 *
 * A blocked instrument (FR-31) produces nothing at all: with a stale input we can neither
 * assert a trigger fired nor that it did not.
 */
export async function evaluateExits(
  db: Db,
  state: ExitState,
  month: string,
): Promise<ExitCandidate[]> {
  const asOf = monthEnd(month);
  const blocked = new Set(state.blockedIds);
  const held = await heldSince(db);
  const positions = state.positions.filter((p) => !blocked.has(p.instrumentId));
  const heldIds = new Set(positions.map((p) => p.instrumentId));
  const out: ExitCandidate[] = [];

  /**
   * Sizing. An exit candidate the owner cannot act on without first working out the
   * quantity himself is half a recommendation, so every candidate carries the amount
   * its own trigger implies.
   *
   * Caps are converted to basis points so the arithmetic stays exact bigint: a cap is a
   * ratio, and multiplying paise by a float to find the excess is the one place this
   * would have crept back in.
   */
  const sumWhere = (pred: (p: Position) => boolean): bigint =>
    positions.filter(pred).reduce((acc, p) => acc + p.valuePaise, 0n);
  const totalValue = sumWhere(() => true);
  /** The whole position, summed across accounts. NULL when nothing holds it. */
  const fullPosition = (id: string): bigint | null => {
    const v = sumWhere((p) => p.instrumentId === id);
    return v > 0n ? v : null;
  };
  /** What must leave a bucket to bring it back to `cap`. Proceeds stay in the portfolio
   *  as cash, so the denominator does not move. */
  const excessOver = (bucketValue: bigint, cap: number): bigint => {
    const allowed = (totalValue * BigInt(Math.round(cap * 10_000))) / 10_000n;
    return bucketValue > allowed ? bucketValue - allowed : 0n;
  };

  // 1. Falsification — an open recommendation's stored condition, tested against live data.
  const recs = await db.query<{ primary_rec: string }>(
    `select primary_rec from recommendations
      where suppressed = false and created_on <= $1`,
    [asOf],
  );
  for (const r of recs) {
    let parsed: { instrumentId?: string; falsification?: FalsificationCondition | null };
    try {
      parsed = JSON.parse(r.primary_rec);
    } catch {
      continue; // a rec whose payload is not the FR-11 shape carries no live condition
    }
    const id = parsed.instrumentId;
    const cond = parsed.falsification;
    if (id === undefined || !cond || blocked.has(id)) continue;

    const verdict = await testCondition(db, id, cond, asOf);
    if (verdict === null || verdict.fired === false) continue;
    out.push(
      candidate('falsification', id, 'SELL', month, verdict.evidence, ['3.7'], held,
        fullPosition(id)),
    );
  }

  // 2. Red flag in the latest screener upload for a held name.
  for (const id of heldIds) {
    const f = await latestFundamentals(db, id, asOf);
    if (f === null || f.redFlags === null || f.redFlags <= 0) continue;
    out.push(
      candidate(
        'red-flag',
        id,
        'SELL',
        month,
        `${f.redFlags} screener red flag(s) as of ${f.asOf}`,
        ['3.7'],
        held,
        fullPosition(id),
      ),
    );
  }

  // 3. Hard-cap breach (§3.5). Reuses the Phase 0 concentration maps rather than
  // re-deriving them; the sector cap is deliberately absent because it names a sector,
  // not a holding, and an exit candidate has to name something sellable.
  const c = concentration(positions);
  /** Per instrument: why it is over, and how much of the bucket has to go. */
  const capHits = new Map<string, { evidence: string; excess: bigint }>();
  for (const [id, share] of c.byStock) {
    if (share > CAPS.singleStock) {
      capHits.set(id, {
        evidence: `single-stock ${(share * 100).toFixed(1)}% vs ${(CAPS.singleStock * 100).toFixed(0)}% cap`,
        excess: excessOver(sumWhere((p) => p.instrumentId === id), CAPS.singleStock),
      });
    }
  }
  for (const [id, share] of c.byMfScheme) {
    if (share > CAPS.singleMfScheme) {
      capHits.set(id, {
        evidence: `single-MF-scheme ${(share * 100).toFixed(1)}% vs ${(CAPS.singleMfScheme * 100).toFixed(0)}% cap`,
        excess: excessOver(sumWhere((p) => p.instrumentId === id), CAPS.singleMfScheme),
      });
    }
  }
  for (const [issuer, share] of c.byIssuer) {
    if (share <= CAPS.singleIssuer) continue;
    const excess = excessOver(sumWhere((x) => x.issuer === issuer), CAPS.singleIssuer);
    for (const p of positions.filter((x) => x.issuer === issuer)) {
      capHits.set(p.instrumentId, {
        evidence: `single-issuer ${issuer} ${(share * 100).toFixed(1)}% vs ${(CAPS.singleIssuer * 100).toFixed(0)}% cap`,
        excess,
      });
    }
  }
  if (c.employerPct > CAPS.employer) {
    const excess = excessOver(sumWhere((x) => x.isEmployer), CAPS.employer);
    for (const p of positions.filter((x) => x.isEmployer)) {
      capHits.set(p.instrumentId, {
        evidence: `employer ${(c.employerPct * 100).toFixed(1)}% vs ${(CAPS.employer * 100).toFixed(0)}% cap`,
        excess,
      });
    }
  }
  for (const [id, hit] of capHits) {
    // A cap breach asks for the excess back inside the rail, not for the position to go.
    // Where a bucket spans several instruments (an issuer, the employer) the excess is
    // what the BUCKET must shed; no one position can be asked for more than it holds,
    // and clearing the breach may take more than one of them.
    const own = fullPosition(id);
    const trim = own === null ? null : (hit.excess < own ? hit.excess : own);
    out.push(candidate('hard-cap', id, 'TRIM', month, hit.evidence, ['3.5'], held, trim));
  }

  // 4. Sustained underperformance: 12-month relative return worse than −20pp at two
  // consecutive quarter marks.
  const benchmark = await seriesCloses(
    db,
    `select close_paise from index_prices_eod where series_code = $1 and trade_date <= $2 order by trade_date desc limit 400`,
    [state.benchmarkSeries ?? 'NIFTY 500', asOf],
  );
  for (const id of heldIds) {
    const closes = await seriesCloses(
      db,
      `select close_paise from prices_eod where instrument_id = $1 and trade_date <= $2 order by trade_date desc limit 400`,
      [id, asOf],
    );
    const now = relative(closes, benchmark, 0);
    const prior = relative(closes, benchmark, SESSIONS_QUARTER);
    if (now === null || prior === null) continue;
    if (now >= UNDERPERFORMANCE_PP || prior >= UNDERPERFORMANCE_PP) continue;
    out.push(
      candidate(
        'underperformance',
        id,
        'SELL',
        month,
        `12-month return ${now.toFixed(1)}pp vs benchmark this quarter and ${prior.toFixed(1)}pp last quarter, both past the ${UNDERPERFORMANCE_PP}pp line`,
        ['3.7'],
        held,
        fullPosition(id),
      ),
    );
  }

  // 5. Tax-aware better alternative, rationed to one per quarter.
  const already = await db.query<{ n: string }>(
    `select count(*) as n from recommendations
      where kind = 'sell' and created_on >= $1 and created_on <= $2
        and engine_evidence like '%better-alternative%'`,
    [quarterStart(month), asOf],
  );
  let budget = BETTER_ALTERNATIVE_PER_QUARTER - Number(already[0]?.n ?? 0);
  for (const alt of state.alternatives ?? []) {
    if (budget <= 0) break;
    if (blocked.has(alt.heldInstrumentId) || blocked.has(alt.challengerId)) continue;
    const edge = alt.challengerComposite - alt.heldComposite;
    if (edge < BETTER_ALTERNATIVE_MARGIN) continue;
    out.push(
      candidate(
        'better-alternative',
        alt.heldInstrumentId,
        'SELL',
        month,
        `${alt.challengerId} scores ${alt.challengerComposite} against ${alt.heldComposite} — ${edge} points clear of the ${BETTER_ALTERNATIVE_MARGIN}-point margin`,
        ['3.7'],
        held,
        fullPosition(alt.heldInstrumentId),
      ),
    );
    budget--;
  }

  // 7. Credit / maturity. A rating action has no ingestion source in Phase 1 — the
  // Sammaan and Edelweiss §3.8 reviews are owner items, not something we can watch — so
  // this leg covers maturities only. The window is the whole month plus a fortnight, so a
  // monthly run cannot step over a mid-month redemption.
  const maturityHorizon = daysInMonth(month) + 14;
  for (const r of await listRedemptionsUntil(db, maturityHorizon, new Date(`${monthStart(month)}T00:00:00Z`))) {
    if (blocked.has(r.instrumentId)) continue;
    out.push(
      candidate(
        'credit-maturity',
        r.instrumentId,
        'REDEEM',
        month,
        `${r.symbol} matures ${r.maturityDate}, ${r.daysUntil} days out`,
        ['3.8', '3.9'],
        held,
        fullPosition(r.instrumentId),
      ),
    );
  }

  return out;
}

async function seriesCloses(db: Db, sql: string, params: unknown[]): Promise<bigint[]> {
  const rows = await db.query<{ close_paise: string | number | bigint }>(sql, params);
  return rows.map((r) => BigInt(r.close_paise)).reverse();
}

/** 12-month return relative to the benchmark, in percentage points, at `offset` sessions back. */
function relative(closes: bigint[], benchmark: bigint[], offset: number): number | null {
  const own = trailingPct(closes, SESSIONS_12M, offset);
  const bench = trailingPct(benchmark, SESSIONS_12M, offset);
  if (own === null || bench === null) return null;
  return own - bench;
}

/**
 * Evaluates one stored condition. `null` means UNTESTABLE — the datum it names is not in
 * our data — which is not the same as false and must never read as an exit.
 */
export async function testCondition(
  db: Db,
  instrumentId: string,
  cond: FalsificationCondition,
  asOf: string,
): Promise<{ fired: boolean; evidence: string } | null> {
  if (cond.metric === 'price_paise') {
    const close = await latestClose(db, instrumentId, asOf);
    if (close === null) return null;
    const threshold = BigInt(cond.value);
    const fired = cond.op === 'lt' ? close < threshold : close > threshold;
    return {
      fired,
      evidence: `close ${close.toString()} paise is ${cond.op === 'lt' ? 'below' : 'above'} the falsification level ${threshold.toString()}`,
    };
  }

  const f = await latestFundamentals(db, instrumentId, asOf);
  if (f === null) return null;
  const actual =
    cond.metric === 'roce_pct' ? f.rocePct : cond.metric === 'de_ratio' ? f.deRatio : f.redFlags;
  if (actual === null) return null;
  const threshold = Number(cond.value);
  const fired = cond.op === 'lt' ? actual < threshold : actual > threshold;
  return {
    fired,
    evidence: `${cond.metric} ${actual} is ${cond.op === 'lt' ? 'below' : 'above'} the falsification level ${threshold} (screener ${f.asOf})`,
  };
}

/**
 * Records what the triggers found this month.
 *
 * Idempotent on (month, instrument, trigger): the weekly job runs four or five times a
 * month and must add nothing on the repeats. The table is append-only, so a duplicate
 * could not be cleaned up afterwards.
 *
 * A candidate that cannot be sized is still recorded — the fact that the engine flagged
 * it is the point, and `amount_paise` stays NULL rather than becoming 0.
 *
 * Returns the number of rows this call actually wrote, which is what lets the caller
 * say "two new candidates" instead of repeating a standing list every week.
 */
export async function persistExitCandidates(
  db: Db,
  candidates: ExitCandidate[],
  asOf: string,
  source = 'sell-triggers',
): Promise<number> {
  let written = 0;
  for (const c of candidates) {
    const rows = await db.query<{ id: string }>(
      `insert into exit_candidates
         (month, instrument_id, trigger_code, action, evidence, ips_clause_refs,
          overrides_minimum_hold, held_months, blocked_by_minimum_hold, amount_paise,
          as_of, source)
       values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12)
       on conflict (month, instrument_id, trigger_code) do nothing
       returning id`,
      [c.month, c.instrumentId, c.trigger, c.action, c.evidence,
       JSON.stringify(c.ipsClauseRefs), c.overridesMinimumHold, c.heldMonths,
       c.blockedByMinimumHold, c.amountPaise === null ? null : c.amountPaise.toString(),
       asOf, source],
    );
    if (rows.length > 0) written += 1;
  }
  return written;
}

/** Everything recorded for a month, newest month first when `month` is omitted. */
export async function loadExitCandidates(db: Db, month?: string): Promise<ExitCandidate[]> {
  const rows = await db.query<{
    month: string; instrument_id: string; trigger_code: ExitTrigger;
    action: ExitCandidate['action']; evidence: string; ips_clause_refs: unknown;
    overrides_minimum_hold: boolean; held_months: number | null;
    blocked_by_minimum_hold: boolean; amount_paise: string | number | null;
  }>(
    month === undefined
      ? `select * from exit_candidates
          where month = (select max(month) from exit_candidates)
          order by instrument_id, trigger_code`
      : `select * from exit_candidates where month = $1 order by instrument_id, trigger_code`,
    month === undefined ? [] : [month],
  );
  return rows.map((r) => ({
    trigger: r.trigger_code,
    instrumentId: r.instrument_id,
    action: r.action,
    month: r.month,
    evidence: r.evidence,
    ipsClauseRefs: (typeof r.ips_clause_refs === 'string'
      ? JSON.parse(r.ips_clause_refs)
      : r.ips_clause_refs) as string[],
    overridesMinimumHold: r.overrides_minimum_hold,
    heldMonths: r.held_months,
    blockedByMinimumHold: r.blocked_by_minimum_hold,
    amountPaise: r.amount_paise === null ? null : BigInt(r.amount_paise),
    paper: true,
  }));
}
