import { describe, expect, it } from 'vitest';
import { sizeCandidates, type SizingInput } from '../../src/domain/sizing.js';

/**
 * Phase 2.5 Task 4. The LLM advisor chooses among candidates; this decides how much. Every
 * amount comes from real money and rails — the tactical budget, cash that is not the
 * emergency fund, the single-stock cap and units actually owned — and never from a score.
 */
const AS_OF = '2026-09-27';
const base = (over: Partial<SizingInput> = {}): SizingInput => ({
  asOf: AS_OF,
  tacticalBudgetPaise: 5_000_000n,       // ₹50k a month
  maxOrderPaise: 10_000_000n,
  cashAvailablePaise: 20_000_000n,       // ₹2L free cash
  reservedPaise: 0n,
  portfolioPaise: 500_000_000n,          // ₹50L
  singleStockCapPct: 10,
  holdings: [],
  quotes: new Map([['NSE:A', { pricePaise: 123_450n, asOf: '2026-09-26' }], ['NSE:B', { pricePaise: 80_000n, asOf: '2026-09-26' }]]),
  buys: [{ instrumentId: 'NSE:A', name: 'A Ltd', kind: 'EQUITY', score: 80 }],
  sells: [],
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
