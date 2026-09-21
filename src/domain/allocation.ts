import { addP, mulP, pctOf, subP, type Paise } from '../money/paise.js';
import type { AssetClass, Position } from './networth.js';

/**
 * PRD §3.3 strategic allocation — **only the rails the PRD actually states**.
 *
 * §3.3 in full: "Equity ceiling ~60% ... Gold: 5–10% band ... Debt/EPF/cash: remainder;
 * EPF counts as debt-like." A remainder is an identity, not a band, so debt and cash
 * carry no bound here. The earlier `DEBT.min = 0.25` and `CASH.max = 0.20` were
 * invented, and the PRD preamble binds every recommendation to "cite the IPS clause(s)
 * it serves" — a breach of an invented band can cite nothing.
 *
 * The debt floor was also actively wrong for this owner: EPF is 68.7% of the debt
 * bucket and is passive, so a debt-percentage floor is really an EPF floor. His only
 * CHOSEN debt is bonds (₹6.16L, 12.9%, halving when Sammaan matures 26-Sep-2026), so a
 * 25% floor would have nagged him permanently to buy debt he has decided against.
 *
 * The cash ceiling survives as an OWNER rail — see `src/domain/rails.ts`.
 */
export const IPS_BANDS: Record<AssetClass, { min: number; max: number }> = {
  EQUITY: { min: 0.00, max: 0.60 }, // PRD §3.3, verbatim
  GOLD: { min: 0.05, max: 0.10 },   // PRD §3.3, verbatim
  DEBT: { min: 0.00, max: 1.00 },   // "remainder" — unbounded by design
  CASH: { min: 0.00, max: 1.00 },   // "remainder" — see rails.ts for the owner ceiling
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
 * TODO(Task 11B): the INDmoney sync supplies sectors for the rest.
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

/** IPS §3.4: the satellite bucket is capped at 25% of equity. */
export const SATELLITE_CAP_PCT = 25;

export interface SatelliteFit {
  /** Room left under the §3.4 cap. 0n when the bucket is full or over. */
  headroomPaise: Paise;
  /** Share of the whole portfolio per sector, percent. Sectorless positions are absent. */
  sectorWeightPct: Record<string, number>;
}

/**
 * The `fit` inputs the satellite engine scores against.
 *
 * `report.ts` passed `headroomPaise: 0n` and `sectorWeightPct: {}` as literals, so the
 * headroom half of `fit` scored 0 for every candidate and the balance half scored a full
 * 10 for every candidate, on every run. Twenty of the composite's hundred points said
 * nothing about the name being scored: one half pinned to the floor, one to the ceiling.
 *
 * **Satellite is agent-recommended DIRECT stocks** (IPS §3.4, core-satellite 75/25).
 * `kind === 'EQUITY'` is that set. The employer RSU is `kind === 'RSU'`: it counts toward
 * equity, because it is equity, but never toward the satellite bucket — it is neither
 * agent-recommended nor sellable at will, and counting it would consume the whole bucket
 * on a position the advisor did not choose.
 *
 * Sector weights are a share of the WHOLE portfolio, matching how `CAPS.sectorCap` is
 * applied in `concentration`. A position with no sector is left out rather than pooled
 * into an "unknown" bucket, which would compete against real sectors for the cap and
 * read as a genuine concentration.
 */
export function satelliteFit(positions: Position[]): SatelliteFit {
  const sum = (rows: Position[]): bigint => rows.reduce((a, p) => a + p.valuePaise, 0n);

  const equityPaise = sum(positions.filter((p) => p.assetClass === 'EQUITY'));
  const satellitePaise = sum(positions.filter((p) => p.kind === 'EQUITY'));
  const allowed = (equityPaise * BigInt(SATELLITE_CAP_PCT)) / 100n;
  const headroomPaise = allowed > satellitePaise ? allowed - satellitePaise : 0n;

  const total = sum(positions);
  const sectorWeightPct: Record<string, number> = {};
  if (total > 0n) {
    for (const p of positions) {
      if (p.sector === null) continue;
      sectorWeightPct[p.sector] = (sectorWeightPct[p.sector] ?? 0) + Number(p.valuePaise);
    }
    for (const k of Object.keys(sectorWeightPct)) {
      sectorWeightPct[k] = Math.round((sectorWeightPct[k]! / Number(total)) * 1000) / 10;
    }
  }
  return { headroomPaise: headroomPaise as Paise, sectorWeightPct };
}
