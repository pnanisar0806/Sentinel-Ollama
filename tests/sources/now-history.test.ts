import { describe, expect, it } from 'vitest';
import { toPaise } from '../../src/sources/now-history.js';

describe('NOW closes in rupees', () => {
  it('converts cents at that day’s rate: cents x INR-per-USD is paise', () => {
    const rates = new Map([['2026-09-18', 88_500_000n]]); // 88.5
    // $135.47 = 13547 cents -> Rs 11,988.60 = 1198860 paise (floored)
    expect(toPaise([{ date: '2026-09-18', closeCents: 13547n }], rates))
      .toEqual([{ date: '2026-09-18', closePaise: 1_198_909n }]);
  });

  it('carries the latest earlier rate across an ECB holiday', () => {
    const rates = new Map([['2026-09-17', 88_000_000n]]);
    expect(toPaise([{ date: '2026-09-18', closeCents: 10000n }], rates)[0]!.closePaise).toBe(880_000n);
  });

  it('skips a close with no rate on or before it rather than guessing one', () => {
    const rates = new Map([['2026-09-20', 88_000_000n]]);
    expect(toPaise([{ date: '2026-09-18', closeCents: 10000n }], rates)).toEqual([]);
  });
});
