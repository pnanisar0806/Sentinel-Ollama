import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import {
  bankBalanceAge, loadCashflowCycles, loadPaydays, logPayday, paydayDue, secondLastWeekday,
} from '../../src/domain/cashflow.js';
import { logGoalMove, logLumpSum, logPurchase, logSale } from '../../src/domain/owner-log.js';
import { recordRedemption, stateRedemptionAmount } from '../../src/domain/bond-redemptions.js';
import { persistSipSnapshot } from '../../src/domain/sips.js';
import { reverseEntry } from '../../src/domain/reversals.js';
import { createOrder, approveOrder, awaitManualExecution, verifyAdvisory } from '../../src/domain/orders.js';
import { buildRecommendation, persistRecommendation, type RecLeg } from '../../src/domain/recommendations.js';
import { rupees, paise } from '../../src/money/paise.js';
import { istDate } from '../../src/domain/sips.js';

/** Open list #10/#29: payday entries, payday-to-payday cash flow, and the HDFC stale warning. */
let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});
afterEach(async () => { await db.close(); });

const L = (n: number) => BigInt(rupees(n));
const snap = (asOf: string, kind: string, label: string, r: number) => db.query(
  `insert into balance_snapshots (as_of, source, kind, label, amount_paise) values ($1, 'indmoney', $2, $3, $4)`,
  [asOf, kind, label, L(r).toString()]);
const sipFeed = (asOf: string, amountRupees: number) => persistSipSnapshot(db, [{
  sipId: 'S1', instrumentId: 'IND:1', isin: null, fundName: 'Parag Parikh Flexi Cap', fundType: null, category: null,
  frequency: 'MONTHLY', amountPaise: L(amountRupees), stepUpRaw: null, stepUpFreq: null, startDate: '2026-01-05',
}], asOf);

describe('secondLastWeekday', () => {
  it('skips weekends from the end of the month', () => {
    expect(secondLastWeekday('2026-11')).toBe('2026-11-27'); // 30 Mon, 27 Fri
    expect(secondLastWeekday('2026-10')).toBe('2026-10-29'); // 31 Sat, 30 Fri, 29 Thu
    expect(secondLastWeekday('2026-05')).toBe('2026-05-28'); // 31 Sun, 30 Sat, 29 Fri, 28 Thu
  });
});

describe('logPayday', () => {
  const NOW = '2026-11-27T12:00:00Z';
  it('records salary and HDFC balance, and refuses nonsense', async () => {
    await logPayday(db, { on: '2026-11-27', salaryPaise: L(210_000), balancePaise: L(350_000) }, NOW);
    const [p] = await loadPaydays(db);
    expect(p).toMatchObject({ on: '2026-11-27', account: 'HDFC Bank', salaryPaise: L(210_000), balancePaise: L(350_000) });
    await expect(logPayday(db, { on: '2026-11-28', salaryPaise: L(1), balancePaise: 0n }, NOW)).rejects.toThrow(/future/);
    await expect(logPayday(db, { on: '2026-10-29', salaryPaise: 0n, balancePaise: 0n }, NOW)).rejects.toThrow(/salary/);
    await expect(logPayday(db, { on: '2026-10-29', salaryPaise: L(1), balancePaise: -1n }, NOW)).rejects.toThrow(/balance/);
  });

  it('one payday per cycle: a second within 10 days is refused until the first is reversed', async () => {
    await logPayday(db, { on: '2026-11-27', salaryPaise: L(210_000), balancePaise: L(350_000) }, NOW);
    await expect(logPayday(db, { on: '2026-11-20', salaryPaise: L(1), balancePaise: L(1) }, NOW)).rejects.toThrow(/already/);
    const [p] = await loadPaydays(db);
    await reverseEntry(db, { entity: 'payday', entityId: p!.id, reason: 'wrong balance' }, NOW);
    expect(await loadPaydays(db)).toEqual([]);
    await logPayday(db, { on: '2026-11-27', salaryPaise: L(210_000), balancePaise: L(351_000) }, NOW);
    expect((await loadPaydays(db)).map((x) => x.balancePaise)).toEqual([L(351_000)]);
  });

  it('freezes the month\'s SIP commitment, and leaves it unknown when the feed is stale or the entry is late', async () => {
    await sipFeed('2026-11-26T14:00:00Z', 15_000);
    await logPayday(db, { on: '2026-11-27', salaryPaise: L(1), balancePaise: L(1) }, NOW);
    expect((await loadPaydays(db))[0]).toMatchObject({ sipsPaise: L(15_000), sipsMonth: '2026-11' });
  });

  it('a payday entered on the 2nd of the next month still freezes that month\'s SIPs', async () => {
    await sipFeed('2026-12-01T14:00:00Z', 15_000);
    await logPayday(db, { on: '2026-11-30', salaryPaise: L(1), balancePaise: L(1) }, '2026-12-02T06:00:00Z');
    expect((await loadPaydays(db))[0]).toMatchObject({ sipsPaise: L(15_000), sipsMonth: '2026-11' });
  });

  it('entered early next month: the feed must be fresh against today, not against the month it describes', async () => {
    await sipFeed('2026-11-23T14:00:00Z', 15_000); // 5 days before 28-Nov, 9 days before 2-Dec
    await logPayday(db, { on: '2026-11-30', salaryPaise: L(1), balancePaise: L(1) }, '2026-12-02T06:00:00Z');
    expect((await loadPaydays(db))[0]).toMatchObject({ sipsPaise: null, sipsMonth: null });
  });

  it('SIPs unknown: a stale feed, or a payday entered long after (a backfill)', async () => {
    await sipFeed('2026-11-10T14:00:00Z', 15_000); // 17 days old on 27-Nov
    await logPayday(db, { on: '2026-11-27', salaryPaise: L(1), balancePaise: L(1) }, NOW);
    expect((await loadPaydays(db))[0]!.sipsPaise).toBeNull();
    await sipFeed('2026-11-26T14:00:00Z', 15_000);
    await logPayday(db, { on: '2026-10-29', salaryPaise: L(1), balancePaise: L(1) }, NOW);
    expect((await loadPaydays(db)).find((p) => p.on === '2026-10-29')!.sipsPaise).toBeNull();
  });
});

describe('paydayDue', () => {
  it('not due before the 2nd-last weekday when nothing was ever entered; due from it until entered', async () => {
    expect(await paydayDue(db, '2026-11-12T06:00:00Z')).toMatchObject({ due: false, from: '2026-11-27' });
    expect(await paydayDue(db, '2026-11-27T06:00:00Z')).toMatchObject({ due: true, month: '2026-11', from: '2026-11-27' });
    await logPayday(db, { on: '2026-11-26', salaryPaise: L(1), balancePaise: L(1) }, '2026-11-27T06:00:00Z'); // a day early counts
    expect(await paydayDue(db, '2026-11-28T06:00:00Z')).toMatchObject({ due: false });
  });

  it('a missed payday stays due into the next month, until that month\'s window opens', async () => {
    await logPayday(db, { on: '2026-10-29', salaryPaise: L(1), balancePaise: L(1) }, '2026-10-29T12:00:00Z');
    expect(await paydayDue(db, '2026-12-03T06:00:00Z')).toMatchObject({ due: true, month: '2026-11' });
    expect(await paydayDue(db, '2026-11-12T06:00:00Z')).toMatchObject({ due: false });
  });
});

describe('bankBalanceAge (#29)', () => {
  it('dates the HDFC balance by when it last changed, not when it was fetched', async () => {
    await snap('2026-10-01T14:00:00Z', 'savings', 'HDFC Bank', 607_830);
    await snap('2026-10-20T14:00:00Z', 'savings', 'HDFC Bank', 607_830);
    await snap('2026-11-06T14:00:00Z', 'savings', 'HDFC Bank', 271_069);
    await snap('2026-11-09T14:00:00Z', 'savings', 'HDFC Bank', 271_069);
    await snap('2026-11-12T14:00:00Z', 'savings', 'HDFC Bank', 271_069);
    await snap('2026-11-12T14:00:00Z', 'savings', 'State Bank Of India', 1);
    const a = await bankBalanceAge(db, '2026-11-12T16:00:00Z');
    expect(a).toMatchObject({ amountPaise: L(271_069), lastChangedOn: '2026-11-06', fetchedOn: '2026-11-12', daysUnchanged: 6, stale: false });
    expect(await bankBalanceAge(db, '2026-11-13T16:00:00Z')).toMatchObject({ daysUnchanged: 7, stale: true });
  });

  it('null with no HDFC rows', async () => {
    expect(await bankBalanceAge(db, '2026-11-12T16:00:00Z')).toBeNull();
  });
});

describe('loadCashflowCycles (#10)', () => {
  const NOW = '2026-11-27T12:00:00Z';

  async function twoPaydays() {
    await sipFeed('2026-11-26T14:00:00Z', 15_000);
    await logPayday(db, { on: '2026-10-29', salaryPaise: L(200_000), balancePaise: L(300_000) }, '2026-10-29T12:00:00Z');
    await logPayday(db, { on: '2026-11-27', salaryPaise: L(210_000), balancePaise: L(350_000) }, NOW);
  }

  it('needs two paydays', async () => {
    await logPayday(db, { on: '2026-10-29', salaryPaise: L(200_000), balancePaise: L(300_000) }, '2026-10-29T12:00:00Z');
    expect(await loadCashflowCycles(db)).toEqual([]);
  });

  it('splits the money that left HDFC into invested, set aside, loan principal and spend', async () => {
    await snap('2026-10-28T14:00:00Z', 'loan', 'Car loan', 500_000);
    await snap('2026-11-26T14:00:00Z', 'loan', 'Car loan', 480_000);
    await twoPaydays();
    await logLumpSum(db, { receivedOn: '2026-11-05', amountPaise: L(20_000), from: 'Bond interest' }, NOW);
    await logSale(db, { on: '2026-11-10', instrumentId: 'US:NOW', units: 1, proceedsPaise: L(50_000), destination: null, note: '', invest: true }, NOW);
    // Proceeds paid into a goal pot never reached HDFC: not money in.
    await logSale(db, { on: '2026-11-11', instrumentId: 'US:NOW', units: 1, proceedsPaise: L(40_000), destination: 'B2', note: '' }, NOW);
    await logPurchase(db, { boughtOn: '2026-11-12', description: 'Nifty 50 fund', amountPaise: L(30_000) }, NOW);
    await logPurchase(db, { boughtOn: '2026-11-13', description: 'typo', amountPaise: L(99_000) }, NOW);
    const [typo] = await db.query<{ id: string }>(`select id::text from owner_purchases where description = 'typo'`);
    await reverseEntry(db, { entity: 'owner_purchase', entityId: typo!.id, reason: 'typo' }, NOW);
    await logGoalMove(db, { bucketId: 'B3', occurredOn: '2026-11-15', amountPaise: L(25_000), kind: 'sip', note: '' }, NOW);
    // On the start payday itself: before the balance was taken, so outside the cycle.
    await logPurchase(db, { boughtOn: '2026-10-29', description: 'same day as payday A', amountPaise: L(7_000) }, NOW);

    const [c] = await loadCashflowCycles(db);
    expect(c).toMatchObject({
      from: '2026-10-29', to: '2026-11-27', salaryPaise: L(200_000),
      startBalancePaise: L(300_000), endBalancePaise: L(140_000),
      otherInPaise: L(70_000),               // lump 20k + sale 50k; the sale's own lump sum is not counted twice
      moneyOutPaise: L(230_000),             // 3,00,000 + 70,000 − 1,40,000
      sipsPaise: L(15_000), purchasesPaise: L(30_000), ordersPaise: 0n,
      investedPaise: L(45_000), setAsidePaise: L(25_000), loanPrincipalPaise: L(20_000),
      spendPaise: L(140_000), surplusPaise: L(130_000),
    });
  });

  it('a payday entered on the end date counts its own day; a bond redemption is money in', async () => {
    await twoPaydays();
    await recordRedemption(db, 'BOND:SAMMAAN-2026', { receivedOn: '2026-11-27', amountPaise: null });
    await stateRedemptionAmount(db, 'BOND:SAMMAAN-2026', L(10_000));
    const [c] = await loadCashflowCycles(db);
    expect(c!.otherInPaise).toBe(L(10_000));
  });

  it('unknown SIPs or loans make spend and surplus unknown, never 0', async () => {
    await logPayday(db, { on: '2026-10-29', salaryPaise: L(200_000), balancePaise: L(300_000) }, '2026-10-29T12:00:00Z');
    await logPayday(db, { on: '2026-11-27', salaryPaise: L(210_000), balancePaise: L(350_000) }, NOW); // no SIP feed
    const [c] = await loadCashflowCycles(db);
    expect(c).toMatchObject({ sipsPaise: null, investedPaise: null, spendPaise: null, surplusPaise: null });
    expect(c!.unknown.join(' ')).toMatch(/SIP/);
  });

  it('a loan with a balance at the end but none at the start makes principal unknown', async () => {
    await snap('2026-11-26T14:00:00Z', 'loan', 'Car loan', 480_000);
    await twoPaydays();
    const [c] = await loadCashflowCycles(db);
    expect(c!.loanPrincipalPaise).toBeNull();
    expect(c!.unknown.join(' ')).toMatch(/loan/);
  });

  it('counts an order Sentinel proposed once it is verified as executed', async () => {
    const today = istDate(new Date().toISOString());
    const start = istDate(new Date(Date.now() - 20 * 86_400_000).toISOString());
    await persistSipSnapshot(db, [], new Date().toISOString());
    const primary: RecLeg = {
      intent: 'test BUY', instrumentId: 'NSE:RPOWER', action: 'BUY', amountPaise: paise(100000).toString(),
      thesis: 'Test thesis within word limit for BUY action with strong fundamentals and favorable valuation',
      ipsClauseRefs: ['3.3'], falsification: { metric: 'roce_pct', op: 'lt', value: 40 },
    };
    const rec = buildRecommendation({ kind: 'satellite', createdOn: start, primary });
    const persisted = await persistRecommendation(db, rec);
    const order = await createOrder(db, { recommendationId: persisted.id!, recommendation: rec, createdBy: 'advisor', advisoryPath: true });
    await approveOrder(db, order.id, { idempotencyKey: 'a1', actor: 'owner' });
    await awaitManualExecution(db, order.id, { idempotencyKey: 'm1', actor: 'owner' });
    await logPayday(db, { on: start, salaryPaise: L(1), balancePaise: L(500_000) }, new Date().toISOString());
    await verifyAdvisory(db, order.id, { idempotencyKey: 'v1', actor: 'owner' });
    await logPayday(db, { on: today, salaryPaise: L(1), balancePaise: L(1) }, new Date().toISOString());
    const [c] = await loadCashflowCycles(db);
    expect(c!.ordersPaise).toBe(BigInt(paise(100000)));
  });
});
