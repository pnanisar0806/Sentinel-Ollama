import { describe, expect, it } from 'vitest';
import { SMALLCASES, smallcaseUnitsByInstrument } from '../../src/config/smallcases.js';
import { addP, rupees, type Paise } from '../../src/money/paise.js';

/**
 * Live INDmoney holdings, 2026-09-20 snapshot. Derived independently of the smallcase
 * screens: agreement between the two is what proves a holding is wholly smallcase-owned,
 * so this must NOT be generated from SMALLCASES.
 */
const LIVE_UNITS: Record<string, number> = {
  'IND:INDS29570': 2616, // Zerodha Gold ETF
  'IND:INDS19182': 343,  // Nifty 50 BeES
  'IND:INDS20619': 34,   // Junior BeES
  'IND:INDS28892': 140,  // Liquid ETF
  'IND:INDS01789': 7,    // Sundaram Finance
  'IND:INDS03891': 7,    // Schaeffler
  'IND:INDS01632': 6,    // KEI
  'IND:INDS00128': 34,   // Kirloskar Pneumatic
  'IND:INDS03291': 14,   // ZF Commercial
  'IND:INDS01052': 23,   // Reliance
  'IND:INDS00083': 7,    // CRISIL
  'IND:INDS00365': 63,   // Berger Paints
  'IND:INDS00972': 113,  // ITC
  'IND:INDS01150': 5,    // M&M
  'IND:INDS01694': 43,   // M&M Financial
  'IND:INDS01469': 14,   // Tech Mahindra
  'IND:INDS02342': 43,   // Mahindra Lifespace
  'IND:INDS00200': 21,   // Pidilite — the ONE split holding: 19 smallcase + 2 direct
};

describe('smallcase decomposition', () => {
  it('sums to the line items, not to the app header', () => {
    const total = addP(...SMALLCASES.map((s) => s.currentValuePaise));
    // The app's own four line items sum to 5,61,273 while its header reads 5,61,275 —
    // a ₹2 rounding artifact, since each line is displayed to the whole rupee. The line
    // items are the recorded figures and no value is tuned to close the gap.
    expect(total).toBe(rupees('561273'));
    expect(rupees('561275') - total).toBe(rupees('2'));
  });

  it('never exceeds the live holding for any instrument', () => {
    // A smallcase claiming more shares than are actually held would make an exit
    // instruction unfillable, which is the failure this table exists to prevent.
    for (const [id, units] of smallcaseUnitsByInstrument()) {
      const live = LIVE_UNITS[id];
      expect(live, `no live holding recorded for ${id}`).toBeDefined();
      expect(units, `${id}: smallcase ${units} > live ${live}`).toBeLessThanOrEqual(live!);
    }
  });

  it('accounts for every share of the wholly-smallcase holdings', () => {
    const sc = smallcaseUnitsByInstrument();
    // Agreement with the independently-sourced live units is the evidence that these
    // carry no direct component. GOLDBEES and NIFTYBEES each span two smallcases.
    for (const id of Object.keys(LIVE_UNITS)) {
      if (id === 'IND:INDS00200') continue; // Pidilite is split; asserted separately
      expect(sc.get(id), `${id} should be 100% smallcase`).toBe(LIVE_UNITS[id]);
    }
  });

  it('leaves Pidilite split 19 smallcase / 2 direct', () => {
    expect(smallcaseUnitsByInstrument().get('IND:INDS00200')).toBe(19);
    expect(LIVE_UNITS['IND:INDS00200']! - 19).toBe(2);
  });

  it('spans two smallcases where the app says it does', () => {
    const inBoth = (id: string) => SMALLCASES.filter((s) =>
      s.constituents.some((k) => k.instrumentId === id)).map((s) => s.name);
    // A flat instrument -> smallcase map would be unable to represent these, and
    // "exit Timeless" would then have no defined share count for either ETF.
    expect(inBoth('IND:INDS29570')).toEqual(
      ['Equity & Gold Asset Allocation', 'Timeless Asset Allocation']);
    expect(inBoth('IND:INDS19182')).toEqual(
      ['Equity & Gold Asset Allocation', 'Timeless Asset Allocation']);
  });

  it('carries a positive average buy price on every constituent', () => {
    for (const s of SMALLCASES) {
      expect(s.constituents.length).toBeGreaterThan(0);
      for (const k of s.constituents) {
        // Unknown cost is NULL, never 0 — a zero here would read as a free share and
        // turn every sale into a fully taxable gain.
        expect(k.avgBuyPricePaise as Paise).toBeGreaterThan(0n);
        expect(k.units).toBeGreaterThan(0);
      }
    }
  });
});
