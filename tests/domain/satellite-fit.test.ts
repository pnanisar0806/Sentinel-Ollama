import { describe, expect, it } from 'vitest';
import { satelliteFit } from '../../src/domain/allocation.js';
import type { Position } from '../../src/domain/networth.js';

/**
 * `fit` is 20 of the satellite composite's 100 points, in two halves: headroom (10) and
 * sector balance (10). `report.ts` passed `headroomPaise: 0n` and `sectorWeightPct: {}`
 * as literals, so headroom scored 0 for every name and balance scored a full 10 for
 * every name, on every run, forever. Both halves were stubs — one pinned to the floor,
 * one to the ceiling — and neither said anything about the candidate.
 *
 * IPS §3.4 (amended by the owner 2026-10-23): core ≥70% / non-core ≤30% of equity.
 * Non-core is agent-recommended DIRECT stocks plus typed MID, SMALL and LARGE_ACTIVE
 * funds. Headroom is what is left under that cap.
 */
const pos = (over: Partial<Position>): Position => ({
  instrumentId: 'NSE:X', name: 'X', kind: 'EQUITY', account: 'zerodha',
  valuePaise: 0n as never, avgCostPaise: null, assetClass: 'EQUITY', issuer: null,
  sector: null, currency: 'INR', isEmployer: false, asOf: '2026-09-21', source: 'test',
  ...over,
} as Position);

describe('satellite fit is measured, not stubbed', () => {
  it('reports headroom under the 30% cap', () => {
    // Rs 10,00,000 of equity, of which Rs 1,50,000 is a direct stock.
    // Cap is 30% = Rs 3,00,000, so Rs 1,50,000 of room remains.
    const fit = satelliteFit([
      pos({ instrumentId: 'NSE:DIRECT', valuePaise: 15_000_000n as never }),
      pos({ instrumentId: 'MF:INDEX', kind: 'MF', valuePaise: 85_000_000n as never }),
    ], new Set());
    expect(fit.headroomPaise).toBe(15_000_000n);
  });

  it('counts a non-core fund against the cap', () => {
    // Same Rs 10,00,000 of equity; Rs 1,00,000 of the index money is now a MID fund.
    // Rs 3,00,000 − (Rs 1,50,000 stock + Rs 1,00,000 MID) = Rs 50,000.
    const fit = satelliteFit(
      [
        pos({ instrumentId: 'NSE:DIRECT', valuePaise: 15_000_000n as never }),
        pos({ instrumentId: 'MF:MID', kind: 'MF', valuePaise: 10_000_000n as never }),
        pos({ instrumentId: 'MF:INDEX', kind: 'MF', valuePaise: 75_000_000n as never }),
      ],
      new Set(['MF:MID']),
    );
    expect(fit.headroomPaise).toBe(5_000_000n);
  });

  it('reports no headroom when the satellite bucket is already full', () => {
    const fit = satelliteFit([
      pos({ instrumentId: 'NSE:DIRECT', valuePaise: 40_000_000n as never }),
      pos({ instrumentId: 'MF:INDEX', kind: 'MF', valuePaise: 60_000_000n as never }),
    ], new Set());
    // Direct stocks are 40% of equity against a 30% cap. Over, so nothing is left.
    expect(fit.headroomPaise).toBe(0n);
  });

  it('counts the employer RSU as equity but never as satellite', () => {
    // The satellite bucket is agent-recommended direct stocks. An RSU vest is neither
    // agent-recommended nor sellable at will, and counting it would consume the whole
    // bucket on a position the advisor did not choose.
    const fit = satelliteFit([
      pos({ instrumentId: 'US:NOW', kind: 'RSU', isEmployer: true, valuePaise: 40_000_000n as never }),
      pos({ instrumentId: 'MF:INDEX', kind: 'MF', valuePaise: 60_000_000n as never }),
    ], new Set());
    // Equity Rs 10,00,000, cap 30% = Rs 3,00,000, nothing counted against it.
    expect(fit.headroomPaise).toBe(30_000_000n);
  });

  it('ignores non-equity when sizing the bucket', () => {
    // Cash and debt are not equity, so they must not inflate the 30%.
    const fit = satelliteFit([
      pos({ instrumentId: 'NSE:DIRECT', valuePaise: 12_000_000n as never }),
      pos({ instrumentId: 'MF:INDEX', kind: 'MF', valuePaise: 28_000_000n as never }),
      pos({ instrumentId: 'CASH:X', kind: 'CASH', assetClass: 'CASH', valuePaise: 60_000_000n as never }),
    ], new Set());
    // Equity is Rs 4,00,000, cap Rs 1,20,000, direct holding Rs 1,20,000 — exactly full.
    expect(fit.headroomPaise).toBe(0n);
  });

  it('reports sector weights as a share of the portfolio', () => {
    const fit = satelliteFit([
      pos({ instrumentId: 'NSE:A', sector: 'IT Services', valuePaise: 25_000_000n as never }),
      pos({ instrumentId: 'NSE:B', sector: 'Banking', valuePaise: 25_000_000n as never }),
      pos({ instrumentId: 'MF:INDEX', kind: 'MF', valuePaise: 50_000_000n as never }),
    ], new Set());
    expect(fit.sectorWeightPct['IT Services']).toBe(25);
    expect(fit.sectorWeightPct['Banking']).toBe(25);
  });

  it('leaves a sectorless position out of the weights rather than bucketing it', () => {
    const fit = satelliteFit([
      pos({ instrumentId: 'NSE:A', sector: null, valuePaise: 50_000_000n as never }),
      pos({ instrumentId: 'NSE:B', sector: 'Banking', valuePaise: 50_000_000n as never }),
    ], new Set());
    // 39 of 73 watchlist instruments carry no sector. An 'unknown' bucket would compete
    // for the sector cap against real sectors and read as a genuine concentration.
    expect(Object.keys(fit.sectorWeightPct)).toEqual(['Banking']);
    expect(fit.sectorWeightPct['Banking']).toBe(50);
  });

  it('is empty on an empty portfolio rather than dividing by zero', () => {
    const fit = satelliteFit([], new Set());
    expect(fit.headroomPaise).toBe(0n);
    expect(fit.sectorWeightPct).toEqual({});
  });
});
