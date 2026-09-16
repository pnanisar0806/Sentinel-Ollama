import type { Db } from '../db/client.js';

/**
 * PRD §6 signal engine: satellite composite + MF ranking.
 *
 * Scores are unitless [0,100]; every money input stays a `bigint` (paise / nav micros)
 * and returns are derived through integer arithmetic, never a float division of money.
 *
 * What this engine does NOT compute, and why — flag to the owner rather than fake it:
 *   - EV/EBITDA and a name's own 5-year P/E range. The pinned screener.in export
 *     (`SCREENER_COLUMNS`) carries neither, and a single upload is one point in time.
 *     Valuation therefore rests on earnings yield vs the G-sec and P/E vs the sector
 *     cohort median.
 *   - The 10Y G-sec yield. There is no ingestion source for it in Phase 1, so it is a
 *     required caller input (`EngineContext.gsecYieldPct`) — an owner true-up item, not
 *     a constant invented here.
 */

/** §6 composite weights. PRD-fixed; the components they weight are falsifiable. */
export const SATELLITE_WEIGHTS = { valuation: 30, trend: 30, earnings: 20, fit: 20 } as const;

/** §6 MF scoring weights. */
export const MF_WEIGHTS = { consistency: 40, expense: 20, tenure: 15, aum: 15, style: 10 } as const;

/** §6 band thresholds on the composite. Below `watch` the name is not scored into anything. */
export const BANDS = { high: 85, medium: 70, watch: 60 } as const;

/** §6 quality gate thresholds. */
export const QUALITY = { minRocePct: 15, maxDeRatio: 1, maxRedFlags: 0 } as const;

/** Sectors whose balance sheets make a D/E gate meaningless (§6). */
export const FINANCE_SECTORS = ['Banking', 'Finance', 'NBFC', 'Financial Services', 'Insurance'] as const;

export type SignalBand = 'HIGH' | 'MEDIUM' | 'WATCH' | 'NONE';

export interface CandidateFundamentals {
  rocePct: number | null;
  deRatio: number | null;
  fcfPos5y: boolean | null;
  redFlags: number | null;
  peRatio: number | null;
  profit5yCagrPct: number | null;
  sales5yCagrPct: number | null;
}

export interface SatelliteCandidate {
  instrumentId: string;
  sector: string | null;
  fundamentals: CandidateFundamentals;
  /** EOD closes in paise, oldest → newest. */
  closes: bigint[];
}

export interface EngineContext {
  scoreDate: string;
  /** FR-31 block list from `blockedInstruments`. A blocked name gets no score at all. */
  blockedIds: readonly string[];
  /** 10Y G-sec yield, percent. Caller-supplied — see the module note. */
  gsecYieldPct: number;
  /** Benchmark (NIFTY 500) closes in paise, oldest → newest. */
  benchmarkCloses: bigint[];
  /** Median trailing P/E per sector, from the screener cohort — not an external table. */
  sectorMedianPe: Record<string, number>;
  fit: {
    /** Room left in the satellite bucket after current recommendations. */
    headroomPaise: bigint;
    sectorWeightPct: Record<string, number>;
    sectorCapPct: number;
  };
}

export interface SatelliteComponents {
  valuation: number;
  trend: number;
  earnings: number;
  fit: number;
}

export interface SatelliteScore {
  instrumentId: string;
  scoreDate: string;
  qualityPassed: boolean;
  qualityFailures: string[];
  /** null when the quality gate failed: no composite is computed for a failed name. */
  composite: number | null;
  components: SatelliteComponents | null;
  band: SignalBand;
  /** Source anchors + what the score could not see. */
  evidence: string[];
}

/** Percentage return between two money points, via integer bps. */
function retPct(from: bigint, to: bigint): number {
  if (from <= 0n) return 0;
  return Number(((to - from) * 10_000n) / from) / 100;
}

/** Return over the last `n` steps of a series; 0 when the history is too short. */
function trailingPct(series: bigint[], n: number): number | null {
  if (series.length < n + 1) return null;
  return retPct(series[series.length - 1 - n]!, series[series.length - 1]!);
}

/** Linear score of `value` mapped from `lo`→0 and `hi`→`weight`, clamped. Works either direction. */
function ramp(value: number, lo: number, hi: number, weight: number): number {
  const t = (value - lo) / (hi - lo);
  return Math.max(0, Math.min(1, t)) * weight;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function bandOf(composite: number): SignalBand {
  if (composite >= BANDS.high) return 'HIGH';
  if (composite >= BANDS.medium) return 'MEDIUM';
  if (composite >= BANDS.watch) return 'WATCH';
  return 'NONE';
}

/**
 * §6 quality gate. Binary and fail-closed: an unknown is not a pass. A name whose
 * fundamentals are missing is a name we cannot vouch for, and the PRD's whole posture
 * is that an unreadable input is never inferred (FR-02).
 */
function qualityGate(c: SatelliteCandidate): { failures: string[]; notes: string[] } {
  const f = c.fundamentals;
  const failures: string[] = [];
  const notes: string[] = [];

  if (f.rocePct === null) failures.push('ROCE unavailable');
  else if (f.rocePct <= QUALITY.minRocePct) failures.push(`ROCE ${f.rocePct}% ≤ ${QUALITY.minRocePct}%`);

  if (f.fcfPos5y === null) failures.push('FCF history unavailable (5y positivity unknown)');
  else if (!f.fcfPos5y) failures.push('fewer than 4 of the last 5 years of positive FCF');

  const financeExempt = c.sector !== null && (FINANCE_SECTORS as readonly string[]).includes(c.sector);
  if (financeExempt) notes.push(`D/E gate waived: ${c.sector} balance sheet`);
  else if (f.deRatio === null) failures.push('D/E unavailable');
  else if (f.deRatio >= QUALITY.maxDeRatio) failures.push(`D/E ${f.deRatio} ≥ ${QUALITY.maxDeRatio}`);

  if (f.redFlags === null) notes.push('red flags not assessed on the screen — owner reviews per-company at shortlist');
  else if (f.redFlags > QUALITY.maxRedFlags) failures.push(`${f.redFlags} screener red flag(s)`);

  return { failures, notes };
}

function scoreValuation(c: SatelliteCandidate, ctx: EngineContext, evidence: string[]): number {
  const half = SATELLITE_WEIGHTS.valuation / 2;
  const pe = c.fundamentals.peRatio;
  if (pe === null || pe <= 0) {
    evidence.push('valuation: no P/E in the screener row — component scored 0');
    return 0;
  }

  // Earnings yield vs the risk-free rate: at parity, half credit; +4pts of spread, full.
  const spread = 100 / pe - ctx.gsecYieldPct;
  const vsGsec = ramp(spread, -4, 4, half);

  const median = c.sector === null ? undefined : ctx.sectorMedianPe[c.sector];
  if (median === undefined || median <= 0) {
    evidence.push(`valuation: no sector median P/E for ${c.sector ?? 'unknown sector'} — relative leg scored 0`);
    return round2(vsGsec);
  }
  // Cheap against the cohort scores; 1.5× the median or worse scores nothing.
  const vsSector = ramp(pe / median, 1.5, 0.5, half);
  evidence.push(`valuation: P/E ${pe} vs ${c.sector} median ${median}, earnings yield ${round2(100 / pe)}% vs G-sec ${ctx.gsecYieldPct}%`);
  return round2(vsGsec + vsSector);
}

const SIX_MONTH_SESSIONS = 126;
const TWELVE_MONTH_SESSIONS = 252;
const DMA_SESSIONS = 200;

function scoreTrend(c: SatelliteCandidate, ctx: EngineContext, evidence: string[]): number {
  const w = SATELLITE_WEIGHTS.trend;
  let score = 0;

  const own6 = trailingPct(c.closes, SIX_MONTH_SESSIONS);
  const bench6 = trailingPct(ctx.benchmarkCloses, SIX_MONTH_SESSIONS);
  if (own6 === null || bench6 === null) {
    evidence.push('trend: fewer than 6 months of closes — relative strength leg scored 0');
  } else {
    score += ramp(own6 - bench6, -20, 20, w * 0.4);
    evidence.push(`trend: 6m RS ${round2(own6 - bench6)}pp vs benchmark`);
  }

  const own12 = trailingPct(c.closes, TWELVE_MONTH_SESSIONS);
  if (own12 !== null) score += ramp(own12, -20, 30, w * 0.3);

  const dma = movingAverage(c.closes, DMA_SESSIONS);
  if (dma === null) {
    evidence.push(`trend: fewer than ${DMA_SESSIONS} closes — 200DMA leg scored 0`);
  } else {
    const last = c.closes[c.closes.length - 1]!;
    score += ramp(retPct(dma, last), -10, 10, w * 0.3);
  }

  return round2(score);
}

/** Mean of the last `n` closes, in paise, integer-truncated. */
function movingAverage(series: bigint[], n: number): bigint | null {
  if (series.length < n) return null;
  const window = series.slice(series.length - n);
  return window.reduce((a, b) => a + b, 0n) / BigInt(n);
}

function scoreEarnings(c: SatelliteCandidate, evidence: string[]): number {
  const w = SATELLITE_WEIGHTS.earnings;
  const profit = c.fundamentals.profit5yCagrPct;
  const sales = c.fundamentals.sales5yCagrPct;
  let score = 0;

  if (profit === null) evidence.push('earnings: no 5y profit CAGR — growth leg scored 0');
  else score += ramp(profit, 0, 25, w * 0.6);

  if (sales === null) evidence.push('earnings: no 5y sales CAGR — delivery leg scored 0');
  // Profit growing without sales is the low-quality kind; the two legs are scored apart.
  else score += ramp(sales, 0, 20, w * 0.4);

  return round2(score);
}

function scoreFit(c: SatelliteCandidate, ctx: EngineContext, evidence: string[]): number {
  const w = SATELLITE_WEIGHTS.fit;
  // No headroom in the satellite bucket means a buy has nowhere to go, whatever the name.
  const headroom = ctx.fit.headroomPaise > 0n ? w * 0.5 : 0;
  if (headroom === 0) evidence.push('fit: satellite bucket has no headroom');

  const weight = (c.sector === null ? undefined : ctx.fit.sectorWeightPct[c.sector]) ?? 0;
  const cap = ctx.fit.sectorCapPct;
  const balance = cap <= 0 ? 0 : ramp(weight / cap, 1, 0, w * 0.5);
  if (weight >= cap) evidence.push(`fit: ${c.sector} already at ${weight}% against a ${cap}% cap`);

  return round2(headroom + balance);
}

/**
 * Scores one satellite candidate.
 *
 * Returns `null` when the instrument is blocked by a stale input (FR-31) — a blocked
 * name is not scored, not scored-zero. A name that fails the quality gate DOES get a
 * row, with `composite: null` and `qualityPassed: false`, so the weekly report can say
 * why it was rejected.
 */
export function scoreSatellite(c: SatelliteCandidate, ctx: EngineContext): SatelliteScore | null {
  if (ctx.blockedIds.includes(c.instrumentId)) return null;

  const { failures, notes } = qualityGate(c);
  if (failures.length > 0) {
    return {
      instrumentId: c.instrumentId,
      scoreDate: ctx.scoreDate,
      qualityPassed: false,
      qualityFailures: failures,
      composite: null,
      components: null,
      band: 'NONE',
      evidence: notes,
    };
  }

  const evidence = [...notes];
  const components: SatelliteComponents = {
    valuation: scoreValuation(c, ctx, evidence),
    trend: scoreTrend(c, ctx, evidence),
    earnings: scoreEarnings(c, evidence),
    fit: scoreFit(c, ctx, evidence),
  };
  const composite = round2(
    components.valuation + components.trend + components.earnings + components.fit,
  );

  return {
    instrumentId: c.instrumentId,
    scoreDate: ctx.scoreDate,
    qualityPassed: true,
    qualityFailures: [],
    composite,
    components,
    band: bandOf(composite),
    evidence,
  };
}

/** Median trailing P/E per sector across the screener cohort. Median, not mean: one 120× outlier would move a mean. */
export function sectorMedianPe(cohort: readonly SatelliteCandidate[]): Record<string, number> {
  const bySector = new Map<string, number[]>();
  for (const c of cohort) {
    const pe = c.fundamentals.peRatio;
    if (c.sector === null || pe === null || pe <= 0) continue;
    const list = bySector.get(c.sector) ?? [];
    list.push(pe);
    bySector.set(c.sector, list);
  }

  const out: Record<string, number> = {};
  for (const [sector, values] of bySector) {
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    out[sector] =
      values.length % 2 === 1 ? values[mid]! : round2((values[mid - 1]! + values[mid]!) / 2);
  }
  return out;
}

// --- MF ranking (§6) ----------------------------------------------------------------

export interface MfCandidate {
  instrumentId: string;
  /** NAV history in micros, oldest → newest. */
  navMicros: bigint[];
  expenseRatioBps: number | null;
  tenureMonths: number | null;
  aumPaise: bigint | null;
  styleDriftPct: number | null;
}

export interface MfContext {
  scoreDate: string;
  blockedIds: readonly string[];
  /** Samples per rolling window (default 12 — monthly NAV points over a year). */
  rollingWindow?: number;
  /** A window counts as consistent when it beats this, in bps. Default 0 (nominal gain). */
  hurdleBps?: number;
}

export interface MfRanking {
  instrumentId: string;
  scoreDate: string;
  composite: number;
  rank: number;
  components: { consistency: number; expense: number; tenure: number; aum: number; style: number };
  windowsEvaluated: number;
}

/** Share of rolling windows clearing the hurdle. Pure integer math on nav micros. */
function consistencyRatio(navs: bigint[], window: number, hurdleBps: number): { ratio: number; windows: number } {
  if (navs.length <= window) return { ratio: 0, windows: 0 };
  let wins = 0;
  let windows = 0;
  for (let i = window; i < navs.length; i++) {
    const from = navs[i - window]!;
    if (from <= 0n) continue;
    const bps = Number(((navs[i]! - from) * 10_000n) / from);
    windows++;
    if (bps >= hurdleBps) wins++;
  }
  return { ratio: windows === 0 ? 0 : wins / windows, windows };
}

const CRORE_PAISE = 10_000_000_00n;

export function rankMfs(candidates: readonly MfCandidate[], ctx: MfContext): MfRanking[] {
  const window = ctx.rollingWindow ?? 12;
  const hurdle = ctx.hurdleBps ?? 0;

  const scored = candidates
    .filter((m) => !ctx.blockedIds.includes(m.instrumentId))
    .map((m) => {
      const { ratio, windows } = consistencyRatio(m.navMicros, window, hurdle);
      const components = {
        consistency: round2(ratio * MF_WEIGHTS.consistency),
        // 190bps (a pricey regular plan) scores nothing; 25bps (a lean index fund) scores full.
        expense: round2(m.expenseRatioBps === null ? 0 : ramp(m.expenseRatioBps, 190, 25, MF_WEIGHTS.expense)),
        tenure: round2(m.tenureMonths === null ? 0 : ramp(m.tenureMonths, 0, 60, MF_WEIGHTS.tenure)),
        aum: round2(
          m.aumPaise === null ? 0 : ramp(Number(m.aumPaise / CRORE_PAISE), 100, 2_000, MF_WEIGHTS.aum),
        ),
        style: round2(m.styleDriftPct === null ? 0 : ramp(m.styleDriftPct, 20, 0, MF_WEIGHTS.style)),
      };
      const composite = round2(
        components.consistency + components.expense + components.tenure + components.aum + components.style,
      );
      return { instrumentId: m.instrumentId, scoreDate: ctx.scoreDate, composite, components, windowsEvaluated: windows, rank: 0 };
    });

  scored.sort((a, b) => b.composite - a.composite || a.instrumentId.localeCompare(b.instrumentId));
  return scored.map((s, i) => ({ ...s, rank: i + 1 }));
}

// --- Persistence + loading ----------------------------------------------------------

/**
 * Appends the day's scores. `signal_scores` is append-only, so a re-run must not UPDATE:
 * `do nothing` leaves the first write of the day standing and returns how many landed.
 */
export async function persistSignalScores(db: Db, scores: readonly SatelliteScore[]): Promise<number> {
  let inserted = 0;
  for (const s of scores) {
    const rows = await db.query<{ instrument_id: string }>(
      `insert into signal_scores
         (instrument_id, score_date, composite, quality_passed, reg_valuation, reg_trend, reg_earnings, reg_fit)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (instrument_id, score_date) do nothing
       returning instrument_id`,
      [
        s.instrumentId,
        s.scoreDate,
        // A failed quality gate has no composite; the column is NOT NULL, so 0 stands in
        // and `quality_passed = false` is what carries the meaning.
        s.composite ?? 0,
        s.qualityPassed,
        s.components?.valuation ?? null,
        s.components?.trend ?? null,
        s.components?.earnings ?? null,
        s.components?.fit ?? null,
      ],
    );
    inserted += rows.length;
  }
  return inserted;
}

export interface EngineInputs {
  candidates: SatelliteCandidate[];
  context: Omit<EngineContext, 'blockedIds' | 'fit'>;
}

/** Screener raw-column names read back out of `fundamentals.data`. */
function rawNumber(data: Record<string, string> | null, key: string): number | null {
  const v = data?.[key];
  if (v === undefined) return null;
  const n = Number(v.replace(/,/g, '').replace(/%/g, '').trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Loads the active watchlist with its latest fundamentals row and price history.
 * Names without a fundamentals row are still returned — the quality gate rejects them
 * explicitly, which is the honest outcome, rather than them vanishing silently.
 */
export async function loadEngineInputs(
  db: Db,
  scoreDate: string,
  opts: { gsecYieldPct: number; lookbackDays?: number; benchmarkSeries?: string },
): Promise<EngineInputs> {
  const lookback = opts.lookbackDays ?? 400;
  const benchmarkSeries = opts.benchmarkSeries ?? 'NIFTY 500';

  const watch = await db.query<{ instrument_id: string; sector: string | null }>(
    `select w.instrument_id, i.sector
       from watchlist w
       join instruments i on i.id = w.instrument_id
      where w.added_on <= $1 and (w.removed_on is null or w.removed_on > $1)`,
    [scoreDate],
  );

  const candidates: SatelliteCandidate[] = [];
  for (const w of watch) {
    const [f] = await db.query<{
      data: string | Record<string, string>;
      roce_pct: string | number | null;
      de_ratio: string | number | null;
      fcf_pos_5y: boolean | null;
      red_flags: number | null;
    }>(
      `select f.data, f.roce_pct, f.de_ratio, f.fcf_pos_5y, f.red_flags
         from fundamentals f
         join screener_uploads s on s.id = f.upload_id
        where f.instrument_id = $1 and s.as_of <= $2
        order by s.as_of desc, f.upload_id desc
        limit 1`,
      [w.instrument_id, scoreDate],
    );

    const raw: Record<string, string> | null =
      f === undefined ? null : typeof f.data === 'string' ? JSON.parse(f.data) : f.data;

    const closes = await db.query<{ close_paise: string | number | bigint }>(
      `select close_paise from prices_eod
        where instrument_id = $1 and trade_date <= $2
        order by trade_date desc limit $3`,
      [w.instrument_id, scoreDate, lookback],
    );

    candidates.push({
      instrumentId: w.instrument_id,
      sector: w.sector,
      fundamentals: {
        rocePct: f?.roce_pct === null || f?.roce_pct === undefined ? null : Number(f.roce_pct),
        deRatio: f?.de_ratio === null || f?.de_ratio === undefined ? null : Number(f.de_ratio),
        fcfPos5y: f?.fcf_pos_5y ?? null,
        redFlags: f?.red_flags ?? null,
        peRatio: rawNumber(raw, 'P/E'),
        profit5yCagrPct: rawNumber(raw, 'Profit 5Y CAGR') ?? rawNumber(raw, 'Profit 5Y CAGR %'),
        sales5yCagrPct: rawNumber(raw, 'Sales 5Y CAGR') ?? rawNumber(raw, 'Sales 5Y CAGR %'),
      },
      closes: closes.map((r) => BigInt(r.close_paise)).reverse(),
    });
  }

  const bench = await db.query<{ close_paise: string | number | bigint }>(
    `select close_paise from index_prices_eod
      where series_code = $1 and trade_date <= $2
      order by trade_date desc limit $3`,
    [benchmarkSeries, scoreDate, lookback],
  );

  return {
    candidates,
    context: {
      scoreDate,
      gsecYieldPct: opts.gsecYieldPct,
      benchmarkCloses: bench.map((r) => BigInt(r.close_paise)).reverse(),
      sectorMedianPe: sectorMedianPe(candidates),
    },
  };
}
