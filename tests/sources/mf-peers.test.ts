import { describe, expect, it } from 'vitest';
import { parseAumCrore, resolvePeerToAmfi, resolvePeers, type PeerFund } from '../../src/sources/mf-peers.js';
import type { NavRow } from '../../src/sources/amfi.js';

/**
 * `mf_switch` needs somewhere to switch TO. Owner decision 2026-09-21: use INDmoney's
 * category listing as the universe.
 *
 * INDmoney's fund id is not an AMFI scheme code and its payload carries no ISIN, so a
 * peer can only be joined to its NAV history through the fund itself. Name alone is how
 * four seeded funds ended up on their IDCW variants, so the NAV is used as a
 * fingerprint — and only ever against AMFI's file for the SAME session.
 */
const amfi = (schemeCode: string, schemeName: string, nav: number, isin: string): NavRow => ({
  schemeCode, schemeName, nav, isinDivPayout: isin, isinDivReinvestment: null,
  repurchasePrice: null, salePrice: null, date: '18-Sep-2026',
});

const peer = (over: Partial<PeerFund> = {}): PeerFund => ({
  fundId: '3097', name: 'HDFC Mid Cap Fund', category: 'mid-cap',
  expenseRatioPct: 0.75, aumCrore: 108325, nav: 231.41, navDate: '18 Sep 2026',
  purchaseAllowed: true, ...over,
});

/** The four rows AMFI really carries for HDFC Mid Cap on one day. */
const HDFC_ROWS = [
  amfi('118989', 'HDFC Mid Cap Fund', 231.413, 'INF179K01XQ0'),
  amfi('105758', 'HDFC Mid Cap Fund', 207.974, 'INF179K01CR2'),
  amfi('118988', 'HDFC Mid Cap Fund', 81.906, 'INF179K01XO5'),
  amfi('105757', 'HDFC Mid Cap Fund', 52.178, 'INF179K01CT8'),
];

describe('parseAumCrore', () => {
  it('reads the formatted string this endpoint returns', () => {
    // `get_mf_by_category` gives "108325 Cr" where `get_mf_funds_details` gives 108325.
    expect(parseAumCrore('108325 Cr')).toBe(108325);
    expect(parseAumCrore('1,08,325 Cr')).toBe(108325);
    expect(parseAumCrore(15905)).toBe(15905);
  });

  it('is null rather than 0 on anything it cannot read', () => {
    expect(parseAumCrore('')).toBeNull();
    expect(parseAumCrore(null)).toBeNull();
    expect(parseAumCrore('N/A')).toBeNull();
  });
});

describe('resolving a peer to its AMFI scheme', () => {
  it('picks the plan whose NAV matches, out of four same-named rows', () => {
    const hit = resolvePeerToAmfi(peer(), HDFC_ROWS);
    // A name-only match would take the first row, which is right only by luck; the
    // seeded funds were wrong precisely this way.
    expect(hit?.schemeCode).toBe('118989');
    expect(hit?.isin).toBe('INF179K01XQ0');
  });

  it('tolerates INDmoney rounding the NAV to two decimals', () => {
    // INDmoney says 231.41, AMFI says 231.413.
    expect(resolvePeerToAmfi(peer({ nav: 231.41 }), HDFC_ROWS)?.schemeCode).toBe('118989');
  });

  it('refuses when no NAV matches, rather than falling back to the name', () => {
    // This is the cross-date case: AMFI had rolled to 230.669 while INDmoney still
    // reported 231.41, and matching on name alone would have picked a plan at random.
    expect(resolvePeerToAmfi(peer({ nav: 999.99 }), HDFC_ROWS)).toBeNull();
  });

  it('refuses a peer with no NAV to fingerprint against', () => {
    expect(resolvePeerToAmfi(peer({ nav: null }), HDFC_ROWS)).toBeNull();
  });

  it('never matches a differently named fund on NAV alone', () => {
    const other = [amfi('999999', 'Some Other Fund', 231.413, 'INE999Z01011')];
    expect(resolvePeerToAmfi(peer(), other)).toBeNull();
  });

  it('reports what it could not join instead of dropping it', () => {
    const { resolved, unresolved } = resolvePeers(
      [peer(), peer({ name: 'Nonexistent Fund', nav: 1 })], HDFC_ROWS,
    );
    expect(resolved.map((r) => r.schemeCode)).toEqual(['118989']);
    expect(unresolved).toEqual(['Nonexistent Fund']);
  });
});
