import { describe, it, expect } from 'vitest';
import { rupees, type Paise } from '../../src/money/paise.js';
import {
  computeFICorpusBand,
  fundedRatio,
  reportFundedStatus,
} from '../../src/domain/funded-status.js';

/**
 * The band itself is pinned against the PRD in fi-corpus-band.test.ts.
 *
 * This file previously carried `expect(typeof stretchPaise).toBe('bigint')` and a
 * comment reading "wait ... let me just verify the computation is exact" — the author
 * hit the stretch-corpus defect mid-write and wrote a tautology instead of surfacing
 * it. `isInBand` and `fiCorpusTargetPaise` are gone: the first hard-coded all three
 * arguments and had no production caller, the second was a verbatim alias of
 * computeFICorpusBand.
 */
describe('fundedRatio', () => {
  it('computes the ratio of investable to corpus', () => {
    const result = fundedRatio(rupees(5_000_000), rupees(10_000_000));
    expect(result.ratio).toBe(0.5);
    expect(result.isExact).toBe(false);
  });

  it('returns 1 when investable equals corpus', () => {
    const result = fundedRatio(rupees(10_000_000), rupees(10_000_000));
    expect(result.ratio).toBe(1);
    expect(result.isExact).toBe(true);
  });

  it('returns more than 1 when investable exceeds corpus', () => {
    expect(fundedRatio(rupees(15_000_000), rupees(10_000_000)).ratio).toBe(1.5);
  });
});

describe('reportFundedStatus', () => {
  const investable = rupees(5_000_000) as Paise; // Rs 50L

  it('uses the caller-supplied target for `ratio` and still reports both bands', () => {
    const target = rupees(10_000_000) as Paise; // Rs 1 Cr
    const r = reportFundedStatus(investable, target);

    expect(r.ratio).toBe(0.5);
    expect(r.corpusPaise).toBe(target);
    expect(r.band).toBe('explicit');

    // Derived from the band, not restated as literals.
    const { floorPaise, stretchPaise } = computeFICorpusBand();
    expect(r.floorRatio).toBe(Number(investable) / Number(floorPaise));
    expect(r.stretchRatio).toBe(Number(investable) / Number(stretchPaise));
  });

  it('falls back to the floor corpus and labels it `floor`', () => {
    const r = reportFundedStatus(investable);
    expect(r.band).toBe('floor');
    expect(r.corpusPaise).toBe(computeFICorpusBand().floorPaise);
    expect(r.ratio).toBe(r.floorRatio);
  });

  it('labels the stretch corpus as `stretch` — the label used to be unreachable', () => {
    const { stretchPaise } = computeFICorpusBand();
    const r = reportFundedStatus(investable, stretchPaise);
    expect(r.band).toBe('stretch');
    expect(r.ratio).toBe(r.stretchRatio);
  });

  it('always reports the stretch goal as the less-funded one', () => {
    const r = reportFundedStatus(investable);
    expect(r.stretchRatio).toBeLessThan(r.floorRatio);
  });
});
