import { describe, expect, it } from 'vitest';
import { resolveCanonicalId } from '../../src/sources/indmoney.js';

/**
 * Canonical resolution must survive the 'IND:' instrument-id prefix: live ids look
 * like IND:5536 while the owner-curated map is keyed by bare code (5536). Before the
 * fix every non-bond live row landed with canonical_id = NULL and the seed could
 * never be superseded — production double-counted ~Rs 35L of the portfolio.
 */
describe('resolveCanonicalId', () => {
  it('maps bare and IND:-prefixed codes alike', () => {
    expect(resolveCanonicalId('5536')).toBe('MF:5536');
    expect(resolveCanonicalId('IND:5536')).toBe('MF:5536');
    expect(resolveCanonicalId('IND:INDS19182')).toBe('NSE:INDS19182');
    expect(resolveCanonicalId('INDS19182')).toBe('NSE:INDS19182');

    // Owner screenshot 2026-08-25: code 118186 is Apple itself, not a basket
    // aggregate — mapping it to US:INDMONEY-BASKET made Apple wear the seed
    // basket's display name and carried the whole book's cost onto its row.
    expect(resolveCanonicalId('IND:118186')).toBe('US:AAPL');
  });

  it('keeps ISIN-shaped ids canonical without a map entry', () => {
    expect(resolveCanonicalId('INE148I07GL3')).toBe('ISIN:INE148I07GL3');
    expect(resolveCanonicalId('ISIN:INE148I07GL3')).toBe('ISIN:INE148I07GL3');
  });

  it('recognises the owner\u2019s EPF and bank statement codes', () => {
    expect(resolveCanonicalId('Servicenow Software Development India Pvt')).toBe('EPF:SERVICE_NOW');
    expect(resolveCanonicalId('3004965_Federal Savings a/cXXXXXXX8660')).toBe('CASH:SAVINGS_HDFC_FEDERAL');
    expect(resolveCanonicalId('3004965_HDFC BankXXXXXXXXXX6652')).toBe('CASH:SAVINGS_HDFC_FEDERAL');
  });

  it('returns undefined for unknown codes — never invents an identity', () => {
    expect(resolveCanonicalId('IND:SOMETHING-NEW')).toBeUndefined();
    expect(resolveCanonicalId('')).toBeUndefined();
  });
});
