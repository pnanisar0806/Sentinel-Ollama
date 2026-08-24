import { describe, expect, it } from 'vitest';
import { computeFICorpusBand, fundedStatus, reportFundedStatus } from '../../src/domain/funded-status.js';
import { computeFICorpusBand as bucketsBand, fundedRatio as bucketsRatio } from '../../src/domain/buckets.js';
import { fundedRatio } from '../../src/domain/funded-status.js';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';
import { rupees, type Paise } from '../../src/money/paise.js';

/**
 * PRD: "At a 3.5% safe withdrawal rate ... this implies a corpus of Rs 10.3 Cr (floor)
 * to Rs 17.1 Cr (stretch) in today's money (Rs 9-15 Cr at 4% SWR)."
 *
 * So the BAND varies the income (floor 3L/mo -> stretch 5L/mo) at a single SWR, and
 * the SWR is a separate sensitivity axis. The shipped code varied the SWR and held
 * income at the floor, producing the PRD's Rs 9 Cr figure mislabelled as "stretch" —
 * Rs 1.29 Cr BELOW the floor target, so the owner read as better funded against the
 * harder goal for every possible input.
 */
describe('FI corpus band reproduces the PRD', () => {
  it('is Rs 10.29 Cr floor to Rs 17.14 Cr stretch at the 3.5% SWR', () => {
    const { floorPaise, stretchPaise } = computeFICorpusBand();
    expect(floorPaise).toBe(10_285_714_285n);   // 3L/mo x 12 / 0.035 = Rs 10.2857 Cr
    expect(stretchPaise).toBe(17_142_857_142n); // 5L/mo x 12 / 0.035 = Rs 17.1428 Cr
  });

  it('is Rs 9 Cr to Rs 15 Cr at the 4% optimistic SWR', () => {
    const { floorPaise, stretchPaise } = computeFICorpusBand(ASSUMPTIONS.swrOptimistic);
    expect(floorPaise).toBe(9_000_000_000n);    // PRD's "Rs 9"
    expect(stretchPaise).toBe(15_000_000_000n); // PRD's "15 Cr"
  });

  it('derives both ends from the assumptions, not from literals', () => {
    // Independent recomputation from ASSUMPTIONS, so a changed assumption moves this.
    const bps = BigInt(Math.round(ASSUMPTIONS.swrFloor * 10_000));
    const expectFloor = (rupees(ASSUMPTIONS.fiIncomeFloorMonthlyInr) * 12n * 10_000n) / bps;
    const expectStretch = (rupees(ASSUMPTIONS.fiIncomeStretchMonthlyInr) * 12n * 10_000n) / bps;

    const { floorPaise, stretchPaise } = computeFICorpusBand();
    expect(floorPaise).toBe(expectFloor);
    expect(stretchPaise).toBe(expectStretch);
  });

  it('always targets MORE money for the stretch goal than for the floor', () => {
    // The invariant the shipped code inverted. True at every SWR.
    for (const swr of [ASSUMPTIONS.swrFloor, ASSUMPTIONS.swrOptimistic, 0.03, 0.05]) {
      const { floorPaise, stretchPaise } = computeFICorpusBand(swr);
      expect(stretchPaise).toBeGreaterThan(floorPaise);
    }
  });
});

describe('funded status reports the harder goal as harder', () => {
  it('reports a lower ratio against stretch than against floor', () => {
    const { floorRatio, stretchRatio } = fundedStatus(rupees(50_00_000) as Paise);
    expect(stretchRatio).toBeLessThan(floorRatio);
  });

  it('labels the band by which target it actually used', () => {
    // 'stretch' was unreachable and the label was inverted: passing an explicit
    // corpus reported 'floor' while the assumption-derived default reported 'none'.
    const explicit = reportFundedStatus(rupees(10_00_000) as Paise, rupees(1_00_00_000) as Paise);
    expect(explicit.band).toBe('explicit');

    const defaulted = reportFundedStatus(rupees(10_00_000) as Paise);
    expect(defaulted.band).toBe('floor');
    expect(defaulted.corpusPaise).toBe(computeFICorpusBand().floorPaise);
  });
});

describe('there is exactly one FI corpus model', () => {
  /**
   * computeFICorpusBand and fundedRatio were duplicated verbatim in buckets.ts, so
   * fixing one file left the other wrong — and an import allowlist anchored on
   * funded-status.ts is bypassed by importing buckets.fundedRatio.
   */
  it('buckets re-exports the funded-status implementation rather than copying it', () => {
    expect(bucketsBand).toBe(computeFICorpusBand);
    expect(bucketsRatio).toBe(fundedRatio);
  });
});
