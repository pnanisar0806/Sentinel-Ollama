import { afterEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { RANGE_TABLE, approveMix, proposeMix, suggestSips, type FundType, type SipInput } from '../../src/domain/fund-mix.js';
import { loadSipSuggestions } from '../../src/domain/sip-advice.js';
import { loadFundMoves } from '../../src/domain/fund-moves.js';
import { loadExitCandidates, persistExitCandidates } from '../../src/domain/sell-triggers.js';
import { logHoldingRule, logRuleException } from '../../src/domain/holding-rules.js';
import { persistUniverse } from '../../src/domain/mf-universe.js';
import { istDate, istMonth, persistSipSnapshot } from '../../src/domain/sips.js';
import type { SipRow } from '../../src/sources/indmoney.js';
import { recordProposal, loadProposals } from '../../src/advisor/proposals.js';
import { signAdvice } from '../../src/domain/advisor-handoff.js';

/** Batch C Task 4: holding rules inside SIP suggestions, the switch check and exit candidates. */
const R = (rupees: number) => BigInt(rupees) * 100n;
const TYPES: FundType[] = ['NIFTY50', 'NEXT50', 'FLEXI', 'LARGE_ACTIVE', 'MID', 'SMALL', 'US'];
const zero = Object.fromEntries(TYPES.map((t) => [t, 0])) as Record<FundType, number>;
const noneHeld = () => Object.fromEntries(TYPES.map((t) => [t, []])) as unknown as Parameters<typeof suggestSips>[0]['heldByType'];

let db: Db | null = null;
afterEach(async () => { await db?.close(); db = null; });

describe('suggestSips with a ruled SIP', () => {
  const sips = (a: number, b: number): SipInput[] => [
    { instrumentId: 'IND:N50', fundName: 'Nifty 50', type: 'NIFTY50', topUp: true, amountPaise: R(15_000 - a - b) },
    { instrumentId: 'IND:MA', fundName: 'Mid A', type: 'MID', topUp: true, amountPaise: R(a) },
    { instrumentId: 'IND:MB', fundName: 'Mid B', type: 'MID', topUp: true, amountPaise: R(b) },
  ];
  const run = (s: SipInput[]) => suggestSips({ sips: s, ranges: RANGE_TABLE['15+'], actualBps: zero, heldByType: noneHeld() });
  const rule = (s: SipInput[]) => s.map((x) => (x.instrumentId === 'IND:MA' ? { ...x, ruled: 'your no new money rule on Mid A' } : x));
  const get = (rows: ReturnType<typeof run>, id: string) => rows.find((r) => r.instrumentId === id)!;
  const mid = (rows: ReturnType<typeof run>) => rows.filter((r) => r.fundType === 'MID').reduce((x, r) => x + r.suggestedPaise, 0n);

  it('keeps the ruled SIP at its amount; the other Mid cap SIP takes the type\'s whole addition', () => {
    const free = run(sips(500, 500));
    const ruled = run(rule(sips(500, 500)));
    const a = get(ruled, 'IND:MA');
    const b = get(ruled, 'IND:MB');
    expect(get(free, 'IND:MA').suggestedPaise > R(500)).toBe(true); // Mid cap is underweight: an addition exists
    expect(a.suggestedPaise).toBe(R(500));
    // It names what it refused: the addition the free re-split gave it (that row is floored to ₹100).
    const refused = /^kept — your no new money rule on Mid A; ₹([\d,]+) went to the others$/.exec(a.reason);
    expect(refused).not.toBeNull();
    const x = R(Number(refused![1]!.replace(/,/g, ''))) - (get(free, 'IND:MA').suggestedPaise - R(500));
    expect(x >= 0n && x < R(100)).toBe(true);
    // The type's money is unchanged up to the rows' ₹100 floors (two rows floored before, one after):
    // Mid B = the type's money less Mid A's ₹500.
    const diff = mid(free) - mid(ruled);
    expect(diff > -R(200) && diff < R(100)).toBe(true);
    expect(b.suggestedPaise - b.currentPaise).toBe(mid(ruled) - R(1_000));
    // The typed total stays exact (the anchor takes only the rounding remainder).
    expect(ruled.reduce((x, r) => x + r.suggestedPaise, 0n)).toBe(R(15_000));
  });

  it('a ruled amount off the ₹100 grid that nothing cuts: the typed total stays exact, and the row carries its rule id', () => {
    // ₹13,999 / ₹501 / ₹500: Mid cap's share exceeds both, so the rule cuts nothing.
    const s: SipInput[] = [
      { instrumentId: 'IND:N50', fundName: 'Nifty 50', type: 'NIFTY50', topUp: true, amountPaise: R(13_999) },
      { instrumentId: 'IND:MA', fundName: 'Mid A', type: 'MID', topUp: true, amountPaise: R(501), ruled: 'your no new money rule on Mid A', ruleId: '7' },
      { instrumentId: 'IND:MB', fundName: 'Mid B', type: 'MID', topUp: true, amountPaise: R(500) },
    ];
    const rows = run(s);
    expect(get(rows, 'IND:MA')).toMatchObject({ suggestedPaise: R(501), ruleId: '7' });
    expect(rows.reduce((x, r) => x + r.suggestedPaise, 0n)).toBe(R(15_000));
    expect(get(run(sips(500, 500)), 'IND:MA').ruleId).toBeUndefined();
  });

  it('a ruled SIP the re-split would cut refuses nothing: the others and the anchor are as without the rule', () => {
    const free = run(sips(3_000, 2_000));
    const ruled = run(rule(sips(3_000, 2_000)));
    expect(get(free, 'IND:MA').suggestedPaise < R(3_000)).toBe(true);
    expect(get(ruled, 'IND:MA').suggestedPaise).toBe(R(3_000));
    expect(get(ruled, 'IND:MB').suggestedPaise).toBe(get(free, 'IND:MB').suggestedPaise);
    expect(get(ruled, 'IND:N50').suggestedPaise).toBe(get(free, 'IND:N50').suggestedPaise);
  });

  it('a ruled held fund never takes the type\'s money when no SIP of the type runs', () => {
    const held = noneHeld();
    held.MID = [
      { instrumentId: 'IND:BIG', name: 'Big Mid', valuePaise: R(90_000), topUp: true, ruled: 'your no new money rule on Big Mid' },
      { instrumentId: 'IND:SMALLER', name: 'Smaller Mid', valuePaise: R(10_000), topUp: true },
    ];
    const rows = suggestSips({ sips: [sips(0, 0)[0]!], ranges: RANGE_TABLE['15+'], actualBps: zero, heldByType: held });
    expect(rows.find((r) => r.fundType === 'MID')!.instrumentId).toBe('IND:SMALLER');
  });
});

describe('loadSipSuggestions with rules', () => {
  const sip = (sipId: string, instrumentId: string, isin: string, fundName: string, rupees: number): SipRow => ({
    sipId, instrumentId, isin, fundName, fundType: 'Equity', category: null, frequency: 'MONTHLY',
    amountPaise: R(rupees), stepUpRaw: null, stepUpFreq: null, startDate: '2025-11-05',
  });

  async function fixture(now: string) {
    db = await openDb();
    await runMigrations(db);
    await approveMix(db, { band: proposeMix(now).band! }, now);
    await db.query(`insert into instruments (id, kind, name, currency, isin, metadata) values
      ('MF:ICICI-N50', 'MF', 'ICICI Pru Nifty 50 Index Direct', 'INR', 'INF109K012M7', '{}'),
      ('MF:HDFC-MIDCAP', 'MF', 'HDFC Mid Cap Opportunities Direct', 'INR', 'INF179K01XQ0', '{}')`);
    const [snap] = await db.query<{ id: string }>(`insert into snapshots (business_date, source) values ($1::date, 'indmoney') returning id`, [istDate(now)]);
    await db.query(`insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
      values ($1, 'MF:HDFC-MIDCAP', 'indmoney', 1, 2626900, 'indmoney', $2), ($1, 'MF:ICICI-N50', 'indmoney', 1, 68843200, 'indmoney', $2)`, [snap!.id, now]);
    await persistSipSnapshot(db, [
      sip('ICICI-1', 'IND:5536', 'INF109K012M7', 'ICICI Prudential Nifty 50 Index Plan Direct Growth', 14_001),
      sip('HDFC-1', 'IND:3097', 'INF179K01XQ0', 'HDFC Mid Cap Opportunities Direct Growth', 1_001),
    ], now);
    return db;
  }

  it('NO_ADD on a held SIP fund: the row is kept, names the rule and carries its id; a month exception lifts it', async () => {
    const now = new Date().toISOString();
    const d = await fixture(now);
    const { id } = await logHoldingRule(d, { on: istDate(now), instrumentId: 'MF:HDFC-MIDCAP', kind: 'NO_ADD', note: '' }, now);
    const r = await loadSipSuggestions(d, now);
    if (r.rows === null) throw new Error(r.reason);
    const hdfc = r.rows.find((x) => x.instrumentId === 'IND:3097')!;
    // Every SIP here is typed and nothing is cut, so before the budget cap the total is the SIPs' own.
    expect(r.capped || r.suggestedPaise >= r.currentPaise).toBe(true);
    expect(hdfc).toMatchObject({ ruleId: id, currentPaise: R(1_001), suggestedPaise: R(1_001) });
    expect(hdfc.reason).toMatch(/^kept — your no new money rule on HDFC Mid Cap Opportunities Direct; ₹[\d,]+ went to the others$/);
    // Its Mid cap money went elsewhere: a new-fund row for the type.
    expect(r.rows.some((x) => x.fundType === 'MID' && x.instrumentId !== 'IND:3097' && x.suggestedPaise > 0n)).toBe(true);

    await logRuleException(d, { ruleId: id, month: istMonth(now), note: 'top it up this month' }, now);
    const after = await loadSipSuggestions(d, now);
    if (after.rows === null) throw new Error(after.reason);
    const freed = after.rows.find((x) => x.instrumentId === 'IND:3097')!;
    expect(freed.ruleId).toBeUndefined();
    expect(freed.suggestedPaise > freed.currentPaise).toBe(true);
  });
});

describe('loadFundMoves with rules', () => {
  const NOW = '2026-10-28T12:00:00Z';

  async function fixture() {
    db = await openDb();
    await runMigrations(db);
    await db.query(`insert into instruments (id, kind, name, currency, isin, canonical_id, metadata) values
      ('MF:ICICI-N50', 'MF', 'ICICI Prudential Nifty 50 Index Direct', 'INR', 'INF109K012M7', 'MF:N50', '{}'),
      ('IND:5536', 'MF', 'ICICI Prudential Nifty 50 Index Fund', 'INR', null, 'MF:N50', '{}')`);
    await persistUniverse(db, [
      { instrumentId: 'MFU:149999', schemeCode: '149999', isin: 'INF959L01FQ3', name: 'Navi Nifty 50 Index Fund', category: 'Index Funds' },
      { instrumentId: 'MFU:150000', schemeCode: '150000', isin: 'INF000X01AB1', name: 'Zeta Nifty 50 Index Fund', category: 'Index Funds' },
    ]);
    const peer = (id: string, name: string, code: string, bps: number) => db!.query(
      `insert into index_fund_candidates (fund_type, indmoney_fund_id, name, benchmark_name, amfi_scheme_code,
         expense_ratio_bps, aum_paise, sip_allowed, as_of, source)
       values ('NIFTY50', $1, $2, 'Nifty 50 TR INR', $3, $4, 1000000000000, true, '2026-10-28', 'indmoney-mcp')`, [id, name, code, bps]);
    await peer('5536', 'ICICI Prudential Nifty 50 Index Fund', '120620', 20);
    await peer('1039539', 'Navi Nifty 50 Index Fund', '149999', 5);
    await peer('2000000', 'Zeta Nifty 50 Index Fund', '150000', 9);
    const [s] = await db.query<{ id: string }>(`insert into snapshots (business_date, source) values ('2026-10-28', 'indmoney') returning id`);
    await db.query(`insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, avg_cost_paise, source, as_of)
      values ($1, 'IND:5536', 'indmoney', 1, 68843200, 64001300, 'indmoney', $2)`, [s!.id, NOW]);
    await persistSipSnapshot(db, [{
      sipId: 'S-1', instrumentId: 'MF:ICICI-N50', isin: null, fundName: 'ICICI', fundType: 'EQUITY', category: null,
      frequency: 'MONTHLY', amountPaise: 1_000_000n, stepUpRaw: null, stepUpFreq: null, startDate: '2025-01-05',
    }], '2026-10-28T01:00:00Z');
    return db;
  }
  const icici = async (d: Db) => (await loadFundMoves(d, NOW)).moves.find((m) => m.instrumentId === 'IND:5536')!;

  it('HOLD_UNTIL on the held fund: units keep, naming the rule; the SIP answer still moves', async () => {
    const d = await fixture();
    const { id } = await logHoldingRule(d, { on: '2026-10-28', instrumentId: 'MF:ICICI-N50', kind: 'HOLD_UNTIL', untilOn: '2030-03-31', note: '' }, NOW);
    const m = await icici(d);
    expect(m.units).toEqual({ kind: 'keep', why: 'keep — your hold until Mar 2030 rule' });
    expect(m.sip).toMatchObject({ kind: 'move', toName: 'Navi Nifty 50 Index Fund' });
    expect(m.ruleNote).toEqual({ ruleId: id, text: 'keep — your hold until Mar 2030 rule' });
  });

  it('a Nifty 50 challenger under NO_ADD: the next alternative is chosen; none left → keep, no allowed alternative', async () => {
    const d = await fixture();
    expect((await icici(d)).units).toMatchObject({ kind: 'move', toName: 'Navi Nifty 50 Index Fund' });
    const navi = await logHoldingRule(d, { on: '2026-10-28', instrumentId: 'MFU:149999', kind: 'NO_ADD', note: '' }, NOW);
    const next = await icici(d);
    expect(next.units).toMatchObject({ kind: 'move', toId: 'MFU:150000', toName: 'Zeta Nifty 50 Index Fund' });
    expect(next.sip).toMatchObject({ kind: 'move', toId: 'MFU:150000' });
    expect(next.ruleNote?.ruleId).toBe(navi.id);

    await logHoldingRule(d, { on: '2026-10-28', instrumentId: 'MFU:150000', kind: 'NO_ADD', note: '' }, NOW);
    const none = await icici(d);
    const why = 'keep — no allowed alternative (your no new money rule on Navi Nifty 50 Index Fund)';
    expect(none.units).toEqual({ kind: 'keep', why });
    expect(none.sip).toEqual({ kind: 'keep', amountPaise: 1_000_000n });
    expect(none.ruleNote).toEqual({ ruleId: navi.id, text: why });

    // A hold-until on the held fund decides the units answer, so its rule is the note, not the destination's.
    const hold = await logHoldingRule(d, { on: '2026-10-28', instrumentId: 'MF:ICICI-N50', kind: 'HOLD_UNTIL', untilOn: '2030-03-31', note: '' }, NOW);
    expect((await icici(d)).ruleNote).toEqual({ ruleId: hold.id, text: 'keep — your hold until Mar 2030 rule' });
  });
});

describe('loadExitCandidates with rules', () => {
  it('a firing trigger on a HOLD_UNTIL fund carries heldByRule; a month exception clears it', async () => {
    const NOW = '2026-10-28T12:00:00Z';
    db = await openDb();
    await runMigrations(db);
    await db.query(`insert into instruments (id, kind, name, currency, metadata) values ('NSE:ABC', 'EQUITY', 'ABC Ltd', 'INR', '{}')`);
    await persistExitCandidates(db, [{
      trigger: 'red-flag', instrumentId: 'NSE:ABC', action: 'SELL', month: '2026-10', evidence: 'red flags 3',
      ipsClauseRefs: ['6.5'], overridesMinimumHold: true, heldMonths: 30, blockedByMinimumHold: false,
      amountPaise: 1_000_000n, paper: true, heldByRule: null,
    }], NOW);
    expect((await loadExitCandidates(db, '2026-10', NOW))[0]!.heldByRule).toBeNull();
    const { id } = await logHoldingRule(db, { on: '2026-10-28', instrumentId: 'NSE:ABC', kind: 'HOLD_UNTIL', untilOn: '2030-03-31', note: '' }, NOW);
    expect((await loadExitCandidates(db, '2026-10', NOW))[0]!.heldByRule).toEqual({ ruleId: id, untilOn: '2030-03-31' });
    await logRuleException(db, { ruleId: id, month: '2026-10', note: 'sell it' }, NOW);
    expect((await loadExitCandidates(db, '2026-10', NOW))[0]!.heldByRule).toBeNull();
  });

  it('signing a SELL advice on a held-by-rule exit is refused; nothing is recommended', async () => {
    const NOW = '2026-10-28T12:00:00Z';
    db = await openDb();
    await runMigrations(db);
    await db.query(`insert into instruments (id, kind, name, currency, metadata) values ('NSE:ABC', 'EQUITY', 'ABC Ltd', 'INR', '{}')`);
    await persistExitCandidates(db, [{
      trigger: 'red-flag', instrumentId: 'NSE:ABC', action: 'SELL', month: '2026-10', evidence: 'red flags 3',
      ipsClauseRefs: ['6.5'], overridesMinimumHold: true, heldMonths: 30, blockedByMinimumHold: false,
      amountPaise: 1_000_000n, paper: true, heldByRule: null,
    }], NOW);
    await logHoldingRule(db, { on: '2026-10-28', instrumentId: 'NSE:ABC', kind: 'HOLD_UNTIL', untilOn: '2030-03-31', note: '' }, NOW);
    const id = await recordProposal(db, {
      kind: 'ADVISE', payload: { decision: 'SELL', instrumentId: 'NSE:ABC' }, inputSnapshot: {}, evidenceIds: [],
      model: 'm', promptVersion: 'p', schemaVersion: 's', asOf: NOW,
    });
    await expect(signAdvice(db, id, { candidates: [], now: new Date(NOW) })).rejects.toThrow('withheld — your hold until Mar 2030 rule on NSE:ABC');
    expect((await loadProposals(db))[0]!.status).toBe('OPEN');
    expect(await db.query(`select 1 from recommendations`)).toHaveLength(0);
  });
});
