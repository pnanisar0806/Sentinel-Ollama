import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { parseMfSips } from '../../src/sources/indmoney.js';
import { classify } from '../../src/domain/networth.js';
import {
  inferStepUp, loadFreeEnvelope, loadMonthSpend, loadSipCommitment, nextStepUp, persistSipSnapshot, sipAssetClass, type ActiveSip,
} from '../../src/domain/sips.js';
import { seed } from '../../src/seed/seed.js';
import { buildRecommendation, persistRecommendation } from '../../src/domain/recommendations.js';
import { logPurchase } from '../../src/domain/owner-log.js';

const sip = (over: Partial<ActiveSip> = {}): ActiveSip => ({
  sipId: '1', instrumentId: 'IND:5536', fundName: 'Nifty', fundType: 'Equity', category: 'Index Funds',
  amountPaise: 1_400_100n, stepUpRaw: 10, stepUpKind: 'percent', stepUpInferred: true,
  stepUpFreq: 'YEARLY', startDate: '2026-11-12', asOf: '2026-10-14T00:00:00Z', ...over,
});

describe('inferStepUp', () => {
  it.each([
    [null, { kind: null, inferred: false }],
    [0, { kind: 'unknown', inferred: false }],
    [10, { kind: 'percent', inferred: true }],
    [100, { kind: 'percent', inferred: true }],
    [101, { kind: 'rupees', inferred: true }],
    [1000, { kind: 'rupees', inferred: true }],
    [-5, { kind: 'unknown', inferred: false }],
  ])('%s -> %o', (raw, expected) => {
    expect(inferStepUp(raw as number | null)).toEqual(expected);
  });
});

describe('sipAssetClass', () => {
  it('a Money Market category is DEBT, though its name alone would read as EQUITY', () => {
    const mm = sip({ fundName: 'HDFC Money Market Fund Direct Growth', fundType: null, category: 'Money Market' });
    expect(classify('MF', mm.instrumentId, mm.fundName)).toBe('EQUITY'); // the gap being closed
    expect(sipAssetClass(mm)).toBe('DEBT');
  });

  it('fundType Debt is DEBT whatever the category says', () => {
    expect(sipAssetClass(sip({ fundName: 'ICICI Floater Fund', fundType: 'Debt', category: 'Floating Rate' }))).toBe('DEBT');
  });

  it('an arbitrage category is DEBT', () => {
    expect(sipAssetClass(sip({ fundName: 'Kotak Equity Arbitrage Fund', fundType: 'Hybrid', category: 'Arbitrage Fund' }))).toBe('DEBT');
  });

  it('a gold FoF is GOLD', () => {
    const gold = sip({ fundName: 'Nippon India Gold Savings Fund Direct Growth', fundType: 'Other', category: 'FoF Domestic' });
    expect(classify('MF', gold.instrumentId, gold.fundName)).toBe('EQUITY');
    expect(sipAssetClass(gold)).toBe('GOLD');
  });

  it('an equity fund stays EQUITY', () => {
    expect(sipAssetClass(sip())).toBe('EQUITY');
  });
});

describe('nextStepUp', () => {
  it('a SIP that has not started yet first steps up one year after its start', () => {
    expect(nextStepUp(sip(), '2026-10-14').on).toBe('2027-11-12');
  });

  it('percent: the amount rises by that share, rounded down to the rupee', () => {
    const s = sip();
    const expected = ((s.amountPaise * 110n) / 100n / 100n) * 100n;
    expect(nextStepUp(s, '2026-10-14').amountPaise).toBe(expected); // ₹15,401
  });

  it('rupees: the amount rises by that many rupees', () => {
    const s = sip({ stepUpRaw: 1000, stepUpKind: 'rupees', startDate: '2023-08-12' });
    expect(nextStepUp(s, '2026-10-14')).toEqual({ on: '2027-08-12', amountPaise: s.amountPaise + 100_000n });
  });

  it('on the anniversary itself, the next step-up is that day', () => {
    expect(nextStepUp(sip({ startDate: '2025-10-14' }), '2026-10-14').on).toBe('2026-10-14');
  });

  it('a 29 Feb start steps up on 28 Feb in a common year, never on a date that does not exist', () => {
    expect(nextStepUp(sip({ startDate: '2024-02-29' }), '2026-10-14').on).toBe('2027-02-28');
    expect(nextStepUp(sip({ startDate: '2024-02-29' }), '2027-03-01').on).toBe('2028-02-29');
  });

  it('an unknown kind is unknowable, never guessed', () => {
    expect(nextStepUp(sip({ stepUpKind: 'unknown' }), '2026-10-14')).toEqual({ on: '2027-11-12', amountPaise: null });
  });

  it('no step-up: nothing to project', () => {
    expect(nextStepUp(sip({ stepUpRaw: null, stepUpKind: null, stepUpFreq: null }), '2026-10-14'))
      .toEqual({ on: null, amountPaise: null });
  });

  it('a frequency other than YEARLY is not projected', () => {
    expect(nextStepUp(sip({ stepUpFreq: 'HALF_YEARLY' }), '2026-10-14')).toEqual({ on: null, amountPaise: null });
  });
});

const live = parseMfSips({
  result: JSON.stringify(JSON.parse(await readFile('tests/fixtures/indmoney-mf-sips-2026-10-14.json', 'utf8')).payload),
});

describe('loadSipCommitment', () => {
  let db: Db;
  beforeEach(async () => { db = await openDb(); await runMigrations(db); });

  it('no snapshot ever: unknown, not zero', async () => {
    expect(await loadSipCommitment(db, '2026-10-14T10:00:00Z')).toEqual({ totalPaise: null, asOf: null, stale: true, sips: [], departedThisMonth: [] });
  });

  it('the latest snapshot is the active set, totalled exactly', async () => {
    await persistSipSnapshot(db, live.slice(0, 1), '2026-10-01T00:00:00Z');
    await persistSipSnapshot(db, live, '2026-10-14T00:00:00Z');
    const c = await loadSipCommitment(db, '2026-10-14T10:00:00Z');
    expect(c.totalPaise).toBe(live.reduce((s, r) => s + r.amountPaise, 0n));
    expect(c.sips.map((s) => s.sipId).sort()).toEqual(live.map((r) => r.sipId).sort());
    expect(c.sips[0]).toMatchObject({ stepUpKind: 'percent', stepUpInferred: true });
    expect(c.stale).toBe(false);
    expect(c.asOf).toBe('2026-10-14T00:00:00.000Z');
  });

  it('a start date round-trips exactly, never shifted a day', async () => {
    expect(live[0]!.startDate).toBe('2026-11-12');
    await persistSipSnapshot(db, live.slice(0, 1), '2026-10-14T00:00:00Z');
    expect((await loadSipCommitment(db, '2026-10-14T10:00:00Z')).sips[0]!.startDate).toBe('2026-11-12');
  });

  it('a step-up SIP with no step_up_by is stored as unknown, not as no step-up', async () => {
    await persistSipSnapshot(db, [
      { ...live[0]!, sipId: 'u', stepUpRaw: null, stepUpFreq: 'YEARLY' },
      { ...live[1]!, sipId: 'n', stepUpRaw: null, stepUpFreq: null },
    ], '2026-10-14T00:00:00Z');
    const by = new Map((await loadSipCommitment(db, '2026-10-14T10:00:00Z')).sips.map((s) => [s.sipId, s]));
    expect(by.get('u')).toMatchObject({ stepUpKind: 'unknown', stepUpInferred: false, stepUpRaw: null });
    expect(by.get('n')).toMatchObject({ stepUpKind: null, stepUpInferred: false, stepUpRaw: null });
  });

  it('an empty snapshot is a stated zero', async () => {
    await persistSipSnapshot(db, [], '2026-10-14T00:00:00Z');
    expect((await loadSipCommitment(db, '2026-10-14T10:00:00Z')).totalPaise).toBe(0n);
  });

  it('exactly 7 days old is still fresh', async () => {
    await persistSipSnapshot(db, live, '2026-10-01T00:00:00Z');
    expect((await loadSipCommitment(db, '2026-10-08T00:00:00Z')).stale).toBe(false);
  });

  it('older than 7 days: the total is unknown and flagged stale, the rows are still shown', async () => {
    await persistSipSnapshot(db, live, '2026-10-01T00:00:00Z');
    const c = await loadSipCommitment(db, '2026-10-08T00:00:01Z');
    expect(c).toMatchObject({ totalPaise: null, stale: true });
    expect(c.sips).toHaveLength(live.length);
  });

  it('a non-MONTHLY SIP makes the total unknown, never summed as monthly; rows still shown', async () => {
    await persistSipSnapshot(db, [...live.slice(1), { ...live[0]!, frequency: 'QUARTERLY' }], '2026-10-14T00:00:00Z');
    const c = await loadSipCommitment(db, '2026-10-14T10:00:00Z');
    expect(c).toMatchObject({ totalPaise: null, stale: false });
    expect(c.sips).toHaveLength(live.length);
    expect(c.unknownReason).toMatch(new RegExp(`${live[0]!.fundName}.*QUARTERLY`));
  });

  it('writes the snapshot and its rows atomically', async () => {
    const bad = [...live, { ...live[0]!, amountPaise: 0n }]; // violates amount_paise > 0
    await expect(persistSipSnapshot(db, bad, '2026-10-14T00:00:00Z')).rejects.toThrow();
    expect(await db.query('select 1 from sip_snapshots')).toHaveLength(0);
    expect(await db.query('select 1 from sips')).toHaveLength(0);
  });
});

describe('loadSipCommitment: SIPs stopped this month', () => {
  let db: Db;
  beforeEach(async () => { db = await openDb(); await runMigrations(db); });
  // Fixture start dates are 2026-11-12: instalment day 12.
  const [a, b] = [live[0]!, live[1]!];
  const ids = (c: { departedThisMonth: ActiveSip[] }) => c.departedThisMonth.map((s) => s.sipId);

  it('stopped after its instalment day: still counts this month, at its last-seen amount; not next month', async () => {
    await persistSipSnapshot(db, [{ ...a, amountPaise: 999_900n }, b], '2026-10-03T00:00:00Z');
    await persistSipSnapshot(db, [a, b], '2026-10-14T00:00:00Z');
    await persistSipSnapshot(db, [b], '2026-10-20T00:00:00Z');
    const oct = await loadSipCommitment(db, '2026-10-20T10:00:00Z');
    expect(oct.totalPaise).toBe(a.amountPaise + b.amountPaise);
    expect(ids(oct)).toEqual([a.sipId]);
    expect(oct.departedThisMonth[0]).toMatchObject({ amountPaise: a.amountPaise, asOf: '2026-10-14T00:00:00.000Z' });
    expect(oct.sips.map((s) => s.sipId)).toEqual([b.sipId]);
    await persistSipSnapshot(db, [b], '2026-11-01T00:00:00Z');
    const nov = await loadSipCommitment(db, '2026-11-02T00:00:00Z');
    expect(nov.totalPaise).toBe(b.amountPaise);
    expect(ids(nov)).toEqual([]);
  });

  it('last seen before its instalment day, then gone: not debited, does not count', async () => {
    await persistSipSnapshot(db, [a, b], '2026-10-05T00:00:00Z');
    await persistSipSnapshot(db, [b], '2026-10-20T00:00:00Z');
    const c = await loadSipCommitment(db, '2026-10-20T10:00:00Z');
    expect(c.totalPaise).toBe(b.amountPaise);
    expect(ids(c)).toEqual([]);
  });

  it('last seen in the previous month: does not count', async () => {
    await persistSipSnapshot(db, [a, b], '2026-09-25T00:00:00Z');
    await persistSipSnapshot(db, [b], '2026-10-03T00:00:00Z');
    const c = await loadSipCommitment(db, '2026-10-04T00:00:00Z');
    expect(c.totalPaise).toBe(b.amountPaise);
    expect(ids(c)).toEqual([]);
  });

  it('an active SIP also in earlier snapshots counts once', async () => {
    await persistSipSnapshot(db, [a, b], '2026-10-01T00:00:00Z');
    await persistSipSnapshot(db, [a, b], '2026-10-14T00:00:00Z');
    await persistSipSnapshot(db, [a, b], '2026-10-20T00:00:00Z');
    const c = await loadSipCommitment(db, '2026-10-20T10:00:00Z');
    expect(c.totalPaise).toBe(a.amountPaise + b.amountPaise);
    expect(ids(c)).toEqual([]);
  });

  it('a 31st instalment day clamps to the 30th in a 30-day month (and the date is IST, not UTC)', async () => {
    // 2026-11-29T20:00Z is 30 Nov 01:30 IST; by UTC it would read 29 Nov and miss.
    await persistSipSnapshot(db, [{ ...a, startDate: '2026-01-31' }, b], '2026-11-29T20:00:00Z');
    await persistSipSnapshot(db, [b], '2026-11-30T12:00:00Z');
    const c = await loadSipCommitment(db, '2026-11-30T13:00:00Z');
    expect(ids(c)).toEqual([a.sipId]);
    expect(c.totalPaise).toBe(a.amountPaise + b.amountPaise);
  });

  it('the month is the IST month: 30 Sep 19:00 UTC is already 1 Oct', async () => {
    await persistSipSnapshot(db, [{ ...a, startDate: '2026-01-01' }, b], '2026-09-30T19:00:00Z');
    await persistSipSnapshot(db, [b], '2026-10-03T00:00:00Z');
    expect(ids(await loadSipCommitment(db, '2026-10-03T10:00:00Z'))).toEqual([a.sipId]);
  });

  it('a stale latest snapshot: total unknown even with departed SIPs', async () => {
    await persistSipSnapshot(db, [a, b], '2026-10-14T00:00:00Z');
    await persistSipSnapshot(db, [b], '2026-10-20T00:00:00Z');
    const c = await loadSipCommitment(db, '2026-10-28T00:00:00Z');
    expect(c).toMatchObject({ totalPaise: null, stale: true });
    expect(ids(c)).toEqual([a.sipId]);
  });

  it('a departed non-MONTHLY SIP: total unknown, the reason names it', async () => {
    await persistSipSnapshot(db, [{ ...a, frequency: 'QUARTERLY' }, b], '2026-10-14T00:00:00Z');
    await persistSipSnapshot(db, [b], '2026-10-20T00:00:00Z');
    const c = await loadSipCommitment(db, '2026-10-20T10:00:00Z');
    expect(c).toMatchObject({ totalPaise: null, stale: false });
    expect(c.unknownReason).toMatch(new RegExp(`${a.fundName}.*QUARTERLY`));
  });
});

describe('loadSipCommitment fails closed on time', () => {
  it('an unparseable clock reads stale, never fresh', async () => {
    const db = await openDb(); await runMigrations(db);
    await persistSipSnapshot(db, live, '2026-10-14T00:00:00Z');
    expect(await loadSipCommitment(db, 'not-a-date')).toMatchObject({ totalPaise: null, stale: true });
  });
});

describe('loadFreeEnvelope', () => {
  let db: Db;
  beforeEach(async () => { db = await openDb(); await runMigrations(db); });
  const NOW = '2026-10-14T10:00:00Z';
  const setRail = (k: string, v: number) =>
    db.query(`insert into settings_rails (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [k, JSON.stringify(v)]);

  it('budget minus live SIPs, capped by the tactical rail', async () => {
    await persistSipSnapshot(db, live, NOW);
    const e = await loadFreeEnvelope(db, NOW);
    const sips = live.reduce((s, r) => s + r.amountPaise, 0n);
    const expected = [e.tacticalPaise, e.budgetPaise - sips].reduce((m, x) => (x < m ? x : m));
    expect(e).toMatchObject({ envelopePaise: expected, sipTotalPaise: sips, reason: null });
  });

  it('the tactical rail still caps a large budget', async () => {
    await persistSipSnapshot(db, [], NOW);
    await setRail('monthly_budget_paise', 50_000_000);
    const e = await loadFreeEnvelope(db, NOW);
    expect(e.envelopePaise).toBe(e.tacticalPaise);
  });

  it('SIPs at or over the budget: zero, with a reason, never negative', async () => {
    await persistSipSnapshot(db, live, NOW);
    await setRail('monthly_budget_paise', 1_000_000); // ₹10,000 < the SIPs
    expect(await loadFreeEnvelope(db, NOW)).toMatchObject({ envelopePaise: 0n, reason: expect.stringMatching(/SIPs already use the whole budget/) });
  });

  it('a zero tactical rail: zero, with a reason, never negative', async () => {
    await persistSipSnapshot(db, [], NOW);
    await setRail('tactical_monthly_paise', 0);
    expect(await loadFreeEnvelope(db, NOW)).toMatchObject({ envelopePaise: 0n, reason: expect.stringMatching(/tactical rail/) });
  });

  it('a zero budget: zero, and the reason says the budget allows nothing, not that SIPs used it', async () => {
    await persistSipSnapshot(db, [], NOW);
    await setRail('monthly_budget_paise', 0);
    expect(await loadFreeEnvelope(db, NOW)).toMatchObject({ envelopePaise: 0n, reason: expect.stringMatching(/monthly budget is set to ₹0/) });
  });

  it('no SIP snapshot: unknown, with a reason naming the sync', async () => {
    expect(await loadFreeEnvelope(db, NOW)).toMatchObject({ envelopePaise: null, reason: expect.stringMatching(/never synced/) });
  });

  it('a non-MONTHLY SIP: unknown, with a reason naming that SIP and its frequency', async () => {
    await persistSipSnapshot(db, [...live.slice(1), { ...live[0]!, frequency: 'WEEKLY' }], NOW);
    const e = await loadFreeEnvelope(db, NOW);
    expect(e).toMatchObject({ envelopePaise: null, sipTotalPaise: null });
    expect(e.reason).toMatch(new RegExp(`${live[0]!.fundName}.*WEEKLY`));
  });

  it('stale SIPs: unknown, with a reason naming the last sync date', async () => {
    await persistSipSnapshot(db, live, '2026-09-30T00:00:00Z');
    expect(await loadFreeEnvelope(db, NOW)).toMatchObject({ envelopePaise: null, reason: expect.stringMatching(/2026-09-30/) });
  });
});

/**
 * SIP gaps Task 2: this IST month's spend (Sentinel BUY orders + purchases the owner logged
 * outside Sentinel) comes off the envelope, leaving what is still free to invest.
 */
describe('month spend and remaining', () => {
  let db: Db;
  beforeEach(async () => { db = await openDb(); await runMigrations(db); await seed(db, { asOf: '2026-08-12' }); });
  const NOW = '2026-10-14T10:00:00Z';
  const buyOrder = async (amountPaise: bigint, asOf: string) => {
    const r = await persistRecommendation(db, buildRecommendation({
      kind: 'satellite', createdOn: '2026-10-01',
      primary: { intent: 'add', instrumentId: 'NSE:RPOWER', action: 'BUY', amountPaise: amountPaise.toString(),
        thesis: 'test', ipsClauseRefs: ['3.4'], falsification: null },
    }));
    await db.query(
      `insert into order_intents (recommendation_id, intent, instrument_id, quantity, order_type, payload_snapshot,
         expires_at, advisory_path, as_of, source, created_by, status, current_revision)
       values ($1, 'BUY', 'NSE:RPOWER', $2, 'MARKET', '{}'::jsonb, now() + interval '7 days', true, $3, 'advisor', 'advisor', 'DRAFT', 1)`,
      [r.id, amountPaise.toString(), asOf],
    );
  };
  const purchase = (amountPaise: bigint, boughtOn: string) =>
    logPurchase(db, { boughtOn, description: 'Zerodha Gold ETF', amountPaise }, NOW);

  it('nothing spent: spent is a known 0, and remaining is the whole envelope', async () => {
    await persistSipSnapshot(db, live, NOW);
    const e = await loadFreeEnvelope(db, NOW);
    expect(e.spentPaise).toBe(0n);
    expect(e.remainingPaise).toBe(e.envelopePaise);
    expect(await loadMonthSpend(db, NOW)).toEqual({ ordersPaise: 0n, ownerPaise: 0n, totalPaise: 0n });
  });

  it('owner purchases plus Sentinel BUY orders sum, and come off the envelope', async () => {
    await persistSipSnapshot(db, live, NOW);
    await buyOrder(300_000n, '2026-10-02T05:00:00Z');
    await purchase(250_000n, '2026-10-03');
    await purchase(125_000n, '2026-10-14');
    expect(await loadMonthSpend(db, NOW)).toEqual({ ordersPaise: 300_000n, ownerPaise: 375_000n, totalPaise: 675_000n });
    const e = await loadFreeEnvelope(db, NOW);
    expect(e.spentPaise).toBe(675_000n);
    expect(e.remainingPaise).toBe(e.envelopePaise! - 675_000n);
  });

  it('a purchase dated in a previous month does not reduce this month (Review Focus 1)', async () => {
    await persistSipSnapshot(db, live, NOW);
    await purchase(500_000n, '2026-09-30');
    const e = await loadFreeEnvelope(db, NOW);
    expect(e.spentPaise).toBe(0n);
    expect(e.remainingPaise).toBe(e.envelopePaise);
  });

  it('purchases beyond the envelope: remaining is 0, never negative, and says why (Review Focus 5)', async () => {
    await persistSipSnapshot(db, live, NOW);
    const env = (await loadFreeEnvelope(db, NOW)).envelopePaise!;
    await purchase(env + 1_000_000n, '2026-10-10');
    const e = await loadFreeEnvelope(db, NOW);
    expect(e.remainingPaise).toBe(0n);
    expect(e.reason).toMatch(/this month's budget is already deployed \(₹[\d,]+ spent\)/);
  });

  it('an unknown envelope makes remaining unknown, while spent stays a known sum', async () => {
    await purchase(100_000n, '2026-10-10');
    const e = await loadFreeEnvelope(db, NOW);
    expect(e).toMatchObject({ envelopePaise: null, remainingPaise: null, spentPaise: 100_000n });
  });

  it('the month is the IST month: an order at 2026-10-31T20:00Z is November spend', async () => {
    await buyOrder(400_000n, '2026-10-31T20:00:00Z'); // 01:30 IST on 1 November
    expect((await loadMonthSpend(db, '2026-11-01T06:00:00Z')).ordersPaise).toBe(400_000n);
    expect((await loadMonthSpend(db, '2026-10-31T12:00:00Z')).ordersPaise).toBe(0n);
  });
});
