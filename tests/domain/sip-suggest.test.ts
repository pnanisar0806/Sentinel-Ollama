import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseMfSips } from '../../src/sources/indmoney.js';
import {
  FUND_TYPE_BY_ISIN, FUND_TYPE_LABEL, NON_CORE_TYPES, RANGE_TABLE, midBps, neverCut, normalisedMidpointsBps, suggestSips,
  type FundType, type SipSuggestion,
} from '../../src/domain/fund-mix.js';

/** Piece 3 Task 9, Decision 10: suggested SIP amounts toward the signed mix. */
const live = parseMfSips({
  result: JSON.stringify(JSON.parse(await readFile('tests/fixtures/indmoney-mf-sips-2026-10-14.json', 'utf8')).payload),
});
const liveSips = live.map((r) => {
  const t = FUND_TYPE_BY_ISIN[r.isin ?? ''] ?? null;
  return { instrumentId: r.instrumentId, fundName: r.fundName, type: t?.type ?? null, topUp: t?.topUp ?? false, amountPaise: r.amountPaise };
});
const TYPES: FundType[] = ['NIFTY50', 'NEXT50', 'FLEXI', 'LARGE_ACTIVE', 'MID', 'SMALL', 'US'];
const bps = (o: Partial<Record<FundType, number>>) => Object.fromEntries(TYPES.map((t) => [t, o[t] ?? 0])) as Record<FundType, number>;
const noneHeld = () => Object.fromEntries(TYPES.map((t) => [t, []])) as unknown as Parameters<typeof suggestSips>[0]['heldByType'];
const ranges = RANGE_TABLE['15+'];
const sum = (rows: SipSuggestion[]) => rows.reduce((a, r) => a + r.suggestedPaise, 0n);
const liveTotal = live.reduce((a, r) => a + r.amountPaise, 0n);
const capActual = bps({ MID: 0, SMALL: 0, NIFTY50: 5_800, FLEXI: 1_400, US: 0 });

describe('suggestSips', () => {
  it('keeps the typed SIP total exactly; every row but the Nifty 50 anchor is a whole ₹100; none negative', () => {
    expect(liveSips.every((s) => s.type !== null)).toBe(true);
    const rows = suggestSips({ sips: liveSips, ranges, actualBps: capActual, heldByType: noneHeld() });
    expect(sum(rows)).toBe(liveTotal);
    expect(liveTotal % 10_000n).not.toBe(0n); // ₹27,253: the remainder is real
    expect(rows.filter((r) => r.fundType === 'NIFTY50')).toHaveLength(1);
    for (const r of rows.filter((x) => x.fundType !== 'NIFTY50')) expect(r.suggestedPaise % 10_000n).toBe(0n);
    for (const r of rows) expect(r.suggestedPaise >= 0n).toBe(true);
  });

  it('a large-cap active SIP is suggested at ₹0', () => {
    const rows = suggestSips({
      sips: [...liveSips, { instrumentId: 'IND:LA', fundName: 'ICICI Large Cap', type: 'LARGE_ACTIVE', topUp: true, amountPaise: 500_000n }],
      ranges, actualBps: capActual, heldByType: noneHeld(),
    });
    expect(rows.find((r) => r.instrumentId === 'IND:LA')).toMatchObject({
      currentPaise: 500_000n, suggestedPaise: 0n, reason: '0% new money — held, never topped up',
    });
    expect(sum(rows)).toBe(liveTotal + 500_000n);
  });

  it('caps non-core (mid + small + large active) at 30% of the suggested total', () => {
    // Before the cap: each type's weight is mid + max(0, mid − actual).
    const w = (t: FundType) => {
      const r = ranges.find((x) => x.type === t)!;
      return r.newMoney ? midBps(r) + Math.max(0, midBps(r) - capActual[t]) : 0;
    };
    const all = TYPES.reduce((a, t) => a + w(t), 0);
    const nonCore = NON_CORE_TYPES.reduce((a, t) => a + w(t), 0);
    expect(nonCore * 10_000 > 3_000 * all).toBe(true);

    const rows = suggestSips({ sips: liveSips, ranges, actualBps: capActual, heldByType: noneHeld() });
    const total = sum(rows);
    const nc = sum(rows.filter((r) => (NON_CORE_TYPES as readonly (FundType | null)[]).includes(r.fundType)));
    expect(nc * 10_000n <= 3_000n * total + 10_000n * 10_000n).toBe(true);
  });

  it('with actual at the midpoints, each type gets its normalised midpoint share', () => {
    const actual = bps(Object.fromEntries(ranges.map((r) => [r.type, midBps(r)])));
    const rows = suggestSips({ sips: liveSips, ranges, actualBps: actual, heldByType: noneHeld() });
    const total = sum(rows);
    const norm = normalisedMidpointsBps(ranges);
    for (const t of TYPES) {
      const got = sum(rows.filter((r) => r.fundType === t));
      const want = (total * BigInt(norm[t])) / 10_000n;
      const slack = t === 'NIFTY50' ? 10_000n * BigInt(rows.length) : 10_000n;
      expect(got > want ? got - want : want - got).toBeLessThanOrEqual(slack);
    }
  });

  it('an untyped SIP keeps its amount and stays out of the redistribution', () => {
    const rows = suggestSips({
      sips: [...liveSips, { instrumentId: 'IND:X', fundName: 'Mystery Fund', type: null, topUp: false, amountPaise: 123_456n }],
      ranges, actualBps: capActual, heldByType: noneHeld(),
    });
    expect(rows.find((r) => r.instrumentId === 'IND:X')).toMatchObject({ currentPaise: 123_456n, suggestedPaise: 123_456n, fundType: null });
    expect(sum(rows.filter((r) => r.fundType !== null))).toBe(liveTotal);
  });

  it('a type with no held top-uppable fund gets one new-fund row; a held one with no SIP gets the money', () => {
    const held = noneHeld();
    held.US = [{ instrumentId: 'IND:VOO', name: 'Vanguard S&P 500', valuePaise: 9_000_000n, topUp: false }];
    held.MID = [
      { instrumentId: 'IND:SMALLER', name: 'Motilal Midcap', valuePaise: 100n, topUp: true },
      { instrumentId: 'IND:HDFCMID', name: 'HDFC Mid Cap', valuePaise: 900n, topUp: true },
    ];
    const rows = suggestSips({ sips: liveSips, ranges, actualBps: capActual, heldByType: held });
    expect(rows.filter((r) => r.fundType === 'US')).toEqual([
      expect.objectContaining({ instrumentId: null, fundName: 'no eligible fund open — see below', currentPaise: 0n }),
    ]);
    const mid = rows.filter((r) => r.fundType === 'MID');
    expect(mid).toEqual([expect.objectContaining({ instrumentId: 'IND:HDFCMID', currentPaise: 0n })]);
    expect(mid[0]!.suggestedPaise > 0n).toBe(true);
  });

  it('a new-fund row names the chosen index fund; any other empty type says no held fund can take the money', () => {
    const rows = suggestSips({
      sips: liveSips, ranges, actualBps: capActual, heldByType: noneHeld(),
      newFundNames: { NEXT50: 'Edelweiss Nifty Next 50 Index Fund' },
    });
    const empty = rows.filter((r) => r.instrumentId === null);
    expect(empty.find((r) => r.fundType === 'NEXT50')?.fundName).toBe('Edelweiss Nifty Next 50 Index Fund');
    expect(empty.find((r) => r.fundType === 'US')?.fundName).toBe('no eligible fund open — see below');
    const active = empty.filter((r) => r.fundType !== 'US' && r.fundType !== 'NEXT50');
    expect(active.length).toBeGreaterThan(0);
    for (const r of active) expect(r.fundName).toBe(`no held ${FUND_TYPE_LABEL[r.fundType!]} fund can take new money`);
  });

  it('never sends money to a held fund the switch check says to leave; names the switch pick instead', () => {
    const held = noneHeld();
    held.MID = [
      { instrumentId: 'IND:MOTILAL', name: 'Motilal Midcap', valuePaise: 100n, topUp: true },
      { instrumentId: 'IND:HDFCMID', name: 'HDFC Mid Cap', valuePaise: 900n, topUp: true },
    ];
    const leaving = { 'IND:HDFCMID': 'Invesco India Mid Cap Fund' };
    const one = suggestSips({ sips: liveSips, ranges, actualBps: capActual, heldByType: held, leaving });
    expect(one.filter((r) => r.fundType === 'MID')).toEqual([expect.objectContaining({ instrumentId: 'IND:MOTILAL' })]);
    const both = suggestSips({
      sips: liveSips, ranges, actualBps: capActual, heldByType: held,
      leaving: { ...leaving, 'IND:MOTILAL': 'Invesco India Mid Cap Fund' },
    });
    expect(both.filter((r) => r.fundType === 'MID')).toEqual([
      expect.objectContaining({ instrumentId: null, fundName: 'Invesco India Mid Cap Fund', currentPaise: 0n }),
    ]);
    // A live SIP into a fund marked to leave is kept, never raised.
    const flexi = liveSips.find((x) => x.type === 'FLEXI')!;
    const kept = suggestSips({ sips: liveSips, ranges, actualBps: capActual, heldByType: held, leaving: { [flexi.instrumentId]: 'Better Flexi' } });
    expect(kept.filter((r) => r.instrumentId === flexi.instrumentId)).toHaveLength(1);
    expect(kept.find((r) => r.instrumentId === flexi.instrumentId)).toMatchObject({ suggestedPaise: 0n, reason: 'kept, not topped up — the switch check says to leave it' });
  });

  it('a logged SIP input stays logged; feed SIPs and new-fund rows are not (fund switch §3)', () => {
    const held = noneHeld();
    held.MID = [{ instrumentId: 'MF:HDFC-MIDCAP', name: 'HDFC Mid Cap', valuePaise: 900n, topUp: true }];
    const rows = suggestSips({
      sips: [...liveSips, { instrumentId: 'MFU:120505', fundName: 'Invesco India Mid Cap Fund', type: 'MID', topUp: true, amountPaise: 300_100n, logged: true }],
      ranges, actualBps: capActual, heldByType: held, leaving: { 'MF:HDFC-MIDCAP': 'Invesco India Mid Cap Fund' },
    });
    expect(rows.filter((r) => r.logged)).toEqual([expect.objectContaining({ instrumentId: 'MFU:120505', fundType: 'MID', currentPaise: 300_100n })]);
    expect(rows.filter((r) => r.instrumentId === null).length).toBeGreaterThan(0);
    for (const r of rows.filter((x) => x.instrumentId !== 'MFU:120505')) expect(r.logged).toBe(false);
    expect(neverCut(rows).filter((r) => r.logged).map((r) => r.instrumentId)).toEqual(['MFU:120505']);
  });
});

describe('neverCut (owner, 2026-10-28)', () => {
  it('keeps every SIP at least at its current amount; additions are untouched', () => {
    const rows = neverCut(suggestSips({ sips: liveSips, ranges, actualBps: capActual, heldByType: noneHeld() }));
    for (const r of rows) expect(r.suggestedPaise >= r.currentPaise).toBe(true);
    const n50 = rows.find((r) => r.fundType === 'NIFTY50')!;
    expect(n50.suggestedPaise).toBe(n50.currentPaise);
    expect(n50.reason).toMatch(/never suggests cutting/);
    expect(rows.some((r) => r.suggestedPaise > r.currentPaise)).toBe(true);
  });
});

describe('FUND_TYPE_BY_ISIN (owner, 2026-10-29)', () => {
  it('types Invesco India Mid Cap Direct Growth as a top-uppable mid cap', () => {
    // AMFI scheme 120403, ISIN confirmed against mfapi.in and the prod MFU:120403 row.
    expect(FUND_TYPE_BY_ISIN.INF205K01MV6).toEqual({ type: 'MID', topUp: true });
  });
});
