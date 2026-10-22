import { describe, expect, it } from 'vitest';
import { invalidRailMessage, parseRailInput, formatRailValue, RAIL_LABELS, railChangeMessage, validRailValue } from '../../web/lib/rail-form.js';

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
  it('the goal set-aside accepts 0 (ending it) and positive integer paise; no other rail accepts 0', () => {
    for (const v of [0, 1_000_000]) expect(validRailValue('goal_setaside_monthly_paise', v)).toBe(true);
    for (const v of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(validRailValue('goal_setaside_monthly_paise', v)).toBe(false);
    expect(parseRailInput('goal_setaside_monthly_paise', '0')).toBe(0);
    expect(RAIL_LABELS['goal_setaside_monthly_paise']).toBe('Goal set-aside (house + emergency) per month');
  });
  it('error wording is key-aware: the set-aside says zero or more, never positive', () => {
    const huge = String(Number.MAX_SAFE_INTEGER);
    expect(() => parseRailInput('goal_setaside_monthly_paise', huge)).toThrow('Enter an amount of zero or more within the supported range.');
    expect(() => parseRailInput('monthly_budget_paise', '0')).toThrow('Enter a positive amount within the supported range.');
    expect(invalidRailMessage('goal_setaside_monthly_paise')).toBe('Invalid investment limit: use integer paise of zero or more.');
    expect(invalidRailMessage('monthly_budget_paise'))
      .toBe('Invalid investment limit: use positive integer paise for money or a percentage up to 100.');
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
  it('the goal equity ceiling takes whole percentages from 60 to 92 only', () => {
    for (const v of [60, 68, 92]) expect(validRailValue('goal_equity_ceiling_pct', v)).toBe(true);
    for (const v of [59, 93, 68.5, 100]) expect(validRailValue('goal_equity_ceiling_pct', v)).toBe(false);
    expect(parseRailInput('goal_equity_ceiling_pct', '68')).toBe(68);
    for (const v of ['59', '93', '68.5']) expect(() => parseRailInput('goal_equity_ceiling_pct', v)).toThrow(/60 to 92/);
  });
});

describe('railChangeMessage (T7-3): rupees and IST, never raw paise or UTC', () => {
  it('formats a money rail in rupees and passes the IST time through', () => {
    expect(railChangeMessage('monthly_budget_paise', 7_000_000, '2026-10-23 10:00 IST', false))
      .toBe('Monthly investment budget → ₹70,000 takes effect 2026-10-23 10:00 IST');
    expect(railChangeMessage('goal_equity_ceiling_pct', 68, '2026-10-23 10:00 IST', true))
      .toBe('Goal equity ceiling → 68% takes effect 2026-10-23 10:00 IST (a loosening: drawdown is checked again then)');
    expect(RAIL_LABELS['goal_equity_ceiling_pct']!.length).toBeGreaterThan('Goal equity ceiling'.length); // the form keeps the long text
  });
});
