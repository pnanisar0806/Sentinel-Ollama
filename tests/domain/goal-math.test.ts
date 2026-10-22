import { describe, expect, it } from 'vitest';
import {
  firstMonthReaching, levelMonthlyToClose, newMoneyMix, potsTotal, project, realRates,
  type Mix, type Pots, type Rates,
} from '../../src/domain/goal-math.js';
import { rupees } from '../../src/money/paise.js';

const ZERO: Pots = { equity: 0n, debt: 0n, gold: 0n, cash: 0n };
const NO_RATES: Rates = { equityBps: 0, debtBps: 0, goldBps: 0, cashBps: 0 };
const ALL_EQUITY: Mix = { equityBps: 10_000, debtBps: 0, goldBps: 0 };
const flat = (bps: number): Rates => ({ equityBps: bps, debtBps: bps, goldBps: bps, cashBps: bps });

describe('realRates', () => {
  it('central is nominal minus inflation, in bps', () => {
    expect(realRates('central')).toEqual({ equityBps: 600, debtBps: 100, goldBps: 200, cashBps: -350 });
  });
  it('bands move equity/debt/gold; cash has no band', () => {
    expect(realRates('pessimistic')).toEqual({ equityBps: 300, debtBps: -100, goldBps: 0, cashBps: -350 });
    expect(realRates('optimistic')).toEqual({ equityBps: 900, debtBps: 300, goldBps: 400, cashBps: -350 });
  });
});

describe('newMoneyMix', () => {
  it('equity = ceiling, gold = 7.5%, debt = rest', () => {
    expect(newMoneyMix(60)).toEqual({ equityBps: 6000, debtBps: 3250, goldBps: 750 });
    expect(newMoneyMix(92.5)).toEqual({ equityBps: 9250, debtBps: 0, goldBps: 750 });
  });
  it('throws outside [0, 92.5]', () => {
    expect(() => newMoneyMix(93)).toThrow();
    expect(() => newMoneyMix(-1)).toThrow();
    expect(() => newMoneyMix(Number.NaN)).toThrow();
  });
});

describe('project', () => {
  it('zero rates, no growth: start + months x contribution, exactly', () => {
    const start: Pots = { equity: rupees(1000), debt: rupees(2000), gold: rupees(300), cash: rupees(50) };
    const out = project(start, {
      months: 25, monthlyPaise: rupees(10_000), mix: newMoneyMix(60), growthBps: 0, rates: NO_RATES,
    });
    expect(potsTotal(out)).toBe(potsTotal(start) + 25n * rupees(10_000));
    expect(out.cash).toBe(start.cash); // new money never goes to cash
    expect(out.equity).toBe(start.equity + 25n * rupees(6000));
    expect(out.gold).toBe(start.gold + 25n * rupees(750));
    expect(out.debt).toBe(start.debt + 25n * rupees(3250));
  });

  it('one year of ₹1,00,000 equity at central: 12 floored 0.5% steps', () => {
    const out = project({ ...ZERO, equity: rupees(100_000) }, {
      months: 12, monthlyPaise: 0n, mix: ALL_EQUITY, growthBps: 0, rates: realRates('central'),
    });
    expect(out.equity).toBeGreaterThanOrEqual(rupees(106_000));
    expect(out.equity).toBeLessThan(rupees(106_200));
    // floors: replay the exact step in bigint
    let e = rupees(100_000) as bigint;
    for (let i = 0; i < 12; i++) e += (e * 5n) / 1000n;
    expect(out.equity).toBe(e);
  });

  it('flooring on an odd balance rounds the monthly delta down', () => {
    const out = project({ ...ZERO, equity: 199n }, {
      months: 1, monthlyPaise: 0n, mix: ALL_EQUITY, growthBps: 0, rates: realRates('central'),
    });
    expect(out.equity).toBe(199n); // 199 * 0.005 = 0.995 -> 0
  });

  it('step-up lands on month 12 (the 13th contribution), not month 11', () => {
    const opts = { monthlyPaise: rupees(1000), mix: ALL_EQUITY, growthBps: 1000, rates: NO_RATES };
    const at = (months: number) => potsTotal(project(ZERO, { ...opts, months }));
    expect(at(12) - at(11)).toBe(rupees(1000));
    expect(at(13) - at(12)).toBe(rupees(1100));
    expect(at(25) - at(24)).toBe(rupees(1210));
  });

  it('shockAtMonth 0 halves equity, leaves debt and gold untouched', () => {
    const start: Pots = { equity: rupees(100_000), debt: rupees(40_000), gold: rupees(7000), cash: 0n };
    const out = project(start, {
      months: 1, monthlyPaise: 0n, mix: ALL_EQUITY, growthBps: 0, rates: NO_RATES, shockAtMonth: 0,
    });
    expect(out).toEqual({ ...start, equity: rupees(50_000) });
  });

  it('cash shrinks in real terms: ₹1,00,000 for 12 months is in (₹96,000, ₹1,00,000)', () => {
    const out = project({ ...ZERO, cash: rupees(100_000) }, {
      months: 12, monthlyPaise: 0n, mix: ALL_EQUITY, growthBps: 0, rates: realRates('central'),
    });
    expect(out.cash).toBeLessThan(rupees(100_000));
    expect(out.cash).toBeGreaterThan(rupees(96_000));
  });

  it('a negative rate floors toward -infinity: 1 paisa of cash decays to 0, never stays', () => {
    const out = project({ ...ZERO, cash: 1n }, {
      months: 1, monthlyPaise: 0n, mix: ALL_EQUITY, growthBps: 0, rates: realRates('central'),
    });
    expect(out.cash).toBe(0n);
  });
});

describe('levelMonthlyToClose', () => {
  const reaches = (monthly: bigint, months: number, bps: number, gap: bigint) =>
    potsTotal(project(ZERO, { months, monthlyPaise: monthly, mix: ALL_EQUITY, growthBps: 0, rates: flat(bps) })) >= gap;

  const cases: [bigint, number, number][] = [
    [rupees(6_500_000), 84, 100],   // house-sized gap at debt real rate
    [rupees(10_000_000), 216, 600], // education-sized gap at equity real rate
    [rupees(123_457.89), 13, -350], // negative rate
  ];

  it.each(cases)('result reaches gap %s over %i months at %i bps, minus ₹1 does not', (gap, months, bps) => {
    const m = levelMonthlyToClose(gap, months, bps);
    expect(m % 100n).toBe(0n); // whole rupees
    expect(reaches(m, months, bps, gap)).toBe(true);
    expect(reaches(m - 100n, months, bps, gap)).toBe(false);
  });

  it('edge cases: no gap -> 0, no months -> the whole gap', () => {
    expect(levelMonthlyToClose(0n, 12, 600)).toBe(0n);
    expect(levelMonthlyToClose(-5n, 12, 600)).toBe(0n);
    expect(levelMonthlyToClose(rupees(5000), 0, 600)).toBe(rupees(5000));
    expect(levelMonthlyToClose(rupees(5000), -3, 600)).toBe(rupees(5000));
  });
});

describe('firstMonthReaching', () => {
  const opts = { monthlyPaise: rupees(1000), mix: ALL_EQUITY, growthBps: 0, rates: NO_RATES };

  it('returns the month index the total first reaches the target', () => {
    expect(firstMonthReaching(ZERO, rupees(5000), opts)).toBe(5);
    expect(firstMonthReaching({ ...ZERO, debt: rupees(5000) }, rupees(5000), opts)).toBe(0);
  });

  it('returns null when unreachable within maxMonths', () => {
    expect(firstMonthReaching(ZERO, rupees(5000), opts, 4)).toBeNull();
    expect(firstMonthReaching(ZERO, rupees(1), { ...opts, monthlyPaise: 0n })).toBeNull();
  });
});
