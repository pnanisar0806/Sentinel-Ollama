import { addP, formatInr, type Paise } from '../money/paise.js';
import { allocationDrift, type DriftRow } from './allocation.js';
import type { AssetClass, NetWorth, Position } from './networth.js';

/**
 * PRD §6.4 allocation engine: the monthly drift check (FR-13, ±band) expressed as a
 * *recommendation*, plus the April annual proposal. Money moves as a DIRECTION here —
 * turning one into an order is Phase 2 and needs fresh human approval either way.
 *
 * ── What the tax preference does, and what it does not ──────────────────────────────
 * It does ONE thing: it prefers routes that create no taxable event. New money first
 * (a SIP redirection or fresh surplus dilutes an overweight class without selling
 * anything), and only when no route can absorb the drift does it propose a trim. When a
 * trim is unavoidable, sale candidates are ordered losses first (a harvest offsets gains
 * elsewhere), then smallest gain, and an unknown cost basis last because its tax is
 * unknowable from our data (FR-02: never inferred).
 *
 * It is NOT a tax engine. It does not compute LTCG/STCG holding periods, the §112A
 * ₹1.25L exemption, indexation, set-off or carry-forward rules, surcharge, or the tax
 * on a specific lot — we hold aggregated positions, not per-lot acquisition dates, so
 * any number it produced would be invented. Every trim it proposes is flagged for the
 * owner to price with his own CA.
 */
export const TAX_POLICY_NOTE =
  'Tax preference: routes that create no taxable event come first; a trim is a last ' +
  'resort, ordered losses-first. This does not compute holding periods, LTCG/STCG, the ' +
  '§112A exemption, indexation or set-off — price any sale with your CA before acting.';

const NO_REALISATION_NOTE =
  'Directing new money rather than selling: no taxable event, no realisation.';

/** PRD §3.3 is the only clause an allocation move can cite. */
const ALLOCATION_CLAUSE = '3.3';

type RebalanceDirection = 'in-band' | 'add' | 'reduce' | 'mixed';

export interface FundingRoute {
  id: string;
  kind: 'sip' | 'fresh-surplus';
  /** Where this money can go. */
  assetClass: AssetClass;
  monthlyCapacityPaise: Paise;
  /** An exit/entry load makes "free" redirection untrue; recorded, not silently assumed. */
  loadFree: boolean;
  note?: string;
}

export interface CandidateAction {
  kind: 'ADD' | 'TRIM' | 'DIRECT_FLOW';
  assetClass: AssetClass;
  amountPaise: Paise;
  route: 'sip' | 'fresh-surplus' | 'sell';
  /** The holding to trim, or the instrument to add to. Absent only when nothing fits. */
  instrumentId?: string;
  /** For a TRIM: where the proceeds go. A sale never leaves idle cash unnamed. */
  proceedsTo?: { assetClass: AssetClass; instrumentId: string | null };
  taxNote: string;
  rationale: string;
}

export interface AllocationState {
  /** Quality score per instrument (signal composite / fund score), weakest sold first. */
  quality?: ReadonlyMap<string, number>;
  /** The Phase 0 net worth — the single basis. Never recomputed here. */
  netWorth: NetWorth;
  positions: Position[];
  routes?: FundingRoute[];
}

interface RebalanceRec {
  monthYear: string;
  /** True in April: India's fiscal year start, the FR-13 annual proposal. */
  annual: boolean;
  direction: RebalanceDirection;
  drift: DriftRow[];
  actions: CandidateAction[];
  taxNotes: string[];
  ipsClauseRefs: string[];
  summary: string;
}

/**
 * EPF is mandatory payroll ballast the owner adds nothing to and cannot withdraw from
 * (owner decision 2026-08-23): it is 68.7% of the debt bucket, so any debt move that
 * touched it would really be an EPF move. It is never a target, in either direction.
 *
 * The Kolkata property needs no exclusion: it is a liability line (the SBI home loan),
 * never a position, so it cannot reach this function at all.
 */
export function isRebalanceTarget(p: Position): boolean {
  return p.kind !== 'EPF';
}

/**
 * Sale candidates within one asset class. With quality scores (owner, 2026-09-27): the
 * weakest holding first, scored names before unscored ones (a name that cannot be judged
 * is not sold on a guess), and tax only to break ties. Without scores: cheapest-to-sell
 * in tax terms — unrealised losses, then the smallest gains, then unknown cost basis.
 */
export function sellCandidates(
  positions: readonly Position[], assetClass: AssetClass, quality?: ReadonlyMap<string, number>,
): Position[] {
  const tax = (p: Position): number => {
    if (p.avgCostPaise === null) return Number.POSITIVE_INFINITY;
    return Number(p.valuePaise - p.avgCostPaise);
  };
  const score = (p: Position): number => quality?.get(p.instrumentId) ?? Number.POSITIVE_INFINITY;
  return positions
    .filter((p) => p.assetClass === assetClass && isRebalanceTarget(p))
    .sort((a, b) => score(a) - score(b) || tax(a) - tax(b) || a.instrumentId.localeCompare(b.instrumentId));
}

/**
 * No sale for an overshoot smaller than this (owner, 2026-09-27): 2 percentage points of
 * the portfolio. New money closes it; a sale would realise tax and pay brokerage for
 * nothing a month of surplus cannot do.
 */
export const SELL_TOLERANCE = 0.02;
/** Beyond the tolerance, still prefer new money if it closes the gap within this many months. */
const FLOW_HORIZON_MONTHS = 12n;

/**
 * What to BUY when an asset class is under its floor.
 *
 * The rebalance engine said "BUY GOLD ₹2.17L" and named no instrument, so the
 * recommendation could never become an order. The choice follows the owner's standing
 * rules rather than a search:
 *
 * - **Add to what is already held** ("prefer adding to conviction over rotating between
 *   names") — the largest existing holding in the class.
 * - **EQUITY goes to the core** (IPS §3.4: core is ≥75% of equity flows, index
 *   instruments). A rebalance top-up is a core flow, never a satellite stock pick; those
 *   come only from the satellite engine with a thesis. So only index-like holdings count.
 * - Instruments that cannot take money are skipped: EPF (payroll-only) and bonds (a
 *   primary issue is not a top-up).
 * - When nothing suitable is held, the plain index ETF for the class, so the result is
 *   an instrument that exists rather than a gap.
 */
const CORE_EQUITY = /index|nifty|bees|sensex/i;
const NOT_TOP_UPPABLE = new Set(['EPF', 'BOND', 'CASH', 'RSU']);
export const DEFAULT_ADD_INSTRUMENT: Partial<Record<AssetClass, string>> = {
  EQUITY: 'NSE:NIFTYBEES',
  GOLD: 'NSE:GOLDBEES',
  DEBT: 'NSE:LIQUIDBEES',
};

export function addTarget(positions: readonly Position[], assetClass: AssetClass): string | null {
  const held = positions
    .filter((p) => p.assetClass === assetClass && !NOT_TOP_UPPABLE.has(p.kind))
    .filter((p) => assetClass !== 'EQUITY' || CORE_EQUITY.test(`${p.instrumentId} ${p.name}`))
    .sort((a, b) => (b.valuePaise > a.valuePaise ? 1 : b.valuePaise < a.valuePaise ? -1 : 0)
      || a.instrumentId.localeCompare(b.instrumentId));
  return held[0]?.instrumentId ?? DEFAULT_ADD_INSTRUMENT[assetClass] ?? null;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

function capacityFor(routes: readonly FundingRoute[], assetClass: AssetClass): Paise {
  const usable = routes.filter((r) => r.assetClass === assetClass && r.loadFree);
  return usable.length === 0
    ? (0n as Paise)
    : addP(...usable.map((r) => r.monthlyCapacityPaise));
}

/** Routes into anything other than the overweight class dilute it without a sale. */
function dilutionRoutes(routes: readonly FundingRoute[], overweight: AssetClass): FundingRoute[] {
  return routes.filter((r) => r.assetClass !== overweight && r.loadFree && r.monthlyCapacityPaise > 0n);
}

/**
 * Where new money or sale proceeds should go when `overweight` is over its ceiling: a
 * class under its floor first (the furthest under), otherwise the class furthest below the
 * middle of its band. EQUITY is never the destination of money taken out of equity.
 */
function destinationFor(drift: readonly DriftRow[], overweight: AssetClass): AssetClass {
  const others = drift.filter((d) => d.assetClass !== overweight && d.assetClass !== 'CASH');
  const under = others.filter((d) => d.breach === 'UNDER').sort((a, b) => (a.actual - a.min) - (b.actual - b.min));
  if (under.length > 0) return under[0]!.assetClass;
  const byRoom = [...others].sort((a, b) => (a.actual - (a.min + a.max) / 2) - (b.actual - (b.min + b.max) / 2));
  return byRoom[0]?.assetClass ?? 'DEBT';
}

function trimActions(
  state: AllocationState, row: DriftRow, proceedsTo: { assetClass: AssetClass; instrumentId: string | null },
): CandidateAction[] {
  const actions: CandidateAction[] = [];
  let remaining = row.driftPaise;

  for (const p of sellCandidates(state.positions, row.assetClass, state.quality)) {
    if (remaining <= 0n) break;
    // Never past the band edge: the last slice is capped at what is still over.
    const amount = (p.valuePaise < remaining ? p.valuePaise : remaining) as Paise;
    const gain = p.avgCostPaise === null ? null : p.valuePaise - p.avgCostPaise;
    actions.push({
      kind: 'TRIM',
      assetClass: row.assetClass,
      amountPaise: amount,
      route: 'sell',
      instrumentId: p.instrumentId,
      taxNote:
        gain === null
          ? 'cost basis unknown — the tax on this sale cannot be estimated from our data (FR-02)'
          : gain < 0n
            ? `unrealised loss ${formatInr((0n - gain) as Paise)} — harvestable against gains elsewhere`
            : `unrealised gain ${formatInr(gain as Paise)} — realising it is a taxable event`,
      proceedsTo,
      rationale: `${row.assetClass} is ${pct(row.actual)} against a ${pct(row.max)} ceiling (IPS §${ALLOCATION_CLAUSE}), `
        + `more than new money can close within ${FLOW_HORIZON_MONTHS} months; the proceeds go into ${proceedsTo.assetClass}`
        + `${proceedsTo.instrumentId ? ` (${proceedsTo.instrumentId})` : ''}, not idle cash`,
    });
    remaining = (remaining - amount) as Paise;
  }

  return actions;
}

/**
 * Turns the monthly drift check into a recommendation for `monthYear` ('YYYY-MM').
 *
 * `state.netWorth` is the basis; the positions are only used to name candidates. A state
 * whose two halves disagree is a bug in the caller, not something to average over —
 * `allocationDrift` takes the same stance on an inconsistent total.
 */
export function rebalanceRec(state: AllocationState, monthYear: string): RebalanceRec {
  const positionsTotal = addP(...state.positions.map((p) => p.valuePaise));
  if (positionsTotal !== state.netWorth.assetsPaise) {
    throw new Error(
      `rebalanceRec: net worth ${state.netWorth.assetsPaise} disagrees with the positions, which sum to ${positionsTotal}`,
    );
  }

  const routes = state.routes ?? [];
  const drift = allocationDrift(state.netWorth.byAssetClass);
  const breaches = drift.filter((d) => d.breach !== null);
  const annual = monthYear.slice(5, 7) === '04';
  const taxNotes: string[] = [TAX_POLICY_NOTE];
  const actions: CandidateAction[] = [];

  for (const row of breaches) {
    if (row.breach === 'UNDER') {
      const capacity = capacityFor(routes, row.assetClass);
      const target = addTarget(state.positions, row.assetClass);
      actions.push({
        kind: 'ADD',
        assetClass: row.assetClass,
        amountPaise: row.driftPaise,
        ...(target !== null ? { instrumentId: target } : {}),
        route: routes.find((r) => r.assetClass === row.assetClass && r.loadFree)?.kind ?? 'fresh-surplus',
        taxNote: NO_REALISATION_NOTE,
        rationale:
          `${row.assetClass} is ${pct(row.actual)} against a ${pct(row.min)} floor (IPS §${ALLOCATION_CLAUSE}); ` +
          (capacity > 0n
            ? `fund it from the existing route (${formatInr(capacity)}/month of capacity)`
            : 'no load-free route is configured — this needs fresh money, not a sale'),
      });
      continue;
    }

    // OVER: dilute with new money before selling anything (owner, 2026-09-27).
    //  - Under SELL_TOLERANCE over the ceiling: never a sale, route or no route.
    //  - Beyond it: new money still, if it closes the gap within FLOW_HORIZON_MONTHS.
    //  - Only then a trim, which names where the proceeds go.
    // New money goes to the class that needs it most, not merely the first route listed.
    const dest = destinationFor(drift, row.assetClass);
    const dilution = dilutionRoutes(routes, row.assetClass)
      .sort((a, b) => Number(b.assetClass === dest) - Number(a.assetClass === dest));
    // SIPs are separate money and add up; the monthly surplus is one pool that could go to
    // any class, so it counts once (its largest offer), never once per class.
    const sip = dilution.filter((r) => r.kind === 'sip').reduce((sum, r) => sum + r.monthlyCapacityPaise, 0n);
    const surplus = dilution.filter((r) => r.kind === 'fresh-surplus').reduce((m, r) => (r.monthlyCapacityPaise > m ? r.monthlyCapacityPaise : m), 0n);
    const capacity = sip + surplus;
    const withinTolerance = row.actual - row.max < SELL_TOLERANCE;
    const flowCloses = capacity > 0n && row.driftPaise <= capacity * FLOW_HORIZON_MONTHS;
    if (withinTolerance || flowCloses) {
      const target = dilution[0];
      const toClass = target?.assetClass ?? dest;
      actions.push({
        kind: 'DIRECT_FLOW',
        assetClass: toClass,
        amountPaise: row.driftPaise,
        route: target?.kind ?? 'fresh-surplus',
        taxNote: NO_REALISATION_NOTE,
        rationale:
          `${row.assetClass} is ${pct(row.actual)} against a ${pct(row.max)} ceiling (IPS §${ALLOCATION_CLAUSE}); ` +
          (withinTolerance
            ? `an overshoot under ${Math.round(SELL_TOLERANCE * 100)} points is closed by sending new money into ${toClass}, not by selling`
            : `sending new money into ${toClass} closes the gap within ${FLOW_HORIZON_MONTHS} months without a sale`),
      });
      taxNotes.push(NO_REALISATION_NOTE);
      continue;
    }
    actions.push(...trimActions(state, row, { assetClass: dest, instrumentId: addTarget(state.positions, dest) }));
  }

  const hasAdd = actions.some((a) => a.kind === 'ADD');
  const hasReduce = actions.some((a) => a.kind === 'TRIM' || a.kind === 'DIRECT_FLOW');
  const direction: RebalanceDirection =
    actions.length === 0 ? 'in-band' : hasAdd && hasReduce ? 'mixed' : hasAdd ? 'add' : 'reduce';

  const shape = drift.map((d) => `${d.assetClass} ${pct(d.actual)}`).join(' · ');
  const summary =
    direction === 'in-band'
      ? `${annual ? 'Annual (April) review' : 'Monthly drift check'} ${monthYear}: in-band. ${shape}.`
      : `${annual ? 'Annual (April) rebalance proposal' : 'Monthly drift check'} ${monthYear}: ` +
        `${breaches.map((b) => `${b.assetClass} ${b.breach} by ${formatInr(b.driftPaise)}`).join('; ')}. ${shape}.`;

  return {
    monthYear,
    annual,
    direction,
    drift,
    actions,
    taxNotes,
    ipsClauseRefs: [ALLOCATION_CLAUSE],
    summary,
  };
}
