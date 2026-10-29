import { describe, expect, it } from 'vitest';
import { chooseIndexFund, type IndexFundRow } from '../../src/sources/index-funds.js';
import { INDEX_SWITCH_MIN_BPS, indexChallenger } from '../../src/domain/index-switch.js';

/** Spec §4.4: a same-index challenger must be at least 0.10 points a year cheaper. */
const row = (over: Partial<IndexFundRow>): IndexFundRow => ({
  fundType: 'NIFTY50', indmoneyFundId: '1039539', name: 'Navi Nifty 50 Index Fund', benchmarkName: 'Nifty 50 TR INR',
  amfiSchemeCode: '100', expenseRatioBps: 9, aumPaise: 1_000_000_000_000n, trackingErrorBps: null, sipAllowed: true,
  asOf: '2026-10-28', source: 'indmoney-mcp', ...over,
});
const held = { indmoneyFundId: 'IND:5536', expenseRatioBps: 20 };
const choice = (...rows: IndexFundRow[]) => chooseIndexFund(rows, 'NIFTY50');

describe('indexChallenger', () => {
  it('a peer 0.11 points cheaper is the challenger', () => {
    const r = indexChallenger(held, choice(row({})));
    expect(r.challenger?.indmoneyFundId).toBe('1039539');
    expect(r.reason).toBe('Navi Nifty 50 Index Fund costs 0.09% a year against 0.20%, 0.11 points cheaper');
  });

  it('exactly the bar clears it', () => {
    expect(INDEX_SWITCH_MIN_BPS).toBe(10);
    const r = indexChallenger({ ...held, expenseRatioBps: 19 }, choice(row({})));
    expect(r.challenger).not.toBeNull();
    expect(r.reason).toBe('Navi Nifty 50 Index Fund costs 0.09% a year against 0.19%, 0.10 points cheaper');
  });

  it('short of the bar: no challenger', () => {
    expect(indexChallenger({ ...held, expenseRatioBps: 18 }, choice(row({}))))
      .toEqual({ challenger: null, reason: 'cheapest same-index fund is 0.09 points cheaper, short of the 0.10-point bar' });
  });

  it('held fund is already the top', () => {
    const own = row({ indmoneyFundId: '5536', name: 'ICICI Prudential Nifty 50 Index Fund', expenseRatioBps: 20 });
    expect(indexChallenger(held, choice(own, row({ indmoneyFundId: 'x', expenseRatioBps: 30 }))))
      .toEqual({ challenger: null, reason: 'already the cheapest eligible Nifty 50 fund' });
  });

  it('no eligible peer is cheaper than the held fund', () => {
    expect(indexChallenger({ ...held, expenseRatioBps: 5 }, choice(row({}))))
      .toEqual({ challenger: null, reason: 'no eligible same-index fund is cheaper' });
  });

  it('held expense ratio unknown', () => {
    expect(indexChallenger({ ...held, expenseRatioBps: null }, choice(row({}))))
      .toEqual({ challenger: null, reason: 'expense ratio unknown' });
  });

  it('no peers on record', () => {
    expect(indexChallenger(held, choice())).toEqual({ challenger: null, reason: 'no same-index peers on record' });
  });

  it('peers on record but every one closed to SIPs: says so, not "no peers"', () => {
    expect(indexChallenger(held, choice(row({ sipAllowed: false }))))
      .toEqual({ challenger: null, reason: 'no eligible same-index fund: closed to new SIPs on INDmoney' });
  });
});
