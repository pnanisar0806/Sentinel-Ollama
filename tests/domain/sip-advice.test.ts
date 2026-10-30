import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { parseMfSips } from '../../src/sources/indmoney.js';
import { istDate, istMonth, persistSipSnapshot } from '../../src/domain/sips.js';
import { approveMix, proposeMix, type SipSuggestion } from '../../src/domain/fund-mix.js';
import { logSipMove } from '../../src/domain/owner-log.js';
import { capToBudget, loadSipSuggestions, tacticalCapBinds } from '../../src/domain/sip-advice.js';

/** Batch B §5/§6: the SIP card never suggests a total above the monthly budget; the tactical-cap warning. */
const R = (rupees: number) => BigInt(rupees) * 100n;
const row = (current: number, suggested: number, i = 0): SipSuggestion => ({
  fundType: 'NIFTY50', instrumentId: `IND:${i}`, fundName: `Fund ${i}`, currentPaise: R(current), suggestedPaise: R(suggested), reason: 'r', logged: false,
});
const sum = (rows: SipSuggestion[], k: 'currentPaise' | 'suggestedPaise') => rows.reduce((a, r) => a + r[k], 0n);

describe('capToBudget', () => {
  it('leaves a total within budget alone', () => {
    const rows = [row(30_254, 45_000)];
    expect(capToBudget(rows, R(50_000))).toEqual({ rows, capped: false });
  });

  it('scales increases pro rata to ₹100 (live 2026-10-30 rows, budget ₹48,000)', () => {
    const rows = [[14_001, 14_001], [0, 10_954], [0, 2_000], [11_001, 11_001], [3_001, 6_100], [2_251, 2_900], [0, 3_200]]
      .map(([c, s], i) => row(c!, s!, i));
    expect(sum(rows, 'suggestedPaise')).toBe(R(50_156));
    const out = capToBudget(rows, R(48_000));
    expect(out.capped).toBe(true);
    expect(sum(out.rows, 'suggestedPaise') <= R(48_000)).toBe(true);
    out.rows.forEach((r, i) => {
      expect(r.currentPaise).toBe(rows[i]!.currentPaise);
      expect(r.suggestedPaise >= r.currentPaise).toBe(true);
      expect((r.suggestedPaise - r.currentPaise) % R(100)).toBe(0n);
      if (rows[i]!.suggestedPaise > rows[i]!.currentPaise) expect(r.reason).toBe('r; scaled to fit the ₹48,000 monthly budget');
      else expect(r.reason).toBe('r');
    });
    // room ₹17,746 over Σ inc ₹19,902; each floored to ₹100.
    expect(out.rows.map((r) => r.suggestedPaise - r.currentPaise)).toEqual([0n, R(9_700), R(1_700), 0n, R(2_700), R(500), R(2_800)]);
  });

  it('never cuts when SIPs already exceed the budget', () => {
    const out = capToBudget([row(40_000, 40_000, 0), row(12_000, 15_000, 1)], R(50_000));
    expect(out.capped).toBe(true);
    for (const r of out.rows) expect(r.suggestedPaise).toBe(r.currentPaise);
    expect(out.rows[1]!.reason).toBe('r; no increase — current SIPs already use the ₹50,000 budget');
  });
});

describe('tacticalCapBinds', () => {
  it('binds only when the cap is below budget − SIPs', () => {
    expect(tacticalCapBinds({ budgetPaise: R(50_000), sipTotalPaise: R(30_254), tacticalPaise: R(50_000) })).toBeNull();
    expect(tacticalCapBinds({ budgetPaise: R(100_000), sipTotalPaise: R(30_254), tacticalPaise: R(50_000) }))
      .toEqual({ capPaise: 5_000_000n, freePaise: 6_974_600n });
    expect(tacticalCapBinds({ budgetPaise: R(100_000), sipTotalPaise: null, tacticalPaise: R(50_000) })).toBeNull();
  });
});

describe('loadSipSuggestions', () => {
  it('matches the /funds getter on the fund-switch fixture', async () => {
    // tests/web/funds-sips-shape.test.ts's fund-switch fixture: HDFC Mid Cap → Invesco logged, feed still lists HDFC.
    const live = parseMfSips({ result: JSON.stringify(JSON.parse(await readFile('tests/fixtures/indmoney-mf-sips-2026-10-14.json', 'utf8')).payload) });
    const d = await openDb();
    await runMigrations(d);
    const now = new Date().toISOString();
    expect(await loadSipSuggestions(d, now)).toEqual({ rows: null, reason: 'approve the fund mix first' });
    await approveMix(d, { band: proposeMix(now).band! }, now);
    await d.query(`insert into instruments (id, kind, name, currency, isin, metadata) values
      ('MF:HDFC-MIDCAP', 'MF', 'HDFC Mid Cap Opportunities Direct', 'INR', 'INF179K01XQ0', jsonb_build_object('amfiCategory', $1::text)),
      ('MFU:120505', 'MF', 'Invesco India Mid Cap Fund', 'INR', 'INF205K01MN9', jsonb_build_object('category', $1::text)),
      ('MF:ICICI-N50', 'MF', 'ICICI Pru Nifty 50 Index Direct', 'INR', 'INF109K012M7', '{}')`, ['Equity Scheme - Mid Cap Fund']);
    const [snap] = await d.query<{ id: string }>(`insert into snapshots (business_date, source) values ($1::date, 'indmoney') returning id`, [istDate(now)]);
    await d.query(`insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
      values ($1, 'MF:HDFC-MIDCAP', 'indmoney', 1, 2626900, 'indmoney', $2), ($1, 'MF:ICICI-N50', 'indmoney', 1, 68843200, 'indmoney', $2)`, [snap!.id, now]);
    await logSipMove(d, { on: istDate(now), fromInstrumentId: 'MF:HDFC-MIDCAP', toInstrumentId: 'MFU:120505', amountPaise: 300_100n, firstMonth: istMonth(now), note: '' }, now);
    const hdfc = { ...live[0]!, sipId: 'HDFC-1', instrumentId: 'IND:3097', isin: 'INF179K01XQ0', fundName: 'HDFC Mid Cap Opportunities Direct Growth', amountPaise: 300_100n };
    await persistSipSnapshot(d, [...live, hdfc], now);

    const r = await loadSipSuggestions(d, now);
    if (r.rows === null) throw new Error(r.reason);
    // Captured from the pre-move web getSipSuggestions on this exact fixture (2026-10-30).
    expect(r.rows.map((s) => [s.fundType, s.instrumentId, s.currentPaise, s.suggestedPaise, s.logged])).toEqual([
      ['NIFTY50', 'IND:5536', 1_400_100n, 1_400_100n, false],
      ['NEXT50', null, 0n, 200_000n, false],
      ['FLEXI', 'IND:3229', 1_100_100n, 1_100_100n, false],
      ['MID', 'MFU:120505', 300_100n, 530_000n, true],
      ['SMALL', 'IND:1005544', 225_100n, 300_000n, false],
      ['US', null, 0n, 300_000n, false],
    ]);
    expect(r).toMatchObject({ currentPaise: 3_025_400n, suggestedPaise: 3_830_200n, budgetPaise: 5_000_000n, capped: false });
    await d.close();
  });
});
