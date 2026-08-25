import { describe, expect, it } from 'vitest';
import {
  normalizeTicker,
  resolveTicker,
  tickerForInstrument,
} from '../../src/sources/statement-tickers.js';

/**
 * Owner-verified Zerodha symbol map. The whole point: TMCV and TMPV are DISTINCT
 * holdings whose long names differ by one word — the exact pair a fuzzy anchor
 * flipped three times on 2026-08-25.
 */
describe('statement tickers', () => {
  it('resolves the demerger pair to two different instruments', () => {
    expect(resolveTicker('TMCV')).toBe('IND:INDS39566'); // Tata Motors Ltd
    expect(resolveTicker('TMPV')).toBe('IND:INDS00954'); // Tata Motors PV Ltd
  });

  it('normalizes punctuation and case — M&M, m & m, mm all hit', () => {
    expect(normalizeTicker('M&M')).toBe('MM');
    expect(resolveTicker('M&M')).toBe('IND:INDS01150');
    expect(resolveTicker('m & m')).toBe('IND:INDS01150');
    expect(resolveTicker('GoldCase')).toBe('IND:INDS29570');
  });

  it('refuses unknown symbols instead of guessing (FR-02)', () => {
    expect(resolveTicker('SOMETHINGNEW')).toBeUndefined();
    expect(resolveTicker('')).toBeUndefined();
  });

  it('round-trips through the reverse view for prompt hints', () => {
    expect(tickerForInstrument('IND:INDS39566')).toBe('TMCV');
    expect(tickerForInstrument('IND:DOES-NOT-EXIST')).toBeUndefined();
  });
});
