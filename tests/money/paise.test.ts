import { describe, expect, it } from 'vitest';
import { addP, formatInr, mulP, paise, pctOf, rupees, subP } from '../../src/money/paise.js';

describe('paise', () => {
  it('parses rupees without float error', () => {
    expect(rupees(24_482).toString()).toBe('2448200');
    expect(rupees('0.10').toString()).toBe('10');
    expect(rupees('1354000.55').toString()).toBe('135400055');
  });

  it('rejects sub-paise precision rather than silently rounding', () => {
    expect(() => rupees('1.005')).toThrow(/sub-paise/i);
  });

  it('formats Indian units compactly', () => {
    expect(formatInr(rupees(1_354_000), { compact: true })).toBe('₹13.54L');
    expect(formatInr(rupees(12_400_000), { compact: true })).toBe('₹1.24Cr');
    expect(formatInr(rupees(31_500), { compact: true })).toBe('₹31,500');
  });

  it('formats full amounts with Indian digit grouping', () => {
    expect(formatInr(rupees(2_15_000))).toBe('₹2,15,000');
    expect(formatInr(rupees('1234.50'))).toBe('₹1,234.50');
  });

  it('does arithmetic in integers', () => {
    expect(addP(rupees(1), rupees(2), rupees(3)).toString()).toBe('600');
    expect(subP(rupees(5), rupees(2)).toString()).toBe('300');
    expect(mulP(rupees(100), 0.7).toString()).toBe('7000');
    expect(pctOf(rupees(25), rupees(100))).toBeCloseTo(0.25, 10);
  });

  it('treats pctOf a zero whole as zero, not NaN', () => {
    expect(pctOf(rupees(0), rupees(0))).toBe(0);
  });

  it('round-trips a bigint from the database', () => {
    expect(paise('135400055').toString()).toBe('135400055');
  });
});
