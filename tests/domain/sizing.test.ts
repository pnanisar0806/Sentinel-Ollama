import { describe, expect, it } from 'vitest';
import { sizeCandidates, type SizingInput } from '../../src/domain/sizing.js';
import { openDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { istDate, loadFreeEnvelope, persistSipSnapshot } from '../../src/domain/sips.js';
import { logPurchase, logSale } from '../../src/domain/owner-log.js';
import { loadSizingInput } from '../../src/domain/sizing-input.js';
import { GATE_AS_OF, GATE_NOW, clearGovernance, seedGateStocks } from '../fixtures/stock-gate.js';

/**
 * Phase 2.5 Task 4. The LLM advisor chooses among candidates; this decides how much. Every
 * amount comes from real money and rails — the tactical budget, cash that is not the
 * emergency fund, the single-stock cap and units actually owned — and never from a score.
 */
const AS_OF = '2026-09-27';
const base = (over: Partial<SizingInput> = {}): SizingInput => ({
  asOf: AS_OF,
  tacticalBudgetPaise: 5_000_000n,       // ₹50k a month
  envelopeReason: null,
  maxOrderPaise: 10_000_000n,
  cashAvailablePaise: 20_000_000n,       // ₹2L free cash
  reservedPaise: 0n,
  portfolioPaise: 500_000_000n,          // ₹50L
  singleStockCapPct: 10,
  holdings: [],
  quotes: new Map([['NSE:A', { pricePaise: 123_450n, asOf: '2026-09-26' }], ['NSE:B', { pricePaise: 80_000n, asOf: '2026-09-26' }]]),
  buys: [{ instrumentId: 'NSE:A', name: 'A Ltd', kind: 'EQUITY', score: 80 }],
  sells: [],
  funds: { approved: true, buys: [], typesBelowMidpoint: [], excluded: [] },
  singleSchemeCapPct: 35,
  ...over,
});
const eligible = (c: ReturnType<typeof sizeCandidates>) => c.filter((x) => x.status === 'ELIGIBLE');

describe('buying', () => {
  it('buys whole shares worth at most one monthly tranche', () => {
    const input = base();
    const [c] = sizeCandidates(input);
    const units = input.tacticalBudgetPaise / 123_450n;
    expect(c).toMatchObject({ status: 'ELIGIBLE', action: 'BUY', units: units.toString(), amountPaise: units * 123_450n });
    expect(c!.amountPaise!).toBeLessThanOrEqual(input.tacticalBudgetPaise);
  });

  it('spends the monthly budget once across the whole batch, best score first', () => {
    const [a, b] = sizeCandidates(base({ buys: [
      { instrumentId: 'NSE:B', name: 'B', kind: 'EQUITY', score: 71 },
      { instrumentId: 'NSE:A', name: 'A', kind: 'EQUITY', score: 90 },
    ] }));
    expect(a!.instrumentId).toBe('NSE:A');
    expect(a!.status).toBe('ELIGIBLE');
    expect(b).toMatchObject({ instrumentId: 'NSE:B', status: 'WITHHELD', withheldReason: expect.stringMatching(/budget/) });
  });

  it('never spends cash that is not there, and counts open requests as spent', () => {
    const cash = 3_000_000n; const reserved = 1_000_000n;
    const [c] = sizeCandidates(base({ cashAvailablePaise: cash, reservedPaise: reserved }));
    expect(c!.amountPaise!).toBeLessThanOrEqual(cash - reserved);
    expect(sizeCandidates(base({ cashAvailablePaise: null }))[0]).toMatchObject({ status: 'WITHHELD', withheldReason: expect.stringMatching(/cash/) });
  });

  it('stops at the single-stock cap', () => {
    const cap = 500_000_000n / 10n;
    const held = cap - 1_000_000n; // ₹10k of headroom
    const [c] = sizeCandidates(base({ holdings: [{ instrumentId: 'NSE:A', valuePaise: held, units: '100', kind: 'EQUITY', costKnown: true }] }));
    expect(held + c!.amountPaise!).toBeLessThanOrEqual(cap);
    expect(sizeCandidates(base({ holdings: [{ instrumentId: 'NSE:A', valuePaise: cap, units: '100', kind: 'EQUITY', costKnown: true }] }))[0])
      .toMatchObject({ status: 'WITHHELD', withheldReason: expect.stringMatching(/cap/) });
  });

  it('refuses a stale or missing price, and a share dearer than the whole amount', () => {
    expect(sizeCandidates(base({ quotes: new Map([['NSE:A', { pricePaise: 123_450n, asOf: '2026-09-15' }]]) }))[0])
      .toMatchObject({ status: 'WITHHELD', withheldReason: expect.stringMatching(/price/) });
    expect(sizeCandidates(base({ quotes: new Map() }))[0]).toMatchObject({ status: 'WITHHELD' });
    expect(sizeCandidates(base({ quotes: new Map([['NSE:A', { pricePaise: 9_000_000n, asOf: '2026-09-26' }]]) }))[0])
      .toMatchObject({ status: 'WITHHELD', withheldReason: expect.stringMatching(/share/) });
  });

  it('sizes a mutual fund by amount, with no units', () => {
    const [c] = sizeCandidates(base({ quotes: new Map(), buys: [{ instrumentId: 'MF:X', name: 'X Fund', kind: 'MF', score: 80 }] }));
    expect(c).toMatchObject({ status: 'ELIGIBLE', units: null, amountPaise: 5_000_000n });
  });
});

describe('selling', () => {
  const held = { instrumentId: 'NSE:B', valuePaise: 8_000_000n, units: '100', kind: 'EQUITY' as const, costKnown: true };

  it('sells every unit owned for a SELL, and no more than owned for a TRIM', () => {
    const [s] = sizeCandidates(base({ buys: [], holdings: [held], sells: [{ instrumentId: 'NSE:B', name: 'B', kind: 'EQUITY', action: 'SELL', amountPaise: null, blockedByMinimumHold: false, reason: 'falsified' }] }));
    expect(s).toMatchObject({ status: 'ELIGIBLE', units: '100' });
    // The price has fallen since the holding was valued: value / price is now more units
    // (8,000,000 / 60,000 = 134) than are owned (100). Only owned units can be sold.
    const fallen = new Map([['NSE:B', { pricePaise: 60_000n, asOf: '2026-09-26' }]]);
    const [t] = sizeCandidates(base({ buys: [], quotes: fallen, holdings: [held], sells: [{ instrumentId: 'NSE:B', name: 'B', kind: 'EQUITY', action: 'TRIM', amountPaise: 99_000_000n, blockedByMinimumHold: false, reason: 'cap' }] }));
    expect(BigInt(t!.units!)).toBeLessThanOrEqual(BigInt(held.units));
  });

  it('withholds a sale inside the minimum hold, or of units it cannot count', () => {
    const sell = { instrumentId: 'NSE:B', name: 'B', kind: 'EQUITY' as const, action: 'SELL' as const, amountPaise: null, blockedByMinimumHold: true, reason: 'x' };
    expect(sizeCandidates(base({ buys: [], holdings: [held], sells: [sell] }))[0]).toMatchObject({ status: 'WITHHELD', withheldReason: expect.stringMatching(/hold/) });
    expect(sizeCandidates(base({ buys: [], holdings: [{ ...held, units: null }], sells: [{ ...sell, blockedByMinimumHold: false }] }))[0])
      .toMatchObject({ status: 'WITHHELD', withheldReason: expect.stringMatching(/units/) });
  });

  it('flags unknown tax without inventing it', () => {
    const [s] = sizeCandidates(base({ buys: [], holdings: [{ ...held, costKnown: false }], sells: [{ instrumentId: 'NSE:B', name: 'B', kind: 'EQUITY', action: 'SELL', amountPaise: null, blockedByMinimumHold: false, reason: 'x' }] }));
    expect(s!.constraints).toContain('tax on this sale cannot be estimated: cost basis unknown');
  });
});

describe('identity', () => {
  it('gives the same candidate the same id, and a different size a different id', () => {
    expect(sizeCandidates(base())[0]!.id).toBe(sizeCandidates(base())[0]!.id);
    expect(sizeCandidates(base())[0]!.id).not.toBe(sizeCandidates(base({ tacticalBudgetPaise: 4_000_000n }))[0]!.id);
    expect(eligible(sizeCandidates(base())).every((c) => c.policyVersion === 'sizing-v1')).toBe(true);
  });
});

describe('the free envelope', () => {
  it('an unknown envelope withholds every BUY with its reason', () => {
    const reason = 'SIP commitment unknown: last SIP sync 2026-09-30 is older than 7 days';
    const out = sizeCandidates(base({ tacticalBudgetPaise: 0n, envelopeReason: reason }));
    expect(out.every((c) => c.status === 'WITHHELD' && c.withheldReason === reason)).toBe(true);
  });

  it('a zero envelope with a reason withholds with that reason, not the generic one', () => {
    const out = sizeCandidates(base({ tacticalBudgetPaise: 0n, envelopeReason: 'SIPs already use the whole budget' }));
    expect(out[0]!.withheldReason).toBe('SIPs already use the whole budget');
  });

  it('sells are unaffected by the envelope', () => {
    const out = sizeCandidates(base({
      tacticalBudgetPaise: 0n, envelopeReason: 'SIPs already use the whole budget', buys: [],
      holdings: [{ instrumentId: 'NSE:B', valuePaise: 800_000n, units: '10', kind: 'EQUITY', costKnown: true }],
      sells: [{ instrumentId: 'NSE:B', name: 'B', kind: 'EQUITY', action: 'SELL', amountPaise: null, blockedByMinimumHold: false, reason: 'falsified' }],
    }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ action: 'SELL', status: 'ELIGIBLE', units: '10' });
  });
});

describe('loadSizingInput offers at most what remains this month (SIP gaps Task 2)', () => {
  it('the budget is the envelope less this month\'s logged purchases; fully spent withholds with the reason', async () => {
    const db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
    const now = new Date().toISOString();
    await persistSipSnapshot(db, [], now);
    const envelope = (await loadFreeEnvelope(db, now)).envelopePaise!;
    const spent = 3_000_000n;
    await logPurchase(db, { boughtOn: istDate(now), description: 'Gold ETF', amountPaise: spent }, now);
    const input = await loadSizingInput(db, AS_OF);
    expect(input.tacticalBudgetPaise).toBe(envelope - spent);
    expect(input.tacticalBudgetPaise < envelope).toBe(true);

    await logPurchase(db, { boughtOn: istDate(now), description: 'Gold ETF', amountPaise: envelope }, now);
    const spentOut = await loadSizingInput(db, AS_OF);
    expect(spentOut.tacticalBudgetPaise).toBe(0n);
    expect(spentOut.envelopeReason).toMatch(/already deployed/);
    await db.close();
  });
});

describe('loadSizingInput buys only stocks that pass the gate (Piece 3 Task 3)', () => {
  it('composite ≥ 85, quality passed and five PASSes; one FAIL or composite 84 is out', async () => {
    const db = await openDb();
    await runMigrations(db);
    await seedGateStocks(db, [
      { id: 'NSE:PLEDGED', composite: 92, data: { 'Pledged %': '0.5' } },
      { id: 'NSE:LOW', composite: 84 },
      { id: 'NSE:GOOD', composite: 86 },
    ]);
    for (const id of ['NSE:PLEDGED', 'NSE:LOW', 'NSE:GOOD']) await clearGovernance(db, id, GATE_NOW);
    const input = await loadSizingInput(db, GATE_AS_OF, GATE_NOW);
    expect(input.buys).toEqual([{ instrumentId: 'NSE:GOOD', name: 'GOOD Ltd', kind: 'EQUITY', score: 86 }]);
    await db.close();
  });
});

describe('loadSizingInput counts manual-seed units after logged sales (final review I-1 sibling)', () => {
  it('US:NOW has 68 units to sell after a 10-of-78 sale, not the raw seed 78', async () => {
    const db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
    await logSale(db, { on: '2026-08-12', instrumentId: 'US:NOW', units: 10, proceedsPaise: 1n, destination: null, note: '' }, '2026-08-12T10:00:00Z');
    const input = await loadSizingInput(db, AS_OF);
    expect(input.holdings.find((h) => h.instrumentId === 'US:NOW')?.units).toBe('68');
    await db.close();
  });
});

describe('funds before stocks (Piece 3 Task 7)', () => {
  type FundBuy = SizingInput['funds']['buys'][number];
  const fund = (instrumentId: string, gapBps: number, heldPaise: bigint): FundBuy => ({
    instrumentId, name: instrumentId, kind: 'MF', fundType: 'MID', gapBps, actualBps: 2500 - gapBps, midBps: 2500, minBps: 2000, maxBps: 3000, heldPaise, quality: `rank 1 of 9 in Mid Cap`,
  });
  const funds = (buys: FundBuy[], typesBelowMidpoint: SizingInput['funds']['typesBelowMidpoint'] = ['MID']) =>
    ({ approved: true, buys, typesBelowMidpoint, excluded: [] });
  const fundIds = (out: ReturnType<typeof sizeCandidates>, f: FundBuy[]) => out.filter((c) => f.some((b) => b.instrumentId === c.instrumentId));

  it('sizes the largest gap first with the whole tranche; the next waits a month', () => {
    const buys = [fund('MF:SMALLGAP', 500, 0n), fund('MF:BIGGAP', 2000, 0n)];
    const input = base({ buys: [], funds: funds(buys) });
    const out = sizeCandidates(input);
    const tranche = min(input.tacticalBudgetPaise, input.maxOrderPaise, input.cashAvailablePaise!);
    expect(out[0]).toMatchObject({ instrumentId: 'MF:BIGGAP', action: 'BUY', status: 'ELIGIBLE', amountPaise: tranche, units: null, vehicle: 'FUND',
      fund: { fundType: 'MID', actualBps: 500, midBps: 2500, minBps: 2000, maxBps: 3000, quality: 'rank 1 of 9 in Mid Cap' } });
    expect(out[1]).toMatchObject({ instrumentId: 'MF:SMALLGAP', status: 'WITHHELD', withheldReason: expect.stringMatching(/already used/), vehicle: 'FUND' });
  });

  it('withholds a fund the tranche would take past the 35% scheme cap, and tries the next', () => {
    const input = base({ buys: [] });
    const cap = (input.portfolioPaise * 35n) / 100n;
    const held = (input.portfolioPaise * 344n) / 1000n; // 34.4%: held + tranche > cap
    expect(held + input.tacticalBudgetPaise > cap).toBe(true);
    const out = sizeCandidates({ ...input, funds: funds([fund('MF:NEARCAP', 2000, held), fund('MF:NEXT', 500, 0n)]) });
    expect(out[0]).toMatchObject({ instrumentId: 'MF:NEARCAP', status: 'WITHHELD', amountPaise: null,
      withheldReason: 'would take it above the 35% single-scheme cap (IPS §3.5)' });
    expect(out[1]).toMatchObject({ instrumentId: 'MF:NEXT', status: 'ELIGIBLE', amountPaise: input.tacticalBudgetPaise });
  });

  it('withholds a passing stock while a fund type is below its midpoint; sizes it when none is', () => {
    const behind = sizeCandidates(base({ funds: funds([], ['MID', 'US']) }));
    expect(behind).toHaveLength(1);
    expect(behind[0]).toMatchObject({ instrumentId: 'NSE:A', status: 'WITHHELD', vehicle: 'STOCK', fund: null,
      withheldReason: 'not this month — a fund is below target (Mid cap, US index)' });
    const clear = sizeCandidates(base({ funds: funds([], []) }));
    expect(clear[0]).toMatchObject({ instrumentId: 'NSE:A', status: 'ELIGIBLE', vehicle: 'STOCK' });
  });

  it('withholds every stock BUY before a mix is signed', () => {
    const out = sizeCandidates(base({ funds: { approved: false, buys: [], typesBelowMidpoint: [], excluded: [] } }));
    expect(out[0]).toMatchObject({ status: 'WITHHELD', withheldReason: 'no approved fund mix yet — approve it on /funds' });
  });

  it('a fund is withheld on unknown cash, and on a zero envelope with its reason (Review Focus 5)', () => {
    const f = [fund('MF:F', 2000, 0n)];
    expect(sizeCandidates(base({ buys: [], funds: funds(f), cashAvailablePaise: null }))[0])
      .toMatchObject({ status: 'WITHHELD', withheldReason: 'cash available cannot be established' });
    expect(sizeCandidates(base({ buys: [], funds: funds(f), tacticalBudgetPaise: 0n, envelopeReason: 'SIPs already use the whole budget' }))[0])
      .toMatchObject({ status: 'WITHHELD', withheldReason: 'SIPs already use the whole budget' });
  });

  it('never sells from a fund candidate; a sale keeps its vehicle by kind', () => {
    const f = [fund('MF:A', 2000, 0n), fund('MF:B', 1000, 400_000_000n), fund('MF:C', 10, 0n)];
    for (const over of [{}, { cashAvailablePaise: null }, { tacticalBudgetPaise: 0n, envelopeReason: 'x' }]) {
      const out = fundIds(sizeCandidates(base({ ...over, buys: [], funds: funds(f) })), f);
      expect(out).toHaveLength(3);
      expect(out.every((c) => c.action === 'BUY' && c.vehicle === 'FUND')).toBe(true);
    }
    const sells = sizeCandidates(base({
      buys: [],
      holdings: [{ instrumentId: 'MF:X', valuePaise: 1_000n, units: null, kind: 'MF', costKnown: true }, { instrumentId: 'NSE:B', valuePaise: 80_000n, units: '1', kind: 'EQUITY', costKnown: true }],
      sells: [{ instrumentId: 'MF:X', name: 'X', kind: 'MF', action: 'SELL', amountPaise: null, blockedByMinimumHold: false, reason: 'r' },
        { instrumentId: 'NSE:B', name: 'B', kind: 'EQUITY', action: 'SELL', amountPaise: null, blockedByMinimumHold: false, reason: 'r' }],
    }));
    expect(sells.map((c) => [c.instrumentId, c.vehicle])).toEqual([['MF:X', 'FUND'], ['NSE:B', 'STOCK']]);
  });
});

const min = (...xs: bigint[]): bigint => xs.reduce((m, x) => (x < m ? x : m));
