import { describe, expect, it } from 'vitest';
import { rateMicros, usdToInr } from '../../src/money/fx.js';
import { cents } from '../../src/money/paise.js';

describe('fx', () => {
  it('converts USD cents to INR paise at a dated rate', () => {
    // 127.54 USD at 95.3 -> 12154.562 INR -> 1215456 paise (truncated, not rounded up)
    expect(usdToInr(cents('12754'), rateMicros(95.3)).toString()).toBe('1215456');
  });

  it('rejects a non-positive rate', () => {
    expect(() => usdToInr(cents('100'), 0n)).toThrow(/rate/i);
  });
});
