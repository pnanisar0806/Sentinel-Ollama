import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import type { SwitchCandidate } from '../../src/domain/mf-switch.js';
import type { Candidate, SizingInput } from '../../src/domain/sizing.js';
import type { LumpSizingInput } from '../../src/domain/lump-sizing.js';

/**
 * Batch B §3, Task 4: a lump sum is sized against every eligible destination independently —
 * no tranche is shared — and then allocated across the advisor's ordered picks.
 */
const switches: SwitchCandidate[] = [];
vi.mock('../../src/domain/mf-switch.js', () => ({ evaluateSwitches: vi.fn(async () => switches) }));

const { approveMix, loadFundCandidates } = await import('../../src/domain/fund-mix.js');
const { allocateLumpSum, loadLumpSizingInput, sizeLumpSum } = await import('../../src/domain/lump-sizing.js');
const { loadSizingInput } = await import('../../src/domain/sizing-input.js');
const { logLumpSum } = await import('../../src/domain/owner-log.js');

const MID = 'Equity Scheme - Mid Cap Fund';
const NOW = '2026-10-30T06:00:00Z';
const AS_OF = '2026-10-30';
const LUMP = 2_069_100n; // ₹20,691 of Edelweiss bond interest

const sw = (id: string, rank: number, cohortSize: number, challenger: { id: string; name: string } | null = null): SwitchCandidate => ({
  heldInstrumentId: id, heldName: id, heldComposite: 50, heldRank: rank, category: MID, cohortSize,
  challengerId: challenger?.id ?? null, challengerName: challenger?.name ?? null, challengerComposite: null, edge: null, reason: 'a better mid cap',
});

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  switches.length = 0;
});
afterEach(async () => { await db.close(); });

describe('loadLumpSizingInput + sizeLumpSum', () => {
  it('sizes every destination against the whole lump sum', async () => {
    await seed(db, { asOf: '2026-08-12' });
    // The seed carries no bank row: ₹10L in the bank, so free cash never binds below.
    await db.query(`insert into instruments (id, kind, name, currency) values ('CASH:T', 'CASH', 'Bank', 'INR')`);
    await db.query(`insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
      select id, 'CASH:T', 1, 100000000, 'x', now(), 'manual-seed' from snapshots where source = 'manual-seed'`);
    await approveMix(db, { band: '15+' }, NOW);
    // Mid cap: HDFC is flagged for a switch to Invesco, which is not held.
    switches.push(sw('MF:HDFC-MIDCAP', 8, 10, { id: 'MFU:120505', name: 'Invesco India Mid Cap Fund' }));
    // Next 50: no fund held; the index fund chooser's top is the destination.
    await db.query(
      `insert into index_fund_candidates (fund_type, indmoney_fund_id, name, benchmark_name, amfi_scheme_code,
         expense_ratio_bps, aum_paise, sip_allowed, as_of, source)
       values ('NEXT50', '1042502', 'Edelweiss Nifty Next 50 Index Fund', 'Nifty Next 50 TR INR', '149000', 20, 1000000000000, true, $1, 'indmoney-mcp')`,
      [AS_OF]);
    // Gold: GOLDBEES is held (₹63,000, well under 10% of the portfolio) and priced today.
    await db.query(
      `insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of)
       values ('NSE:GOLDBEES', $1::date, 2408, 'nse-bhavcopy', $2::timestamptz)`, [AS_OF, NOW]);
    const { id } = await logLumpSum(db, { receivedOn: '2026-10-28', amountPaise: LUMP, from: 'Edelweiss bond interest' }, NOW);

    const input = await loadLumpSizingInput(db, id, AS_OF, new Date(NOW));
    expect(input.remainingPaise).toBe(LUMP);
    // The lump sum being sized is not reserved against itself; another open one is.
    expect(input.sizing.reservedPaise).toBe(0n);
    await logLumpSum(db, { receivedOn: '2026-10-29', amountPaise: 500_000n, from: 'Sammaan coupon' }, NOW);
    expect((await loadLumpSizingInput(db, id, AS_OF, new Date(NOW))).sizing.reservedPaise).toBe(500_000n);
    expect(input.newFunds.map((f) => [f.instrumentId, f.fundType])).toEqual([['MFU:120505', 'MID'], ['MFU:149000', 'NEXT50']]);
    expect(input.gold).toMatchObject({ instrumentId: 'NSE:GOLDBEES', kind: 'GOLD', maxBps: 1000 });
    expect(input.sizing.funds.excluded.find((e) => e.instrumentId === 'MF:HDFC-MIDCAP')?.reason).toBe('flagged for a switch to Invesco India Mid Cap Fund');

    const out = sizeLumpSum(input);
    const byId = new Map(out.map((c) => [c.instrumentId, c]));
    expect(byId.has('MF:HDFC-MIDCAP')).toBe(false);
    for (const c of out) expect(c).toMatchObject({ action: 'BUY', policyVersion: 'lump-v1' });
    const eligible = out.filter((c) => c.status === 'ELIGIBLE');
    // Each one sized against the whole lump sum: two by-amount funds both take all of it.
    expect(byId.get('MFU:120505')).toMatchObject({ status: 'ELIGIBLE', amountPaise: LUMP, units: null, vehicle: 'FUND' });
    expect(byId.get('MFU:149000')).toMatchObject({ status: 'ELIGIBLE', amountPaise: LUMP, units: null, vehicle: 'FUND' });
    expect(byId.get('NSE:GOLDBEES')).toMatchObject({ status: 'ELIGIBLE', units: String(LUMP / 2408n), amountPaise: (LUMP / 2408n) * 2408n, pricePaise: 2408n });
    for (const c of eligible) expect(c.amountPaise! <= LUMP).toBe(true);
    // Ids are stable and distinct per destination.
    expect(new Set(out.map((c) => c.id)).size).toBe(out.length);
    expect(sizeLumpSum(input).map((c) => c.id)).toEqual(out.map((c) => c.id));
  });

  it('a held fund above its midpoint but below its max is a destination', async () => {
    const [snap] = await db.query<{ id: string }>(`insert into snapshots (business_date, source) values (date '2026-10-20', 'indmoney') returning id`);
    // Nifty 50 at 60% (above its 50% max); Flexi at 22% (midpoint 20%, max 25%); Mid at 18%.
    for (const [id, name, isin, rupees] of [
      ['MF:IDX', 'ICICI Pru Nifty 50 Index Direct', 'INF109K012M7', 600_000],
      ['MF:PPFC', 'Parag Parikh Flexi Cap Direct', 'INF879O01027', 220_000],
      ['MF:HDFC-MID', 'HDFC Mid Cap Direct', 'INF179K01XQ0', 180_000],
    ] as const) {
      await db.query(`insert into instruments (id, kind, name, currency, isin) values ($1, 'MF', $2, 'INR', $3)`, [id, name, isin]);
      await db.query(
        `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
         values ($1, $2, 'indmoney', 1, $3, 'indmoney', timestamptz '2026-10-20T12:00:00Z')`, [snap!.id, id, BigInt(rupees) * 100n]);
    }
    await approveMix(db, { band: '15+' }, NOW);
    switches.push({ ...sw('MF:PPFC', 1, 10), category: 'Equity Scheme - Flexi Cap Fund' }, sw('MF:HDFC-MID', 2, 10));

    const monthly = await loadFundCandidates(db, AS_OF);
    expect(monthly.buys).toEqual([]);
    expect(monthly.excluded.find((e) => e.instrumentId === 'MF:PPFC')?.reason).toBe('at or above midpoint (22% vs 20%)');

    const lump = await loadFundCandidates(db, AS_OF, { upToMax: true });
    expect(lump.buys.map((b) => b.instrumentId)).toEqual(['MF:PPFC', 'MF:HDFC-MID']); // byGap: −200 before −300
    expect(lump.buys.find((b) => b.instrumentId === 'MF:PPFC')).toMatchObject({ actualBps: 2200, maxBps: 2500, quality: 'rank 1 of 11 in Equity Scheme - Flexi Cap Fund' });
    expect(lump.excluded.find((e) => e.instrumentId === 'MF:IDX')?.reason).toBe('at or above max (60% vs 50%)');
    // Stocks still wait on the midpoints, not the maxima.
    expect(lump.typesBelowMidpoint).toEqual(monthly.typesBelowMidpoint);
  });
});

describe('sizeLumpSum (pure)', () => {
  const input = (over: Partial<SizingInput> = {}): LumpSizingInput => ({
    lumpSumId: '7', remainingPaise: LUMP, fundTotalPaise: 100_000_000n, newFunds: [], gold: null,
    sizing: {
      asOf: AS_OF, tacticalBudgetPaise: 0n, envelopeReason: null, maxOrderPaise: 10_000_000n, cashAvailablePaise: 20_000_000n,
      reservedPaise: 0n, portfolioPaise: 1_000_000_000n, singleStockCapPct: 10, holdings: [],
      quotes: new Map([['NSE:A', { pricePaise: 100_000n, asOf: AS_OF }]]),
      buys: [{ instrumentId: 'NSE:A', name: 'A Ltd', kind: 'EQUITY', score: 90 }], sells: [],
      funds: { approved: true, buys: [], typesBelowMidpoint: [], excluded: [] }, singleSchemeCapPct: 35, ...over,
    },
  });

  it('stocks wait exactly as in the monthly sizer', () => {
    const [c] = sizeLumpSum(input({ funds: { approved: true, buys: [], typesBelowMidpoint: ['MID'], excluded: [] } }));
    expect(c).toMatchObject({ instrumentId: 'NSE:A', status: 'WITHHELD', withheldReason: 'not this month — a fund is below target (Mid cap)' });
  });

  it('a stock is capped by its single-stock headroom, summed across accounts', () => {
    // Cap ₹10L; held ₹4,99,500 + ₹4,99,500 → ₹1,000 of room: one ₹1,000 share.
    const held = { instrumentId: 'NSE:A', valuePaise: 49_950_000n, units: '1', kind: 'EQUITY', costKnown: true }; // one row per account
    const [c] = sizeLumpSum(input({ holdings: [held, held] }));
    expect(c).toMatchObject({ status: 'ELIGIBLE', units: '1', amountPaise: 100_000n, vehicle: 'STOCK' });
  });
});

/** Hand-built candidates: the allocator is pure. */
const cand = (over: Partial<Candidate> & Pick<Candidate, 'id' | 'instrumentId'>): Candidate => ({
  action: 'BUY', name: over.instrumentId, status: 'ELIGIBLE', withheldReason: null, amountPaise: LUMP, units: null,
  pricePaise: null, quoteAsOf: null, basis: '', constraints: [], policyVersion: 'lump-v1', vehicle: 'FUND', fund: null, ...over,
});

describe('allocateLumpSum', () => {
  const invesco = cand({ id: 'inv', instrumentId: 'MFU:120505', amountPaise: 1_500_000n });
  const gold = (price: bigint) => cand({ id: 'gold', instrumentId: 'NSE:GOLDBEES', amountPaise: (LUMP / price) * price, units: String(LUMP / price), pricePaise: price, quoteAsOf: AS_OF });

  it("allocates in the model's order and stops when spent", () => {
    const parts = allocateLumpSum([gold(2408n), invesco], ['inv', 'gold'], LUMP);
    expect(parts.map((p) => [p.candidate.id, p.amountPaise, p.units])).toEqual([
      ['inv', 1_500_000n, null],
      ['gold', (569_100n / 2408n) * 2408n, String(569_100n / 2408n)],
    ]);
    // A third pick after the money is spent gets nothing — no ₹0 part.
    const spent = allocateLumpSum([cand({ id: 'all', instrumentId: 'MFU:149000' }), invesco], ['all', 'inv'], LUMP);
    expect(spent.map((p) => [p.candidate.id, p.amountPaise])).toEqual([['all', LUMP]]);
  });

  it('drops a part whose one unit costs more than its allocation', () => {
    const parts = allocateLumpSum([gold(600_000n), invesco], ['inv', 'gold'], LUMP);
    expect(parts.map((p) => p.candidate.id)).toEqual(['inv']);
    expect(parts.reduce((s, p) => s + p.amountPaise, 0n) < LUMP).toBe(true);
    // Its money stays for the next pick.
    const next = allocateLumpSum([gold(600_000n), invesco, cand({ id: 'n50', instrumentId: 'MFU:149000' })], ['inv', 'gold', 'n50'], LUMP);
    expect(next.map((p) => [p.candidate.id, p.amountPaise])).toEqual([['inv', 1_500_000n], ['n50', 569_100n]]);
  });

  it('skips unknown, withheld and repeated ids', () => {
    const held = cand({ id: 'w', instrumentId: 'NSE:X', status: 'WITHHELD', withheldReason: 'no price on record', amountPaise: null });
    const parts = allocateLumpSum([invesco, held], ['nope', 'w', 'inv', 'inv'], LUMP);
    expect(parts.map((p) => [p.candidate.id, p.amountPaise])).toEqual([['inv', 1_500_000n]]);
  });
});

describe('loadSizingInput', () => {
  it('the monthly sizer reserves open lump sums', async () => {
    await seed(db, { asOf: '2026-08-12' });
    const before = (await loadSizingInput(db, AS_OF)).reservedPaise;
    await logLumpSum(db, { receivedOn: '2026-10-28', amountPaise: LUMP, from: 'Edelweiss bond interest' }, NOW);
    expect((await loadSizingInput(db, AS_OF)).reservedPaise).toBe(before + LUMP);
  });
});
