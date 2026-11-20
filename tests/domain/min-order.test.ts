import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { DEFAULT_OWNER_RAILS } from '../../src/domain/rail-values.js';
import { isLoosening } from '../../src/domain/controls.js';
import type { Candidate, SizingInput } from '../../src/domain/sizing.js';
import type { LumpSizingInput } from '../../src/domain/lump-sizing.js';

/**
 * Open list #28 (owner, 2026-11-19): a minimum order of ₹1,000. Below it there is no BUY; the
 * month (or lump sum) says why, and the money stays in the bank. SIPs reached ₹49,804 of the
 * ₹50,000 budget in November, so December's tranche would otherwise be a ₹196 BUY.
 */
vi.mock('../../src/domain/mf-switch.js', () => ({ evaluateSwitches: vi.fn(async () => []) }));
const { sizeCandidates } = await import('../../src/domain/sizing.js');
const { allocateLumpSum, sizeLumpSum } = await import('../../src/domain/lump-sizing.js');
const { loadSizingInput } = await import('../../src/domain/sizing-input.js');
const { runAdvisor } = await import('../../src/advisor/recommend.js');

const MIN = 1_00_000n; // ₹1,000
const AS_OF = '2026-12-06';
type FundBuy = SizingInput['funds']['buys'][number];
const fund = (instrumentId: string, gapBps: number): FundBuy => ({
  instrumentId, name: instrumentId, kind: 'MF', fundType: 'SMALL', gapBps, actualBps: 1000 - gapBps, midBps: 1000, minBps: 500, maxBps: 1500, heldPaise: 0n, quality: 'q',
});
const base = (over: Partial<SizingInput> = {}): SizingInput => ({
  asOf: AS_OF, tacticalBudgetPaise: 19_600n, envelopeReason: null, maxOrderPaise: 100_00_000n, minOrderPaise: MIN,
  cashAvailablePaise: 20_000_000n, reservedPaise: 0n, portfolioPaise: 500_000_000n, singleStockCapPct: 10, holdings: [],
  quotes: new Map([['NSE:A', { pricePaise: 123_450n, asOf: '2026-12-04' }], ['NSE:B', { pricePaise: 80_000n, asOf: '2026-12-04' }]]),
  buys: [], sells: [], funds: { approved: true, buys: [fund('MF:A', 600), fund('MF:B', 300)], typesBelowMidpoint: ['SMALL'], excluded: [] },
  singleSchemeCapPct: 35, ...over,
});
const eligible = (c: Candidate[]) => c.filter((x) => x.status === 'ELIGIBLE');

describe('the minimum order rail', () => {
  it('defaults to ₹1,000, and lowering it is the loosening (its /rails label: tests/web/rail-form.test.ts)', () => {
    expect(DEFAULT_OWNER_RAILS.min_order_paise).toBe(Number(MIN));
    expect(isLoosening('min_order_paise', Number(MIN), 50_000)).toBe(true);
    expect(isLoosening('min_order_paise', Number(MIN), 2_00_000)).toBe(false);
  });

  it('migration writes the owner value, and the sizing input reads the rail', async () => {
    const db = await openDb();
    await runMigrations(db);
    const [row] = await db.query<{ value: unknown }>(`select value from settings_rails where key = 'min_order_paise'`);
    expect(Number(row?.value)).toBe(Number(MIN));
    await db.query(`update settings_rails set value = '250000'::jsonb where key = 'min_order_paise'`);
    expect((await loadSizingInput(db, AS_OF, new Date('2026-12-06T04:30:00Z'))).minOrderPaise).toBe(2_50_000n);
  });
});

describe('monthly sizing below the minimum', () => {
  it('a ₹196 tranche buys nothing, and every fund says why', () => {
    const out = sizeCandidates(base());
    expect(eligible(out)).toEqual([]);
    for (const c of out) expect(c).toMatchObject({ status: 'WITHHELD', withheldReason: '₹196 is below the ₹1,000 minimum order' });
  });

  it('a tranche of exactly the minimum is bought', () => {
    expect(eligible(sizeCandidates(base({ tacticalBudgetPaise: MIN })))).toMatchObject([{ instrumentId: 'MF:A', amountPaise: MIN }]);
  });

  it('free cash below the minimum binds the same way', () => {
    const [c] = sizeCandidates(base({ tacticalBudgetPaise: 50_00_000n, cashAvailablePaise: 90_000n }));
    expect(c).toMatchObject({ status: 'WITHHELD', withheldReason: '₹900 is below the ₹1,000 minimum order' });
  });

  it('whole shares rounding below the minimum withhold the stock and leave the tranche for the next', () => {
    // Tranche ₹1,500: B (₹800 a share) buys one share, ₹800 < ₹1,000; A (₹1,234.50) still gets the tranche.
    const out = sizeCandidates(base({
      tacticalBudgetPaise: 1_50_000n, funds: { approved: true, buys: [], typesBelowMidpoint: [], excluded: [] },
      buys: [{ instrumentId: 'NSE:B', name: 'B', kind: 'EQUITY', score: 90 }, { instrumentId: 'NSE:A', name: 'A', kind: 'EQUITY', score: 80 }],
    }));
    expect(out.find((c) => c.instrumentId === 'NSE:B')).toMatchObject({ status: 'WITHHELD', withheldReason: '₹800 is below the ₹1,000 minimum order' });
    expect(out.find((c) => c.instrumentId === 'NSE:A')).toMatchObject({ status: 'ELIGIBLE', units: '1', amountPaise: 123_450n });
  });
});

describe('lump sums below the minimum', () => {
  const lump = (remainingPaise: bigint, over: Partial<SizingInput> = {}): LumpSizingInput => ({
    lumpSumId: '9', remainingPaise, fundTotalPaise: 100_000_000n, typeValuePaise: {}, newFunds: [], gold: null, rules: [], month: '2026-12',
    aliases: {}, held: {}, sizing: base({ tacticalBudgetPaise: 0n, ...over }),
  });

  it('a lump sum left below the minimum sizes nothing', () => {
    const out = sizeLumpSum(lump(50_000n));
    expect(eligible(out)).toEqual([]);
    expect(out[0]).toMatchObject({ withheldReason: '₹500 is below the ₹1,000 minimum order' });
  });

  it('whole shares rounding below the minimum withhold the stock', () => {
    const out = sizeLumpSum(lump(1_50_000n, { funds: { approved: true, buys: [], typesBelowMidpoint: [], excluded: [] },
      buys: [{ instrumentId: 'NSE:B', name: 'B', kind: 'EQUITY', score: 90 }] }));
    expect(out[0]).toMatchObject({ instrumentId: 'NSE:B', status: 'WITHHELD', withheldReason: '₹800 is below the ₹1,000 minimum order' });
  });

  it('a second part below the minimum is dropped; its money stays', () => {
    const candidates = sizeLumpSum(lump(10_50_000n, { maxOrderPaise: 10_00_000n }));
    const ids = eligible(candidates).map((c) => c.id);
    expect(ids).toHaveLength(2);
    const parts = allocateLumpSum(candidates, ids, 10_50_000n, { freeCashPaise: 20_000_000n, typeRoomPaise: { SMALL: 20_000_000n }, goldRoomPaise: null, minOrderPaise: MIN });
    expect(parts.map((p) => p.amountPaise)).toEqual([10_00_000n]); // ₹500 left is not a part
  });
});

describe('the month the minimum stops every buy', () => {
  it('the advice says nothing is invested and why, not just "nothing eligible"', async () => {
    const db = await openDb();
    await runMigrations(db);
    const r = await runAdvisor(db, { asOf: AS_OF, candidates: sizeCandidates(base()), apiKey: 'k', now: new Date('2026-12-06T04:30:00Z') });
    expect(r.decision).toBe('NO_ACTION');
    const [row] = await db.query<{ payload: unknown }>(`select payload from advisor_proposals where id = $1`, [r.proposalId]);
    const p = (typeof row!.payload === 'string' ? JSON.parse(row!.payload) : row!.payload) as { reason: string };
    expect(p.reason).toBe('Nothing to invest this month: ₹196 is below the ₹1,000 minimum order. The money stays in the bank.');
  });
});
