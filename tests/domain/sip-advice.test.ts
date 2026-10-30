import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { parseMfSips, type SipRow } from '../../src/sources/indmoney.js';
import { istDate, istMonth, persistSipSnapshot } from '../../src/domain/sips.js';
import { approveMix, proposeMix, type SipSuggestion } from '../../src/domain/fund-mix.js';
import { logSipMove } from '../../src/domain/owner-log.js';
import { capToBudget, loadSipSuggestions, monthlySipBlock, sipCapLabel, sipCapSentence, sipChanges, sipDueLines, tacticalCapBinds } from '../../src/domain/sip-advice.js';
import { monthlyReviewDone } from '../../src/domain/cadence.js';

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

  it('flat rows already over the cap: capped, and the card copy says no increase is suggested', () => {
    const rows = [row(40_000, 40_000, 0), row(12_000, 12_000, 1)];
    const out = capToBudget(rows, R(50_000));
    expect(out).toEqual({ rows, capped: true });
    const text = sipCapSentence({ currentPaise: R(52_000), budgetPaise: R(50_000), setAsidePaise: 0n, capped: out.capped });
    expect(text).toBe('Current SIPs already use the ₹50,000 budget; no increase is suggested.');
    expect(text).not.toMatch(/stays within/);
  });
});

describe('SIP card copy (batch B §5; set-aside ruling)', () => {
  it('names the budget, or the investable amount when a set-aside exists', () => {
    expect(sipCapLabel(R(50_000), 0n)).toBe('the ₹50,000 budget');
    expect(sipCapLabel(R(50_000), R(10_000)))
      .toBe('the ₹40,000 you invest each month (budget ₹50,000 less ₹10,000 set aside for house and emergency)');
    expect(sipCapSentence({ currentPaise: R(30_254), budgetPaise: R(50_000), setAsidePaise: 0n, capped: false }))
      .toBe('No SIP is ever suggested below its current amount, and increases are capped so the suggested total stays within the ₹50,000 budget.');
    expect(sipCapSentence({ currentPaise: R(30_254), budgetPaise: R(50_000), setAsidePaise: R(10_000), capped: true }))
      .toMatch(/stays within the ₹40,000 you invest each month .* — this month they were scaled down to fit\.$/);
    expect(sipCapSentence({ currentPaise: R(45_000), budgetPaise: R(50_000), setAsidePaise: R(10_000), capped: true }))
      .toMatch(/^Current SIPs already use the ₹40,000 you invest each month/);
  });
});

describe('tacticalCapBinds', () => {
  it('binds only when the cap is below budget − SIPs', () => {
    expect(tacticalCapBinds({ budgetPaise: R(50_000), sipTotalPaise: R(30_254), tacticalPaise: R(50_000), setAsidePaise: 0n })).toBeNull();
    expect(tacticalCapBinds({ budgetPaise: R(100_000), sipTotalPaise: R(30_254), tacticalPaise: R(50_000), setAsidePaise: 0n }))
      .toEqual({ capPaise: 5_000_000n, freePaise: 6_974_600n });
    expect(tacticalCapBinds({ budgetPaise: R(100_000), sipTotalPaise: null, tacticalPaise: R(50_000), setAsidePaise: 0n })).toBeNull();
  });

  it('free money excludes the goal set-aside', () => {
    // budget ₹1,00,000 − SIPs ₹30,254 − set-aside ₹10,000 = ₹59,746 free; cap ₹50,000 still binds.
    expect(tacticalCapBinds({ budgetPaise: R(100_000), sipTotalPaise: R(30_254), tacticalPaise: R(50_000), setAsidePaise: R(10_000) }))
      .toEqual({ capPaise: 5_000_000n, freePaise: 5_974_600n });
    // set-aside ₹25,000 leaves ₹44,746 free: the ₹50,000 cap no longer binds.
    expect(tacticalCapBinds({ budgetPaise: R(100_000), sipTotalPaise: R(30_254), tacticalPaise: R(50_000), setAsidePaise: R(25_000) })).toBeNull();
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
    expect(r).toMatchObject({ currentPaise: 3_025_400n, suggestedPaise: 3_830_200n, budgetPaise: 5_000_000n, setAsidePaise: 0n, capped: false });

    // Set-aside ruling: the SIP card stays within budget − set-aside (₹50,000 default budget rail).
    const setAside = (v: number) => d.query(`insert into settings_rails (key, value) values ('goal_setaside_monthly_paise', $1::jsonb)
      on conflict (key) do update set value = excluded.value`, [JSON.stringify(v)]);
    for (const [aside, cap] of [[1_000_000, 4_000_000n], [1_500_000, 3_500_000n]] as const) {
      await setAside(aside);
      const s = await loadSipSuggestions(d, now);
      if (s.rows === null) throw new Error(s.reason);
      expect(s).toMatchObject({ budgetPaise: 5_000_000n, setAsidePaise: BigInt(aside) });
      expect(s.suggestedPaise <= cap).toBe(true);
      for (const x of s.rows) expect(x.suggestedPaise >= x.currentPaise).toBe(true);
    }
    // ₹38,302 unscaled fits ₹40,000 but not ₹35,000: the second pass had to scale.
    expect(await loadSipSuggestions(d, now)).toMatchObject({ capped: true });
    await d.close();
  });
});

/** Batch B §4/§5: the monthly SIP block in the weekly report — changes from the feed and due advice. */
describe('monthly SIP block', () => {
  const sip = (sipId: string, instrumentId: string, isin: string | null, fundName: string, rupees: number, stepUpRaw: number | null = null): SipRow => ({
    sipId, instrumentId, isin, fundName, fundType: 'Equity', category: null, frequency: 'MONTHLY',
    amountPaise: R(rupees), stepUpRaw, stepUpFreq: stepUpRaw === null ? null : 'YEARLY', startDate: '2025-11-05',
  });
  const icici = sip('ICICI-1', 'IND:5536', 'INF109K012M7', 'ICICI Prudential Nifty 50 Index Plan Direct Growth', 14_001);
  const october = [icici, sip('BANDHAN-1', 'IND:1005544', 'INF194KB1AL4', 'Bandhan Small Cap Fund Direct Growth', 2_251, 1000),
    sip('HDFC-1', 'IND:3097', 'INF179K01XQ0', 'HDFC Mid Cap Opportunities Direct Growth', 3_001),
    sip('MOTILAL-1', 'IND:MO', 'INF247L01445', 'Motilal Oswal Midcap Fund Direct Growth', 2_000)];
  const november = [icici, sip('BANDHAN-1', 'IND:1005544', 'INF194KB1AL4', 'Bandhan Small Cap Fund Direct Growth', 3_251, 1000),
    sip('EDEL-1', 'IND:ED', 'INF754K01SZ5', 'Edelweiss Nifty Next 50 Index Fund Direct Growth', 2_000)];
  const OCT = '2026-10-02T03:00:00.000Z';
  const NOV = '2026-11-01T03:00:00.000Z';

  async function db() {
    const d = await openDb();
    await runMigrations(d);
    await approveMix(d, { band: proposeMix(OCT).band! }, OCT);
    await persistSipSnapshot(d, october, OCT);
    return d;
  }

  it('sipChanges lists a new SIP, a raise, a logged move and an unexplained stop', async () => {
    const d = await db();
    await persistSipSnapshot(d, november, NOV);
    await d.query(`insert into instruments (id, kind, name, currency, isin, metadata) values
      ('MF:HDFC-MIDCAP', 'MF', 'HDFC Mid Cap Opportunities Direct', 'INR', 'INF179K01XQ0', jsonb_build_object('amfiCategory', $1::text)),
      ('MFU:120403', 'MF', 'Invesco India Mid Cap Direct Growth', 'INR', 'INF205K01MV6', jsonb_build_object('category', $1::text))`,
    ['Equity Scheme - Mid Cap Fund']);
    await logSipMove(d, { on: '2026-10-20', fromInstrumentId: 'MF:HDFC-MIDCAP', toInstrumentId: 'MFU:120403', amountPaise: R(3_001), firstMonth: '2026-11', note: '' }, NOV);

    expect(await sipChanges(d, '2026-11-01T06:00:00.000Z', null)).toEqual({ lines: [] });
    const r = await sipChanges(d, '2026-11-01T06:00:00.000Z', '2026-10-04T00:00:00.000Z');
    if (!('lines' in r)) throw new Error(r.unknown);
    expect([...r.lines].sort()).toEqual([
      'Bandhan Small Cap Fund Direct Growth SIP ₹2,251 → ₹3,251 (step-up)',
      'HDFC Mid Cap Opportunities Direct Growth SIP moved to Invesco India Mid Cap Direct Growth (logged)',
      'Motilal Oswal Midcap Fund Direct Growth SIP stopped — moved anywhere? Log it under Move a SIP',
      'new SIP: Edelweiss Nifty Next 50 Index Fund Direct Growth, ₹2,000 — type unknown',
    ]);
    await d.close();
  });

  it('a stale feed prints the reason and leaves the month open', async () => {
    const d = await db();
    const block = await monthlySipBlock(d, '2026-10-12', '2026-10-12T03:00:00.000Z');
    expect(block).toContain('SIPs: SIP feed is stale (last 2026-10-02)');
    expect(block).not.toMatch(/no change/i);
    expect(await monthlyReviewDone(d, 'sip', '2026-10')).toBe(false);
    await d.close();
  });

  it('sipAdviceDue ignores drifts under ₹1,000 or 20%', () => {
    expect(sipDueLines([row(14_001, 14_900)], [])).toEqual([]);
    expect(sipDueLines([row(14_001, 17_000)], [])).toEqual(['Fund 0 SIP ₹14,001 → ₹17,000']);
    // 45% but under ₹1,000: not due.
    expect(sipDueLines([row(2_000, 2_900)], [])).toEqual([]);
    expect(sipDueLines([{ ...row(0, 3_000), fundType: 'US', instrumentId: null, fundName: 'Motilal Oswal S&P 500' }], [])).toEqual(['Start a US index SIP: Motilal Oswal S&P 500, ₹3,000']);
    const move = { instrumentId: 'IND:3097', name: 'HDFC Mid Cap', category: 'Mid Cap', isIndex: false, units: { kind: 'keep', why: '' },
      sip: { kind: 'move', amountPaise: R(3_001), toId: 'X', toName: 'Invesco India Mid Cap', why: 'better 5y return' } } as const;
    expect(sipDueLines([], [move, { ...move, sip: { kind: 'keep', amountPaise: R(3_001) } }])).toEqual(['Move the HDFC Mid Cap SIP to Invesco India Mid Cap: better 5y return']);
  });

  it('the block is sent once a month', async () => {
    const d = await db();
    await monthlySipBlock(d, '2026-10-04', '2026-10-04T03:00:00.000Z');
    expect(await monthlyReviewDone(d, 'sip', '2026-10')).toBe(true);
    expect(await monthlySipBlock(d, '2026-10-05', '2026-10-05T03:00:00.000Z')).toBe('');
    await persistSipSnapshot(d, november, NOV);
    const block = await monthlySipBlock(d, '2026-11-01', '2026-11-01T06:00:00.000Z');
    expect(block).toMatch(/^\n\nSIPs this month:\n/);
    expect(block).toContain('new SIP: Edelweiss Nifty Next 50 Index Fund Direct Growth, ₹2,000');
    expect(block).toMatch(/\nDetails on Funds\.$/);
    await d.close();
  });

  it('reads the previous sinceIso from a jsonb-string payload (prod postgres-js)', async () => {
    const d = await db();
    await d.query(`insert into audit_log (entity, entity_id, action, actor, payload)
      values ('monthly_review', 'sip:2026-10', 'REVIEWED', 'agent', to_jsonb($1::text))`,
    [JSON.stringify({ kind: 'sip', month: '2026-10', sinceIso: '2026-10-04T03:00:00.000Z' })]);
    await persistSipSnapshot(d, november, NOV);
    expect(await monthlySipBlock(d, '2026-11-01', '2026-11-01T06:00:00.000Z')).toContain('new SIP: Edelweiss');
    await d.close();
  });
});
