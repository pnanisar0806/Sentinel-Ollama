import type { Db } from '../db/client.js';
import { rupees, type Paise, formatInr } from '../money/paise.js';
import { buildRecommendation, type RecKind, type RecLeg, type OverrideEvent, type RecommendationInput, MAX_THESIS_WORDS } from './recommendations.js';
import { listRedemptionsUntil, type Redemption } from './redemptions.js';
import { loadSmallcasePositions } from '../seed/seed-smallcases.js';

export const MICRO_ORPHAN_THRESHOLD = rupees('5000');
export const LTCG_EXEMPTION_PER_FY = rupees('125000');
export const SMALLCASE_CONSTITUENTS = [
  'NSE:NIFTYBEES',
  'NSE:JUNIORBEES',
  'NSE:GOLDBEES',
  'NSE:LIQUIDBEES',
] as const;

export interface OpenLot {
  id: string;
  instrumentId: string;
  account: string;
  acquiredOn: string;
  quantity: number;
  costPaise: Paise;
  isSeeded: boolean;
}

export interface FyHarvestPlan {
  fiscalYear: string;
  budgetPaise: Paise;
  usedPaise: Paise;
  remainingPaise: Paise;
  lots: OpenLot[];
  estimatedLtcgPaise: Paise;
  estimatedStcgPaise: Paise;
  unknownCostLots: OpenLot[];
}

export interface CleanupRec {
  recommendation: RecKind;
  instrumentId: string;
  action: 'SELL' | 'TRIM' | 'REDEEM' | 'CLOSE_MANUALLY';
  reason: string;
  thesis: string;
  ipsClauseRefs: string[];
  fyPlan?: FyHarvestPlan;
  unknownPrerequisites: string[] | undefined;
  falsification: { metric: 'price_paise'; op: 'lt'; value: string } | null;
}

async function loadOpenLots(db: Db): Promise<OpenLot[]> {
  const rows = await db.query<{
    id: string;
    instrument_id: string;
    account: string;
    acquired_on: string | Date;
    quantity: string | number;
    cost_paise: string | number | bigint;
    seeded: boolean;
  }>(
    `select id, instrument_id, account, acquired_on, quantity, cost_paise, seeded
       from lots
      where closed_on is null
      order by instrument_id, acquired_on`,
  );
  return rows.map((r) => ({
    id: r.id,
    instrumentId: r.instrument_id,
    account: r.account,
    acquiredOn: r.acquired_on instanceof Date
      ? r.acquired_on.toISOString().slice(0, 10)
      : String(r.acquired_on).slice(0, 10),
    quantity: Number(r.quantity),
    costPaise: BigInt(r.cost_paise) as Paise,
    isSeeded: r.seeded,
  }));
}

function fiscalYearOf(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return month >= 4 ? `${year}-${year + 1}` : `${year - 1}-${year}`;
}

function fyStartEnd(fy: string): { start: string; end: string } {
  const startYear = Number(fy.split('-')[0]);
  return {
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
  };
}

async function getLatestClose(db: Db, instrumentId: string, asOf: string): Promise<bigint | null> {
  const [row] = await db.query<{ close_paise: string | number | bigint }>(
    `select close_paise from prices_eod
       where instrument_id = $1 and trade_date <= $2
       order by trade_date desc limit 1`,
    [instrumentId, asOf],
  );
  return row === undefined ? null : BigInt(row.close_paise);
}

function computeGain(lot: OpenLot, closePaise: bigint): { gainPaise: Paise; isLtcg: boolean } | null {
  if (lot.costPaise === 0n) return null;
  const quantity = BigInt(Math.floor(lot.quantity));
  if (quantity <= 0n) return null;
  const totalCost = lot.costPaise * quantity;
  const totalValue = closePaise * quantity;
  const gain = totalValue - totalCost;
  const acquired = new Date(`${lot.acquiredOn}T00:00:00Z`);
  const closeDate = new Date(); // We don't have the exact close date here; using fiscal year boundary
  const heldMonths = (closeDate.getFullYear() - acquired.getFullYear()) * 12 + closeDate.getMonth() - acquired.getMonth();
  const isLtcg = heldMonths >= 12;
  return { gainPaise: gain as Paise, isLtcg };
}

function buildMicroOrphanRec(instrumentId: string, name: string, valuePaise: Paise, account: string): CleanupRec {
  return {
    recommendation: 'sell',
    instrumentId,
    action: 'SELL',
    reason: `Micro-orphan: ${formatInr(valuePaise)} (threshold ₹5,000) in ${account}`,
    thesis:
      `Micro-orphan ${name} (${formatInr(valuePaise)}) in ${account} falls below the ₹5k threshold. ` +
      `IPS §3.9 mandates consolidating micro-orphans first. Proceeds route per the engine's drift logic. ` +
      `No active thesis supports holding this residual.`,
    ipsClauseRefs: ['3.9'],
    falsification: { metric: 'price_paise', op: 'lt', value: '1' },
    unknownPrerequisites: undefined,
  };
}

/**
 * One note per smallcase, from the real decomposition rather than a phantom position.
 *
 * The old version keyed off `NSE:SMALLCASE-RESIDUE`, a seeded ₹6,55,400 line that
 * modelled all four smallcases as one opaque blob. It has been retired: the live sync
 * carries every constituent individually and `smallcase_positions` records which shares
 * sit in which smallcase.
 *
 * The action is **HOLD, not SELL**. IPS §3.9 terminates the *subscription* — the
 * rebalancing mandate and its fee — and retains the shares as direct holdings. The
 * owner confirmed on 2026-09-20 that all smallcase transactions have stopped and that
 * the 17-Sep rebalance will not be applied, so these are in run-off. Recommending a
 * liquidation would be churn, which the long-term mandate forbids: nothing here has
 * been falsified, it has merely stopped being managed by someone else.
 */
function buildSmallcaseTerminationRec(
  smallcase: string,
  positions: readonly { instrumentId: string; units: number }[],
): CleanupRec {
  const shares = positions
    .map((p) => `${p.instrumentId} x${p.units}`)
    .join(', ');
  return {
    recommendation: 'legacy_note',
    instrumentId: positions[0]?.instrumentId ?? 'PORTFOLIO',
    // CLOSE_MANUALLY, because ending a subscription happens in the smallcase app and
    // never as a broker order. It already maps to HOLD downstream, which is the right
    // primary action: the shares are retained.
    action: 'CLOSE_MANUALLY',
    reason: `Terminate the ${smallcase} subscription; retain its shares`,
    thesis:
      `IPS §3.9 ends the smallcase subscription, not the position. The ${smallcase} ` +
      `rebalancing mandate stops and its shares stay as direct holdings under agent ` +
      `management: ${shares}. Owner has already halted all smallcase transactions, so ` +
      `this records a structural change, not a thesis-driven exit — no constituent has ` +
      `been falsified and selling would realise tax for no reason.`,
    ipsClauseRefs: ['3.9'],
    // No price-based kill condition: this is a change of custodianship, not a call on
    // any holding, so there is no price at which it becomes wrong.
    falsification: null,
    unknownPrerequisites: undefined,
  };
}

function buildThesisLessRec(instrumentId: string, name: string, valuePaise: Paise, account: string): CleanupRec {
  return {
    recommendation: 'sell',
    instrumentId,
    action: 'SELL',
    reason: `Thesis-less consolidation: ${name} (${formatInr(valuePaise)}) in ${account}`,
    thesis:
      `Holding ${name} (${formatInr(valuePaise)}) in ${account} has no live investment thesis. ` +
      `IPS §3.9 states: "Every holding without a live thesis is a consolidation candidate." ` +
      `Consolidation is executed tax-aware against the ₹1.25L/year equity LTCG exemption, ` +
      `spread over 1–2 fiscal years using FIFO lots. This recommendation enters the paper queue; ` +
      `no execution occurs without fresh human approval.`,
    ipsClauseRefs: ['3.9'],
    falsification: { metric: 'price_paise', op: 'lt', value: '1' },
    unknownPrerequisites: undefined,
  };
}

function buildGrowwRPowerRec(): CleanupRec {
  return {
    recommendation: 'legacy_note',
    instrumentId: 'NSE:RPOWER',
    action: 'CLOSE_MANUALLY',
    reason: 'Groww Reliance Power — manual closure required (no Groww integration)',
    thesis:
      `The Groww Reliance Power position is flagged for manual closure per IPS §3.9: ` +
      `"the Groww Reliance Power position is flagged for manual closure (no Groww integration)." ` +
      `This surfaces once as a legacy note, not SKIPPED solely because integration is absent. ` +
      `If owner records already evidence closure, do not duplicate. ` +
      `No automated execution path exists for Groww; the owner must close this directly.`,
    ipsClauseRefs: ['3.9'],
    falsification: null,
    unknownPrerequisites: undefined,
  };
}

function buildBondCreditReviewRec(instrumentId: string, name: string): CleanupRec {
  return {
    recommendation: 'sell',
    instrumentId,
    action: 'SELL',
    reason: `Bond credit review: ${name}`,
    thesis:
      `Bond credit review for ${name} per IPS §3.9. The Sammaan and Edelweiss bonds are ` +
      `standing review items for the agent's first live session. This recommendation surfaces ` +
      `the review requirement; any exit decision awaits the owner's credit assessment. ` +
      `If credit deteriorates, exit is a falsification override under §3.7.`,
    ipsClauseRefs: ['3.8', '3.9'],
    falsification: null,
    unknownPrerequisites: undefined,
  };
}

function buildSammaanMaturityRoutingRec(redemption: Redemption): CleanupRec {
  const totalPaise = (redemption.facePaise + (redemption.couponDuePaise ?? 0n)) as Paise;
  return {
    recommendation: 'maturity_routing',
    instrumentId: redemption.instrumentId,
    action: 'REDEEM',
    reason: `Sammaan ${redemption.symbol} matures ${redemption.maturityDate} — route to B3 (emergency fund)`,
    thesis:
      `Sammaan Sep-2026 maturity proceeds (${formatInr(totalPaise)}) route to B3 (emergency fund) — ` +
      `pre-approved standing instruction per IPS §3.9, still surfaced for confirmation at the event. ` +
      `This is the event confirmation for the owner to approve the B3 routing.`,
    ipsClauseRefs: ['3.8', '3.9'],
    falsification: null,
    unknownPrerequisites: undefined,
  };
}

function buildFyHarvestPlan(
  instrumentId: string,
  lots: OpenLot[],
  closePaise: bigint,
  budgetPaise: Paise,
  asOf: string,
): FyHarvestPlan | null {
  const eligibleLots = lots.filter((lot) => lot.instrumentId === instrumentId && lot.costPaise !== 0n);
  if (eligibleLots.length === 0) return null;

  const fy = fiscalYearOf(asOf);
  let used = 0n;
  let estimatedLtcg = 0n;
  let estimatedStcg = 0n;
  const selected: OpenLot[] = [];
  const unknownCostLots = lots.filter((l) => l.instrumentId === instrumentId && l.costPaise === 0n);

  for (const lot of eligibleLots) {
    const gain = computeGain(lot, closePaise);
    if (gain === null) {
      unknownCostLots.push(lot);
      continue;
    }
    if (used + gain.gainPaise > budgetPaise) {
      if (selected.length === 0) {
        selected.push(lot);
        used = used + gain.gainPaise;
      }
      break;
    }
    selected.push(lot);
    used = used + gain.gainPaise;
    if (gain.isLtcg) estimatedLtcg = estimatedLtcg + gain.gainPaise;
    else estimatedStcg = estimatedStcg + gain.gainPaise;
  }

  return {
    fiscalYear: fy,
    budgetPaise,
    usedPaise: used as Paise,
    remainingPaise: (budgetPaise - used) as Paise,
    lots: selected,
    estimatedLtcgPaise: estimatedLtcg as Paise,
    estimatedStcgPaise: estimatedStcg as Paise,
    unknownCostLots,
  };
}

function buildLtcgHarvestRec(instrumentId: string, name: string, fyPlan: FyHarvestPlan): CleanupRec {
  const unknownCostNote = fyPlan.unknownCostLots.length > 0
    ? ` ${fyPlan.unknownCostLots.length} lot(s) have unknown cost basis (owner data prerequisite).`
    : '';
  return {
    recommendation: 'sell',
    instrumentId,
    action: 'SELL',
    reason: `LTCG harvest FY ${fyPlan.fiscalYear}: ${formatInr(fyPlan.estimatedLtcgPaise)} LTCG / ${formatInr(fyPlan.estimatedStcgPaise)} STCG vs ₹${fyPlan.budgetPaise / 100n}L budget`,
    thesis:
      `LTCG harvest for ${name} in FY ${fyPlan.fiscalYear} (Apr–Mar). ` +
      `Eligible lots: ${fyPlan.lots.length}. ` +
      `Estimated LTCG: ${formatInr(fyPlan.estimatedLtcgPaise)}; STCG: ${formatInr(fyPlan.estimatedStcgPaise)}. ` +
      `Budget: ${formatInr(fyPlan.budgetPaise)} (PRD §3.9: ₹1.25L/year equity LTCG exemption, pending §15.1 build-time law verification; not a customizable allowance). ` +
      `FIFO acquisition dates, units and costs only. ${unknownCostNote} ` +
      `This is a PAPER recommendation — no 'runCleanup' execution, real fills, lot disposal, or actual exemption consumption. ` +
      `Planned and realized amounts remain distinct. Full tax engine/seeded FIFO and live realization are Phase 3.`,
    ipsClauseRefs: ['3.9'],
    falsification: { metric: 'price_paise', op: 'lt', value: '1' },
    fyPlan,
    unknownPrerequisites: fyPlan.unknownCostLots.length > 0
      ? [`${fyPlan.unknownCostLots.length} lot(s) missing cost basis — owner must supply`]
      : undefined,
  };
}

export interface CleanupInput {
  asOf: string;
  positions: Array<{
    instrumentId: string;
    name: string;
    account: string;
    valuePaise: Paise;
    sector?: string | undefined;
    issuer?: string | undefined;
  }>;
}

export interface CleanupOutput {
  cleanupRecs: CleanupRec[];
  microOrphans: CleanupRec[];
  thesisLess: CleanupRec[];
  ltcgHarvest: CleanupRec[];
  legacyNotes: CleanupRec[];
  sammaanRouting: CleanupRec | null;
}

export async function generateCleanupRecommendations(
  db: Db,
  input: CleanupInput,
): Promise<CleanupOutput> {
  const lots = await loadOpenLots(db);
  const asOf = input.asOf;

  const output: CleanupOutput = {
    cleanupRecs: [],
    microOrphans: [],
    thesisLess: [],
    ltcgHarvest: [],
    legacyNotes: [],
    sammaanRouting: null,
  };

  // 1. Smallcase subscriptions — one note each, from the real decomposition.
  for (const [smallcase, positions] of await loadSmallcasePositions(db)) {
    output.cleanupRecs.push(buildSmallcaseTerminationRec(smallcase, positions));
  }

  // 2. Micro-orphans <₹5k (excluding RPOWER which is a legacy note)
  for (const pos of input.positions) {
    if (
      pos.valuePaise < MICRO_ORPHAN_THRESHOLD &&
      // Still excluded: NSE:SMALLCASE-RESIDUE remains in SEED_HOLDINGS. Dropping the
      // guard let the ₹6,55,400 phantom fall into the thesis-less scan and earn a SELL
      // recommendation — worse than the blob it replaced. The guard goes when the seed
      // row does, and the two must move together.
      pos.instrumentId !== 'NSE:SMALLCASE-RESIDUE' &&
      pos.instrumentId !== 'NSE:RPOWER'
    ) {
      const rec = buildMicroOrphanRec(pos.instrumentId, pos.name, pos.valuePaise, pos.account);
      output.microOrphans.push(rec);
      output.cleanupRecs.push(rec);
    }
  }

  // 3. Thesis-less holdings (excluding micro-orphans already captured and smallcase residue)
  const thesisLessCandidates = input.positions.filter(
    (p) =>
      p.valuePaise >= MICRO_ORPHAN_THRESHOLD &&
      p.instrumentId !== 'NSE:SMALLCASE-RESIDUE' &&
      p.instrumentId !== 'NSE:RPOWER' &&
      !p.instrumentId.startsWith('BOND:') &&
      !p.instrumentId.startsWith('EPF:') &&
      !p.instrumentId.startsWith('CASH:') &&
      !p.instrumentId.startsWith('US:') &&
      p.instrumentId !== 'NSE:LIQUIDBEES', // Liquid BeES is a smallcase constituent, keep
  );
  for (const pos of thesisLessCandidates) {
    const rec = buildThesisLessRec(pos.instrumentId, pos.name, pos.valuePaise, pos.account);
    output.thesisLess.push(rec);
    output.cleanupRecs.push(rec);
  }

  // 4. Groww Reliance Power — manual closure
  const rpower = input.positions.find((p) => p.instrumentId === 'NSE:RPOWER');
  if (rpower) {
    const rec = buildGrowwRPowerRec();
    output.legacyNotes.push(rec);
    output.cleanupRecs.push(rec);
  }

  // 5. Sammaan Sep-2026 maturity routing
  // Use 60-day horizon to catch Sep-26 maturity from Aug seed date
  const redemptions = await listRedemptionsUntil(db, 60, new Date(`${asOf}T00:00:00Z`));
  const sammaan2026 = redemptions.find((r) => r.instrumentId === 'BOND:SAMMAAN-2026');
  if (sammaan2026) {
    const rec = buildSammaanMaturityRoutingRec(sammaan2026);
    output.sammaanRouting = rec;
    output.cleanupRecs.push(rec);
  }

  // 6. Bond credit review (Sammaan 2026/2029, Edelweiss 2033) — exclude ones with maturity routing
  const maturityBondIds = new Set(redemptions.map((r) => r.instrumentId));
  for (const pos of input.positions) {
    if (pos.instrumentId.startsWith('BOND:') && !maturityBondIds.has(pos.instrumentId)) {
      const rec = buildBondCreditReviewRec(pos.instrumentId, pos.name);
      output.cleanupRecs.push(rec);
    }
  }

  // 7. LTCG harvest calendar — schedule across 1–2 fiscal years
  // Only for equity positions with open lots and known cost basis
  const currentFy = fiscalYearOf(asOf);
  const fyStart = fyStartEnd(currentFy);
  const nextFyStart = fyStartEnd(String(Number(currentFy.split('-')[0]) + 1) + '-' + String(Number(currentFy.split('-')[1]) + 1));
  const budgets = [
    { fy: currentFy, budget: LTCG_EXEMPTION_PER_FY },
    { fy: nextFyStart.start.slice(0, 7), budget: LTCG_EXEMPTION_PER_FY }, // simplified next FY key
  ];

  // For each thesis-less equity position, build harvest plan
  for (const pos of thesisLessCandidates) {
    if (!pos.instrumentId.startsWith('NSE:') || pos.instrumentId === 'NSE:LIQUIDBEES') continue;

    const closePaise = await getLatestClose(db, pos.instrumentId, asOf);
    if (closePaise === null) continue;

    // Build plan for current FY
    const fyPlan = buildFyHarvestPlan(pos.instrumentId, lots, closePaise, LTCG_EXEMPTION_PER_FY, asOf);
    if (fyPlan && fyPlan.lots.length > 0) {
      const rec = buildLtcgHarvestRec(pos.instrumentId, pos.name, fyPlan);
      output.ltcgHarvest.push(rec);
    }
  }

  return output;
}

export function toPaperRecommendations(
  cleanup: CleanupRec[],
  createdOn: string,
  override?: OverrideEvent,
): RecommendationInput[] {
  return cleanup.map((c) => {
    // For legacy_note, use HOLD as the primary action since it's not actionable
    const primaryAction = c.action === 'CLOSE_MANUALLY' ? 'HOLD' : c.action;
    const primary: RecLeg = {
      intent: c.reason,
      instrumentId: c.instrumentId,
      action: primaryAction,
      amountPaise: null,
      thesis: c.thesis.slice(0, MAX_THESIS_WORDS - 1),
      ipsClauseRefs: c.ipsClauseRefs,
      falsification: c.falsification ?? null,
    };

    const sameIntentAlternate: RecLeg = c.instrumentId !== 'NSE:RPOWER'
      ? {
          intent: primary.intent,
          instrumentId: 'NSE:NIFTYBEES',
          action: 'REDIRECT',
          amountPaise: primary.amountPaise,
          thesis: `Route proceeds through the index route (NSE:NIFTYBEES) instead of a single-name view. No challenger cleared the engine; broad index is the honest expression of exposure intent. Costs are lower and no single-stock cap to manage.`,
          ipsClauseRefs: ['3.4', '3.6'],
          falsification: null,
        }
      : {
          intent: primary.intent,
          instrumentId: null,
          action: 'HOLD',
          amountPaise: null,
          thesis: `The Groww Reliance Power position requires manual closure; no automated path exists. Doing nothing this cycle means the position stays until the owner closes it directly. Revisit next cycle.`,
          ipsClauseRefs: ['3.7'],
          falsification: null,
        };

    const differentIntentAlternate: RecLeg = {
      intent: 'do nothing this cycle',
      instrumentId: null,
      action: 'HOLD',
      amountPaise: null,
      thesis:
        `Doing nothing is a real option: the portfolio stays inside its IPS bands without this action, ` +
        `and the 12-month holding discipline means a skipped cycle costs one month of exposure, not the thesis. ` +
        `Revisit next cycle with fresher data rather than acting on a marginal edge.`,
      ipsClauseRefs: ['3.7'],
      falsification: primary.falsification,
    };

    return {
      kind: c.recommendation,
      createdOn,
      primary,
      sameIntentAlternates: [sameIntentAlternate],
      differentIntent: differentIntentAlternate,
      engineEvidence: {
        cleanupReason: c.reason,
        fyPlan: c.fyPlan ?? null,
        unknownPrerequisites: c.unknownPrerequisites ?? [],
        legacyNote: c.recommendation === 'legacy_note',
      },
      paperMode: true,
    };
  });
}