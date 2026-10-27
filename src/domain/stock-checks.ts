import type { Db } from '../db/client.js';
import { BANDS, FINANCE_SECTORS, QUALITY, median, rawNumber } from './engine.js';
import { governanceStatus } from '../sources/news.js';

/**
 * The five fail-closed stock checks (spec 2026-10-23 §5). A stock reaches the advisor only
 * with five PASSes, the quality gate and composite ≥ BANDS.high. Missing data is UNKNOWN,
 * and UNKNOWN is a no.
 */
export type CheckStatus = 'PASS' | 'FAIL' | 'UNKNOWN';
export type CheckName = 'debt' | 'pledge' | 'valuation' | 'growth' | 'management';
export interface CheckResult {
  check: CheckName; status: CheckStatus; value: string | null; threshold: string; asOf: string | null; source: string;
}
type Governance = Awaited<ReturnType<typeof governanceStatus>>;
export interface StockCheckInput {
  sector: string | null;
  deRatio: number | null;
  pledgedPct: number | null;
  eps: number | null;
  close: { pricePaise: bigint; asOf: string } | null;
  asOf: string;
  sectorPe: { median: number; peers: number } | null;
  profit5yCagrPct: number | null;
  sales5yCagrPct: number | null;
  cfo5y: number | null;
  pat5y: number | null;
  promoterDropPp: number | null;
  governance: Governance;
  uploadAsOf: string | null;
}
export interface StockChecks {
  instrumentId: string; name: string; composite: number | null; qualityPassed: boolean; checks: CheckResult[]; passed: boolean;
}

const CLOSE_FRESH_DAYS = 5;
const MIN_PEERS = 5;
const PE_MULTIPLE = 1.5;
const MIN_CAGR_PCT = 12;
const MAX_PROMOTER_DROP_PP = 5;
/** The "year ago" promoter reading must be 365–400 days before the latest upload; older is not a 1-year change. */
const YEAR_AGO_MAX_DAYS = 400;
const SCREENER = 'screener upload';

/** FAIL if any leg fails, else UNKNOWN if any is unknown, else PASS (Decision 6). */
const combine = (xs: CheckStatus[]): CheckStatus =>
  xs.includes('FAIL') ? 'FAIL' : xs.includes('UNKNOWN') ? 'UNKNOWN' : 'PASS';
const pct = (n: number | null) => (n === null ? 'unknown' : `${n.toFixed(1)}%`);
/** A Screener figure as an exact integer of 1/10,000ths. */
const scaled = (n: number) => BigInt(Math.round(n * 10_000));
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 86_400_000;

function valuation(i: StockCheckInput): Pick<CheckResult, 'status' | 'value'> {
  if (i.eps === null) return { status: 'UNKNOWN', value: 'EPS unknown' };
  if (i.eps <= 0) return { status: 'FAIL', value: `EPS ${i.eps} (loss-making)` };
  if (i.close === null) return { status: 'UNKNOWN', value: 'no close' };
  if (days(i.close.asOf, i.asOf) > CLOSE_FRESH_DAYS) return { status: 'UNKNOWN', value: `close ${i.close.asOf} is stale` };
  const pe = Number(i.close.pricePaise) / 100 / i.eps;
  if (i.sector === null) return { status: 'UNKNOWN', value: `P/E ${pe.toFixed(1)}; no sector` };
  if (i.sectorPe === null || i.sectorPe.peers < MIN_PEERS) {
    return { status: 'UNKNOWN', value: `P/E ${pe.toFixed(1)}; ${i.sectorPe?.peers ?? 0} ${i.sector} peers` };
  }
  return {
    status: pe > PE_MULTIPLE * i.sectorPe.median ? 'FAIL' : 'PASS',
    value: `P/E ${pe.toFixed(1)} vs ${i.sector} median ${i.sectorPe.median.toFixed(1)} (${i.sectorPe.peers} peers)`,
  };
}

/** Pure: always five results, in the order debt, pledge, valuation, growth, management. */
export function evaluateChecks(i: StockCheckInput): CheckResult[] {
  const up = { asOf: i.uploadAsOf, source: SCREENER };

  const waived = i.sector !== null && (FINANCE_SECTORS as readonly string[]).includes(i.sector);
  const debt: CheckResult = {
    check: 'debt', threshold: `D/E < ${QUALITY.maxDeRatio} (finance sectors exempt)`, ...up,
    ...(waived ? { status: 'PASS', value: `waived: ${i.sector} balance sheet` }
      : i.deRatio === null ? { status: 'UNKNOWN', value: null }
      : { status: i.deRatio >= QUALITY.maxDeRatio ? 'FAIL' : 'PASS', value: `D/E ${i.deRatio}` }),
  };

  const pledge: CheckResult = {
    check: 'pledge', threshold: 'pledged 0%', ...up,
    status: i.pledgedPct === null ? 'UNKNOWN' : i.pledgedPct > 0 ? 'FAIL' : 'PASS',
    value: i.pledgedPct === null ? null : `pledged ${i.pledgedPct}%`,
  };

  const leg = (n: number | null): CheckStatus => (n === null ? 'UNKNOWN' : n < MIN_CAGR_PCT ? 'FAIL' : 'PASS');
  const growth: CheckResult = {
    check: 'growth', threshold: `profit and sales 5Y CAGR ≥ ${MIN_CAGR_PCT}%`, ...up,
    status: combine([leg(i.profit5yCagrPct), leg(i.sales5yCagrPct)]),
    value: `profit ${pct(i.profit5yCagrPct)} · sales ${pct(i.sales5yCagrPct)}`,
  };

  // (a) An event already on file fails even when a stale backfill makes the status UNCHECKED.
  const g = i.governance;
  const govStatus: CheckStatus = g.events.length > 0 ? 'FAIL' : g.status === 'CLEAR' ? 'PASS' : 'UNKNOWN';
  const govText = g.events.length > 0 ? `governance: ${g.events.map((e) => `${e.kind} ${e.on}`).join(', ')}`
    : g.status === 'CLEAR' ? 'governance: clear' : 'governance: not checked';
  // (b) cfo < 70% of pat, in exact integers: Screener's ₹ Cr figures have two decimals and
  // float arithmetic misjudges an exact 70% (0.7 × 8.3 = 5.8100000000000005).
  // A loss over five years fails outright (controller ruling): the 70% rule means nothing there.
  const lossy = i.pat5y !== null && i.pat5y <= 0;
  const cash: CheckStatus = lossy ? 'FAIL' : i.cfo5y === null || i.pat5y === null ? 'UNKNOWN'
    : scaled(i.cfo5y) * 10n < scaled(i.pat5y) * 7n ? 'FAIL' : 'PASS';
  const cashText = lossy ? 'loss-making over 5 years (PAT 5y ≤ 0)'
    : cash === 'UNKNOWN' ? 'CFO/PAT 5Y unknown' : `CFO ${i.cfo5y} vs PAT ${i.pat5y} (5Y)`;
  // (c)
  const promoter: CheckStatus = i.promoterDropPp === null ? 'UNKNOWN' : i.promoterDropPp > MAX_PROMOTER_DROP_PP ? 'FAIL' : 'PASS';
  const promoterText = i.promoterDropPp === null ? 'promoter 1Y unknown: no reading ~1 year earlier' : `promoter drop ${i.promoterDropPp.toFixed(1)} pp/1Y`;
  const management: CheckResult = {
    check: 'management',
    threshold: `no governance event in 3Y · CFO ≥ 70% of PAT (5Y) · promoter drop ≤ ${MAX_PROMOTER_DROP_PP} pp/1Y`,
    asOf: i.uploadAsOf, source: `BSE filings + ${SCREENER}`,
    status: combine([govStatus, cash, promoter]),
    value: [govText, cashText, promoterText].join(' · '),
  };

  return [debt, pledge, { check: 'valuation', threshold: `≤ ${PE_MULTIPLE} × sector median`,
    asOf: i.close?.asOf ?? null, source: 'prices_eod close ÷ screener EPS', ...valuation(i) }, growth, management];
}

export function isPassed(qualityPassed: boolean, composite: number | null, checks: CheckResult[]): boolean {
  return qualityPassed && composite !== null && composite >= BANDS.high && checks.every((c) => c.status === 'PASS');
}

const parse = (d: string | Record<string, string>): Record<string, string> => (typeof d === 'string' ? JSON.parse(d) : d);

/**
 * Sector median P/E over every stock in the latest upload ≤ asOf (not the watchlist), each
 * P/E recomputed as the latest close ÷ uploaded EPS. Stale closes and EPS ≤ 0 are left out.
 */
export async function uploadSectorPe(db: Db, asOf: string): Promise<Map<string, { median: number; peers: number }>> {
  const rows = await db.query<{ sector: string; data: string | Record<string, string>; close: string }>(
    `with u as (select id from screener_uploads where as_of <= $1 order by as_of desc, id desc limit 1)
     select i.sector, f.data, p.close_paise::text as close
       from fundamentals f
       join u on u.id = f.upload_id
       join instruments i on i.id = f.instrument_id
       join lateral (select close_paise, trade_date from prices_eod
                      where instrument_id = f.instrument_id and trade_date <= $1
                      order by trade_date desc limit 1) p on true
      where i.sector is not null and p.trade_date >= $1::date - ${CLOSE_FRESH_DAYS}`,
    [asOf],
  );
  const bySector = new Map<string, number[]>();
  for (const r of rows) {
    const eps = rawNumber(parse(r.data), 'EPS');
    if (eps === null || eps <= 0) continue;
    bySector.set(r.sector, [...(bySector.get(r.sector) ?? []), Number(r.close) / 100 / eps]);
  }
  return new Map([...bySector].map(([s, pes]) => [s, { median: median(pes)!, peers: pes.length }]));
}

async function loadAll(db: Db, asOf: string, now: Date): Promise<(StockChecks & { governance: Governance })[]> {
  const scored = await db.query<{ id: string; name: string; sector: string | null; composite: string | number; quality_passed: boolean }>(
    `select s.instrument_id as id, i.name, i.sector, s.composite, s.quality_passed
       from signal_scores s join instruments i on i.id = s.instrument_id
      where s.score_date = (select max(score_date) from signal_scores where score_date <= $1)
      order by s.composite desc, s.instrument_id`,
    [asOf],
  );
  const sectorPe = await uploadSectorPe(db, asOf);
  const out: (StockChecks & { governance: Governance })[] = [];
  for (const s of scored) {
    const [f] = await db.query<{ data: string | Record<string, string>; de_ratio: string | number | null; as_of: string }>(
      `select f.data, f.de_ratio, u.as_of::text as as_of
         from fundamentals f join screener_uploads u on u.id = f.upload_id
        where f.instrument_id = $1 and u.as_of <= $2
        order by u.as_of desc, u.id desc limit 1`,
      [s.id, asOf],
    );
    const data = f ? parse(f.data) : null;
    let promoterDropPp: number | null = null;
    const chg = rawNumber(data, 'Promoter Chg 1Y');
    if (chg !== null) promoterDropPp = -chg;
    else if (f) {
      const [prior] = await db.query<{ data: string | Record<string, string> }>(
        `select f.data from fundamentals f join screener_uploads u on u.id = f.upload_id
          where f.instrument_id = $1 and u.as_of between $2::date - ${YEAR_AGO_MAX_DAYS} and $2::date - 365
          order by u.as_of desc, u.id desc limit 1`,
        [s.id, f.as_of],
      );
      const was = prior ? rawNumber(parse(prior.data), 'Promoter Holding') : null;
      const is = rawNumber(data, 'Promoter Holding');
      if (was !== null && is !== null) promoterDropPp = was - is;
    }
    const [c] = await db.query<{ close: string; on: string }>(
      `select close_paise::text as close, trade_date::text as on from prices_eod
        where instrument_id = $1 and trade_date <= $2 order by trade_date desc limit 1`,
      [s.id, asOf],
    );
    const governance = await governanceStatus(db, s.id, now);
    const checks = evaluateChecks({
      sector: s.sector,
      deRatio: f?.de_ratio == null ? null : Number(f.de_ratio),
      pledgedPct: rawNumber(data, 'Pledged %'),
      eps: rawNumber(data, 'EPS'),
      close: c ? { pricePaise: BigInt(c.close), asOf: c.on } : null,
      asOf,
      sectorPe: s.sector === null ? null : sectorPe.get(s.sector) ?? null,
      profit5yCagrPct: rawNumber(data, 'Profit 5Y CAGR') ?? rawNumber(data, 'Profit 5Y CAGR %'),
      sales5yCagrPct: rawNumber(data, 'Sales 5Y CAGR') ?? rawNumber(data, 'Sales 5Y CAGR %'),
      cfo5y: rawNumber(data, 'CFO 5Y'),
      pat5y: rawNumber(data, 'PAT 5Y'),
      promoterDropPp,
      governance,
      uploadAsOf: f?.as_of ?? null,
    });
    const composite = Number(s.composite);
    out.push({
      instrumentId: s.id, name: s.name, composite, qualityPassed: s.quality_passed, checks,
      passed: isPassed(s.quality_passed, composite, checks), governance,
    });
  }
  return out;
}

/** Every instrument in the latest signal_scores date ≤ asOf, composite descending. */
export async function loadStockChecks(db: Db, asOf: string, now: Date): Promise<StockChecks[]> {
  return (await loadAll(db, asOf, now)).map(({ governance: _g, ...s }) => s);
}

/**
 * HIGH-band, quality-passed stocks whose debt, pledge, valuation and growth checks pass but
 * whose governance record is UNCHECKED with no event on file — the ones worth a BSE backfill.
 */
export async function awaitingGovernance(db: Db, asOf: string, now: Date): Promise<string[]> {
  return (await loadAll(db, asOf, now))
    .filter((s) => s.qualityPassed && s.composite !== null && s.composite >= BANDS.high
      && s.checks.slice(0, 4).every((c) => c.status === 'PASS')
      && s.governance.status === 'UNCHECKED' && s.governance.events.length === 0)
    .map((s) => s.instrumentId);
}
