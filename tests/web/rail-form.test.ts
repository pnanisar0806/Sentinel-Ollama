import { describe, expect, it } from 'vitest';
import { parseRailInput, formatRailValue, validRailValue } from '../../web/lib/rail-form.js';

describe('owner rail inputs', () => {
  it('validates the API boundary without numeric coercion', () => {
    expect(validRailValue('monthly_budget_paise', 5000000)).toBe(true);
    expect(validRailValue('cash_ceiling_pct', 12.5)).toBe(true);
    for (const value of ['50000', null, true, -1, 0, 0.1, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
      expect(validRailValue('monthly_budget_paise', value)).toBe(false);
    }
    expect(validRailValue('cash_ceiling_pct', 101)).toBe(false);
    expect(validRailValue('freeze_state', 1)).toBe(false);
  });
  it('converts rupees exactly to the existing integer paise transport', () => {
    expect(parseRailInput('monthly_budget_paise', '50000')).toBe(5000000);
    expect(parseRailInput('monthly_budget_paise', '0.29')).toBe(29);
    expect(parseRailInput('monthly_budget_paise', '50,000')).toBe(5000000);
    expect(parseRailInput('monthly_budget_paise', '₹50,000.50')).toBe(5000050);
    expect(parseRailInput('monthly_budget_paise', ' ₹ 1,00,000 ')).toBe(10000000);
    expect(formatRailValue('monthly_budget_paise', 5000000)).toBe('₹50,000');
  });
  it.each(['', '0', '-1', '-₹1,000', '1e5', 'Infinity', 'NaN', '1.001', '₹', ',', '0x10', '1.5e3', '90071992547409.92'])('refuses invalid money %s', (value) => {
    expect(() => parseRailInput('monthly_budget_paise', value)).toThrow();
  });
  it('accepts percentage points and rejects invalid percentages and unknown rails', () => {
    expect(parseRailInput('sector_cap_pct', '12.5')).toBe(12.5);
    expect(formatRailValue('sector_cap_pct', 12.5)).toBe('12.5%');
    for (const value of ['', '0', '101', 'NaN', '1e2']) {
      expect(() => parseRailInput('sector_cap_pct', value)).toThrow();
    }
    expect(() => parseRailInput('freeze_state', '1')).toThrow();
  });
});
