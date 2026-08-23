import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IPS_BANDS, UNSOURCED_BANDS, UNSOURCED_BAND_CAVEAT } from '../../src/domain/allocation.js';

const prd = readFileSync(
  fileURLToPath(new URL('../../PRD_investment_agent.md', import.meta.url)), 'utf8',
);

/**
 * Review item 30. PRD 3.3 says, in full, "Debt/EPF/cash: remainder; EPF counts as
 * debt-like." A remainder is an identity, not a band — so DEBT.min = 0.25 is an
 * invented floor and CASH.max = 0.20 has no source at all. Both are presented to the
 * owner under "Allocation vs IPS 3.3", and CASH.max carried no flag anywhere.
 *
 * The numbers are the owner's call. What is NOT optional is that an unsourced rail
 * must not read as policy.
 */
describe('bands the PRD does not state are flagged as such', () => {
  it('confirms the PRD really says "remainder", not a floor', () => {
    expect(prd).toContain('Debt/EPF/cash: remainder');
    expect(prd).not.toMatch(/debt[^.\n]{0,40}(minimum|floor|at least)\s*25/i);
  });

  it('names both unsourced bounds', () => {
    expect([...UNSOURCED_BANDS].sort()).toEqual(['CASH.max', 'DEBT.min']);
  });

  it('keeps the bands the PRD DOES state', () => {
    // 3.3 verbatim: equity ceiling ~60%, gold 5-10%.
    expect(prd).toMatch(/Equity ceiling ~60%/);
    expect(IPS_BANDS.EQUITY.max).toBe(0.60);
    expect(prd).toMatch(/Gold: 5–10% band/);
    expect(IPS_BANDS.GOLD.min).toBe(0.05);
    expect(IPS_BANDS.GOLD.max).toBe(0.10);
  });

  it('states the caveat in terms the owner can act on', () => {
    expect(UNSOURCED_BAND_CAVEAT).toMatch(/DEBT/);
    expect(UNSOURCED_BAND_CAVEAT).toMatch(/CASH/);
    expect(UNSOURCED_BAND_CAVEAT).toMatch(/remainder/);
  });
});
