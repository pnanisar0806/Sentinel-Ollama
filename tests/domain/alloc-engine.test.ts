import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadPositions, netWorth, type Position } from '../../src/domain/networth.js';
import { allocationDrift } from '../../src/domain/allocation.js';
import { rupees, type Paise } from '../../src/money/paise.js';
import {
  SELL_TOLERANCE,
  TAX_POLICY_NOTE,
  isRebalanceTarget,
  rebalanceRec,
  sellCandidates,
  type AllocationState,
  type FundingRoute,
} from '../../src/domain/alloc-engine.js';

function position(over: Partial<Position> = {}): Position {
  return {
    instrumentId: 'NSE:X',
    name: 'X',
    kind: 'EQUITY',
    account: 'zerodha',
    valuePaise: rupees(100_000),
    avgCostPaise: rupees(80_000),
    assetClass: 'EQUITY',
    issuer: null,
    sector: null,
    currency: 'INR',
    isEmployer: false,
    asOf: '2026-09-12T00:00:00.000Z',
    source: 'manual-seed',
    ...over,
  };
}

/** Builds a state whose net-worth basis agrees with its positions by construction. */
function stateOf(positions: Position[], routes: FundingRoute[] = []): AllocationState {
  return { netWorth: netWorth(positions, 0n as Paise), positions, routes };
}

const sipRoute = (assetClass: FundingRoute['assetClass'], capacity: number): FundingRoute => ({
  id: `sip-${assetClass}`,
  kind: 'sip',
  assetClass,
  monthlyCapacityPaise: rupees(capacity),
  loadFree: true,
});

describe('rebalanceRec — in-band', () => {
  it('states in-band with the actual percentages rather than inventing a move', () => {
    const positions = [
      position({ instrumentId: 'NSE:EQ', valuePaise: rupees(50_000) }),
      position({ instrumentId: 'GOLD:ETF', kind: 'GOLD', assetClass: 'GOLD', valuePaise: rupees(8_000) }),
      position({ instrumentId: 'BOND:A', kind: 'BOND', assetClass: 'DEBT', valuePaise: rupees(42_000) }),
    ];
    const rec = rebalanceRec(stateOf(positions), '2026-09');

    expect(rec.direction).toBe('in-band');
    expect(rec.actions).toEqual([]);
    // Percentages come from the drift rows, not from a second computation in the report.
    const drift = allocationDrift(netWorth(positions, 0n as Paise).byAssetClass);
    expect(rec.drift).toEqual(drift);
    expect(rec.summary).toContain('in-band');
    expect(rec.summary).toContain('50.0%');
  });
});

describe('rebalanceRec — the real seeded balance sheet', () => {
  let db: Db;
  let positions: Position[];
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
    positions = await loadPositions(db);
  });

  it('sizes the gold top-up at exactly the drift to the band edge, in paise', () => {
    const state = stateOf(positions, [sipRoute('GOLD', 25_000)]);
    const rec = rebalanceRec(state, '2026-09');

    const gold = rec.drift.find((d) => d.assetClass === 'GOLD')!;
    expect(gold.breach).toBe('UNDER');

    const add = rec.actions.find((a) => a.assetClass === 'GOLD')!;
    expect(add.kind).toBe('ADD');
    // Derived from the drift row, so a change in the seed or the band moves both together.
    expect(add.amountPaise).toBe(gold.driftPaise);
    expect(typeof add.amountPaise).toBe('bigint');
    expect(rec.direction).toBe('add');
    expect(rec.ipsClauseRefs).toContain('3.3');
  });

  it('never proposes a move the owner has ruled out: EPF and the Kolkata property', () => {
    const rec = rebalanceRec(stateOf(positions, [sipRoute('DEBT', 50_000)]), '2026-09');

    // EPF is mandatory payroll ballast, not a lever (owner decision 2026-08-23).
    expect(positions.some((p) => p.kind === 'EPF')).toBe(true);
    for (const a of rec.actions) {
      expect(a.instrumentId === undefined || !a.instrumentId.startsWith('EPF')).toBe(true);
    }
    expect(positions.every((p) => isRebalanceTarget(p) === (p.kind !== 'EPF'))).toBe(true);

    // The property is a liability line (the SBI home loan), never a position, so it cannot
    // be a rebalance target by construction — there is nothing to exclude.
    expect(positions.some((p) => p.kind === 'LOAN')).toBe(false);
  });
});

describe('rebalanceRec — tax awareness', () => {
  const overweightEquity = () => [
    position({ instrumentId: 'NSE:WINNER', valuePaise: rupees(70_000), avgCostPaise: rupees(20_000) }),
    position({ instrumentId: 'BOND:A', kind: 'BOND', assetClass: 'DEBT', valuePaise: rupees(22_000) }),
    position({ instrumentId: 'GOLD:ETF', kind: 'GOLD', assetClass: 'GOLD', valuePaise: rupees(8_000) }),
  ];

  it('directs new money instead of realising a gain when a load-free route exists', () => {
    const rec = rebalanceRec(stateOf(overweightEquity(), [sipRoute('DEBT', 30_000)]), '2026-09');

    const equity = rec.drift.find((d) => d.assetClass === 'EQUITY')!;
    expect(equity.breach).toBe('OVER');

    expect(rec.actions.map((a) => a.route)).not.toContain('sell');
    const flow = rec.actions.find((a) => a.kind === 'DIRECT_FLOW')!;
    expect(flow.route).toBe('sip');
    expect(flow.amountPaise).toBe(equity.driftPaise);
    expect(rec.taxNotes.join(' ')).toMatch(/no (taxable event|realisation)/i);
  });

  it('falls back to a trim only when no funding route can absorb the drift', () => {
    const rec = rebalanceRec(stateOf(overweightEquity()), '2026-09');
    const trim = rec.actions.find((a) => a.kind === 'TRIM')!;
    expect(trim.route).toBe('sell');
    expect(rec.direction).toBe('reduce');
  });

  it('never trims further than the nearest band edge', () => {
    const positions = overweightEquity();
    const rec = rebalanceRec(stateOf(positions), '2026-09');
    const equity = rec.drift.find((d) => d.assetClass === 'EQUITY')!;
    const trimmed = rec.actions
      .filter((a) => a.kind === 'TRIM')
      .reduce((sum, a) => sum + a.amountPaise, 0n);
    expect(trimmed).toBe(equity.driftPaise);
    expect(trimmed).toBeLessThan(positions[0]!.valuePaise);
  });

  it('sells losses before gains, and an unknown cost basis last', () => {
    const positions = [
      position({ instrumentId: 'NSE:GAIN', valuePaise: rupees(30_000), avgCostPaise: rupees(10_000) }),
      position({ instrumentId: 'NSE:UNKNOWN', valuePaise: rupees(30_000), avgCostPaise: null }),
      position({ instrumentId: 'NSE:LOSS', valuePaise: rupees(30_000), avgCostPaise: rupees(50_000) }),
      position({ instrumentId: 'NSE:SMALLGAIN', valuePaise: rupees(30_000), avgCostPaise: rupees(29_000) }),
    ];
    expect(sellCandidates(positions, 'EQUITY').map((p) => p.instrumentId)).toEqual([
      'NSE:LOSS',
      'NSE:SMALLGAIN',
      'NSE:GAIN',
      'NSE:UNKNOWN',
    ]);
  });

  it('says plainly what it does not compute', () => {
    expect(TAX_POLICY_NOTE).toMatch(/does not/i);
    const rec = rebalanceRec(stateOf(overweightEquity()), '2026-09');
    expect(rec.taxNotes).toContain(TAX_POLICY_NOTE);
  });
});

describe('rebalanceRec — FR-13 annual April proposal', () => {
  const inBand = () => [
    position({ instrumentId: 'NSE:EQ', valuePaise: rupees(50_000) }),
    position({ instrumentId: 'GOLD:ETF', kind: 'GOLD', assetClass: 'GOLD', valuePaise: rupees(8_000) }),
    position({ instrumentId: 'BOND:A', kind: 'BOND', assetClass: 'DEBT', valuePaise: rupees(42_000) }),
  ];

  it('marks April as the annual review and still reports the numbers when in-band', () => {
    const april = rebalanceRec(stateOf(inBand()), '2027-04');
    expect(april.annual).toBe(true);
    expect(april.direction).toBe('in-band');
    expect(april.drift).toEqual(allocationDrift(netWorth(inBand(), 0n as Paise).byAssetClass));
    expect(april.summary).toMatch(/annual/i);
  });

  it('is a monthly drift check in every other month', () => {
    expect(rebalanceRec(stateOf(inBand()), '2027-03').annual).toBe(false);
    expect(rebalanceRec(stateOf(inBand()), '2027-12').annual).toBe(false);
  });
});

describe('rebalanceRec — one net-worth basis', () => {
  it('refuses a state whose net worth disagrees with its positions', () => {
    const positions = [position()];
    const mismatched: AllocationState = {
      netWorth: netWorth([position({ valuePaise: rupees(999_999) })], 0n as Paise),
      positions,
      routes: [],
    };
    expect(() => rebalanceRec(mismatched, '2026-09')).toThrow(/disagrees/i);
  });
});

describe('rebalanceRec — owner fixes 2026-09-27', () => {
  // Equity 60.7% against a 60% ceiling — the case that produced two needless sales.
  const slightlyOver = () => [
    position({ instrumentId: 'NSE:A', valuePaise: rupees(30_350), avgCostPaise: rupees(30_000) }),
    position({ instrumentId: 'NSE:B', valuePaise: rupees(30_350), avgCostPaise: rupees(30_000) }),
    position({ instrumentId: 'BOND:A', kind: 'BOND', assetClass: 'DEBT', valuePaise: rupees(32_000) }),
    position({ instrumentId: 'GOLD:ETF', kind: 'GOLD', assetClass: 'GOLD', valuePaise: rupees(1_200) }),
    position({ instrumentId: 'CASH:S', kind: 'CASH', assetClass: 'CASH', valuePaise: rupees(6_100) }),
  ];

  it('never sells for an overshoot under 2 percentage points, even with no route at all', () => {
    const rec = rebalanceRec(stateOf(slightlyOver()), '2026-09');
    const equity = rec.drift.find((d) => d.assetClass === 'EQUITY')!;
    expect(equity.breach).toBe('OVER');
    expect(equity.actual - equity.max).toBeLessThan(SELL_TOLERANCE);
    expect(rec.actions.some((a) => a.kind === 'TRIM')).toBe(false);
    const flow = rec.actions.find((a) => a.kind === 'DIRECT_FLOW')!;
    // New money goes to the class that is short — gold, under its 5% floor — not just anywhere.
    expect(flow.assetClass).toBe('GOLD');
  });

  it('sends new money to an under-floor class before any other', () => {
    const rec = rebalanceRec(stateOf(slightlyOver(), [sipRoute('DEBT', 30_000), sipRoute('GOLD', 30_000)]), '2026-09');
    expect(rec.actions.find((a) => a.kind === 'DIRECT_FLOW')!.assetClass).toBe('GOLD');
  });

  it('sells only when new money could not close the gap within a year, and says where the proceeds go', () => {
    // Equity 10 points over (₹10,000 of ₹1,00,000) against ₹500 a month of new money.
    const tiny = [sipRoute('GOLD', 500)];
    const positions = [
      position({ instrumentId: 'NSE:WINNER', valuePaise: rupees(70_000), avgCostPaise: rupees(20_000) }),
      position({ instrumentId: 'BOND:A', kind: 'BOND', assetClass: 'DEBT', valuePaise: rupees(26_000) }),
      position({ instrumentId: 'GOLD:ETF', kind: 'GOLD', assetClass: 'GOLD', valuePaise: rupees(4_000) }),
    ];
    const rec = rebalanceRec(stateOf(positions, tiny), '2026-09');
    const trim = rec.actions.find((a) => a.kind === 'TRIM')!;
    expect(trim).toBeDefined();
    expect(trim.proceedsTo).toEqual({ assetClass: 'GOLD', instrumentId: 'GOLD:ETF' });
    expect(trim.rationale).toMatch(/proceeds/i);
    // With enough new money the same gap is closed by flows instead.
    const ample = rebalanceRec(stateOf(positions, [sipRoute('GOLD', 5_000)]), '2026-09');
    expect(ample.actions.some((a) => a.kind === 'TRIM')).toBe(false);
  });

  it('counts the monthly surplus once, however many classes it could go to', () => {
    // ₹10,000 over, ₹500 a month of surplus offered to two classes: still ₹500, not ₹1,000.
    // 12 × ₹500 = ₹6,000 cannot close ₹10,000, so a trim is right; double-counting would hide it.
    const surplus = (assetClass: FundingRoute['assetClass']): FundingRoute => ({
      id: `surplus-${assetClass}`, kind: 'fresh-surplus', assetClass, monthlyCapacityPaise: rupees(500), loadFree: true,
    });
    const positions = [
      position({ instrumentId: 'NSE:WINNER', valuePaise: rupees(70_000), avgCostPaise: rupees(20_000) }),
      position({ instrumentId: 'BOND:A', kind: 'BOND', assetClass: 'DEBT', valuePaise: rupees(26_000) }),
      position({ instrumentId: 'GOLD:ETF', kind: 'GOLD', assetClass: 'GOLD', valuePaise: rupees(4_000) }),
    ];
    const pooled = rebalanceRec(stateOf(positions, [surplus('GOLD'), surplus('DEBT'), surplus('CASH')]), '2026-09');
    expect(pooled.actions.some((a) => a.kind === 'TRIM')).toBe(true);
  });

  it('sells the weakest holding first when quality scores exist, using tax only to break ties', () => {
    const positions = [
      position({ instrumentId: 'NSE:STRONG-LOSS', valuePaise: rupees(30_000), avgCostPaise: rupees(50_000) }),
      position({ instrumentId: 'NSE:WEAK-GAIN', valuePaise: rupees(30_000), avgCostPaise: rupees(10_000) }),
      position({ instrumentId: 'NSE:UNSCORED', valuePaise: rupees(30_000), avgCostPaise: rupees(50_000) }),
    ];
    const quality = new Map([['NSE:STRONG-LOSS', 85], ['NSE:WEAK-GAIN', 40]]);
    expect(sellCandidates(positions, 'EQUITY', quality).map((p) => p.instrumentId))
      .toEqual(['NSE:WEAK-GAIN', 'NSE:STRONG-LOSS', 'NSE:UNSCORED']);
  });
});
