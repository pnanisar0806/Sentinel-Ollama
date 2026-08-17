import { addP, mulP, pctOf, subP, type Paise } from '../money/paise.js';
import type { AssetClass, Position } from './networth.js';

/**
 * PRD 3.3 strategic allocation. Equity is a ceiling; gold is a band.
 *
 * NOTE: `DEBT.min = 0.25` comes from the plan's snippet, not from any PRD text held in
 * this repo — PRD 3.3 verbatim is still outstanding (it blocks Task 13 too). It means a
 * portfolio holding no debt reports an UNDER breach, which is a defensible reading of
 * "remainder debt/cash" but is not verified. Flagged as an owner true-up in MEMORY.md.
 */
export const IPS_BANDS: Record<AssetClass, { min: number; max: number }> = {
  EQUITY: { min: 0.00, max: 0.60 },
  GOLD: { min: 0.05, max: 0.10 },
  DEBT: { min: 0.25, max: 1.00 },
  CASH: { min: 0.00, max: 0.20 },
};

/** PRD 3.5 hard concentration caps. Every one of these is enforced by `concentration`. */
export const CAPS = {
  singleStock: 0.10,
  singleIssuer: 0.10,
  singleMfScheme: 0.35,
  singleSector: 0.25,
  employer: 0.10,
} as const;

/**
 * Emitted whenever part of the portfolio carries no `instruments.sector`, because the
 * single-sector cap can only see the part that does. Today's seed sectors only US:NOW
 * and NSE:RPOWER (~10.5% of value), so the cap is close to unevaluated.
 * TODO(Task 11B): the INDmoney/Kite sync supplies sectors for the rest.
 */
export const SECTOR_COVERAGE_CAVEAT =
  'SECTOR_COVERAGE: the single-sector cap was evaluated over only the part of the ' +
  'portfolio that carries a sector; instruments without one are invisible to it';

const ALL_CLASSES: AssetClass[] = ['CASH', 'DEBT', 'EQUITY', 'GOLD'];

export interface DriftRow {
  assetClass: AssetClass;
  actual: number;
  min: number;
  max: number;
  breach: 'OVER' | 'UNDER' | null;
  /** Money that would have to move to return to the nearest band edge. */
  driftPaise: Paise;
}

/**
 * `total` is optional and derived from the map when omitted. When supplied it must agree
 * with the map: two independent arguments describing one portfolio let a caller pass an
 * inconsistent pair and get silently wrong percentages back.
 */
export function allocationDrift(
  byAssetClass: Map<AssetClass, Paise>,
  total?: Paise,
): DriftRow[] {
  const summed = addP(...byAssetClass.values());
  if (total !== undefined && total !== summed) {
    throw new Error(
      `allocationDrift: total ${total} disagrees with the asset-class map, which sums to ${summed}`,
    );
  }
  const whole = total ?? summed;

  return ALL_CLASSES.map((assetClass) => {
    const value = byAssetClass.get(assetClass) ?? (0n as Paise);
    const actual = pctOf(value, whole);
    const { min, max } = IPS_BANDS[assetClass];
    const breach: DriftRow['breach'] = actual > max ? 'OVER' : actual < min ? 'UNDER' : null;
    if (breach === null) {
      return { assetClass, actual, min, max, breach, driftPaise: 0n as Paise };
    }
    // The band edge is a rate, the portfolio is money: go through mulP's integer micros
    // rather than Number(total) * pct, which is a float round-trip over paise.
    const target = mulP(whole, breach === 'OVER' ? max : min);
    const driftPaise = value > target ? subP(value, target) : subP(target, value);
    return { assetClass, actual, min, max, breach, driftPaise };
  }).sort((a, b) => a.assetClass.localeCompare(b.assetClass));
}

/**
 * Index funds and ETFs are pooled vehicles, exempt from the single-stock cap.
 *
 * TODO(Task 11B): two seeded holdings are single EQUITY lines that are really baskets —
 * `NSE:SMALLCASE-RESIDUE` (a smallcase's unallocated remainder) and `US:INDMONEY-BASKET`
 * (six US tickers). Until the sync decomposes them into their constituents the residue
 * reports as a 13.7% single-stock breach. That is the model faithfully reporting the data
 * it has; the fix is better data, not an exemption list.
 */
const isDirectStock = (p: Position): boolean => p.kind === 'EQUITY' || p.kind === 'RSU';

const sumBy = (positions: Position[], key: (p: Position) => string | null): Map<string, Paise> => {
  const out = new Map<string, Paise>();
  for (const p of positions) {
    const k = key(p);
    if (k === null) continue;
    out.set(k, addP(out.get(k) ?? (0n as Paise), p.valuePaise));
  }
  return out;
};

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export interface Concentration {
  topStockPct: number;
  employerPct: number;
  byStock: Map<string, number>;
  byIssuer: Map<string, number>;
  byMfScheme: Map<string, number>;
  bySector: Map<string, number>;
  /** Share of portfolio value that carries a sector — how much the sector cap can see. */
  sectorCoveragePct: number;
  breaches: string[];
  caveats: string[];
}

export function concentration(positions: Position[]): Concentration {
  const total = addP(...positions.map((p) => p.valuePaise));
  const breaches: string[] = [];
  const caveats: string[] = [];

  /** Aggregate by instrument/issuer/scheme/sector BEFORE comparing to a cap: the same
   *  company held in two accounts is one exposure, not two sub-cap ones. */
  const rate = (values: Map<string, Paise>): Map<string, number> =>
    new Map([...values].map(([k, v]) => [k, pctOf(v, total)]));

  const byStock = rate(sumBy(positions, (p) => (isDirectStock(p) ? p.instrumentId : null)));
  const topStockPct = [...byStock.values()].reduce((m, p) => Math.max(m, p), 0);
  for (const [id, p] of byStock) {
    if (p > CAPS.singleStock) {
      breaches.push(`Single-stock cap: ${id} at ${pct(p)} (cap ${pct(CAPS.singleStock)})`);
    }
  }

  const employerIds = [...new Set(positions.filter((p) => p.isEmployer).map((p) => p.instrumentId))];
  const employerValue = addP(...positions.filter((p) => p.isEmployer).map((p) => p.valuePaise));
  const employerPct = pctOf(employerValue, total);
  if (employerPct > CAPS.employer) {
    breaches.push(
      `Employer cap: ${employerIds.join(', ')} at ${pct(employerPct)} (cap ${pct(CAPS.employer)})`,
    );
  }

  const byIssuer = rate(sumBy(positions, (p) => p.issuer));
  for (const [issuer, p] of byIssuer) {
    if (p > CAPS.singleIssuer) {
      breaches.push(`Single-issuer cap: ${issuer} at ${pct(p)} (cap ${pct(CAPS.singleIssuer)})`);
    }
  }

  const byMfScheme = rate(sumBy(positions, (p) => (p.kind === 'MF' ? p.instrumentId : null)));
  for (const [id, p] of byMfScheme) {
    if (p > CAPS.singleMfScheme) {
      breaches.push(`Single-MF-scheme cap: ${id} at ${pct(p)} (cap ${pct(CAPS.singleMfScheme)})`);
    }
  }

  const sectorValues = sumBy(positions, (p) => p.sector);
  const bySector = rate(sectorValues);
  for (const [sector, p] of bySector) {
    if (p > CAPS.singleSector) {
      breaches.push(`Single-sector cap: ${sector} at ${pct(p)} (cap ${pct(CAPS.singleSector)})`);
    }
  }
  const sectorCoveragePct = pctOf(addP(...sectorValues.values()), total);
  if (positions.length > 0 && sectorCoveragePct < 1) caveats.push(SECTOR_COVERAGE_CAVEAT);

  return {
    topStockPct, employerPct, byStock, byIssuer, byMfScheme, bySector,
    sectorCoveragePct, breaches, caveats,
  };
}
