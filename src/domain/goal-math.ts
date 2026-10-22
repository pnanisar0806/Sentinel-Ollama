/**
 * Goal-plan projection math. Pure: no DB, no clock, no funded-status/buckets imports.
 * Everything is in real terms (today's money). Money is bigint paise; rates are integer bps.
 *
 * Rounding rule: each month a pot changes by floor(pot × annualBps / 120 000) — i.e.
 * annualBps/12 per month, computed as one exact rational and floored toward −∞. A growing
 * pot gains at most the exact amount; a shrinking pot loses at least it. Balances clamp at 0.
 * (Exact rational rather than integer micros: 100 bps/12 = 833.33 micros would otherwise
 * truncate every month.)
 */
import { ASSUMPTIONS } from '../config/assumptions.js';

export type Mix = { equityBps: number; debtBps: number; goldBps: number };
/** Annual real rates in bps; `cashBps` is negative. */
export type Rates = { equityBps: number; debtBps: number; goldBps: number; cashBps: number };
export interface Pots { equity: bigint; debt: bigint; gold: bigint; cash: bigint }
export type ProjectOpts = {
  months: number;
  monthlyPaise: bigint;
  mix: Mix;
  /** Contribution step-up applied every 12 months from month 0. */
  growthBps: number;
  rates: Rates;
  /** Equity drops by `crashEquityDrop` at the end of this month index. */
  shockAtMonth?: number;
};

const bps = (x: number): number => Math.round(x * 10_000);

export function realRates(scenario: 'central' | 'pessimistic' | 'optimistic'): Rates {
  const A = ASSUMPTIONS;
  const sign = scenario === 'central' ? 0 : scenario === 'pessimistic' ? -1 : 1;
  const real = (nominal: number, band: number) => bps(nominal) - bps(A.inflation) + sign * bps(band);
  return {
    equityBps: real(A.equityNominalCagr, A.sensitivityBand),
    debtBps: real(A.debtNominalCagr, A.debtSensitivityBand),
    goldBps: real(A.goldNominalCagr, A.goldSensitivityBand),
    cashBps: real(A.cashNominalCagr, 0),
  };
}

export function newMoneyMix(equityCeilingPct: number): Mix {
  const goldBps = bps(ASSUMPTIONS.goalGoldMixPct / 100);
  const equityBps = bps(equityCeilingPct / 100);
  if (!(equityBps >= 0 && equityBps <= 10_000 - goldBps)) {
    throw new Error(`equity ceiling ${equityCeilingPct}% outside [0, ${100 - ASSUMPTIONS.goalGoldMixPct}]`);
  }
  return { equityBps, debtBps: 10_000 - equityBps - goldBps, goldBps };
}

export const potsTotal = (p: Pots): bigint => p.equity + p.debt + p.gold + p.cash;

const floorDiv = (a: bigint, b: bigint): bigint => {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
};
const grow = (pot: bigint, annualBps: number): bigint => {
  const next = pot + floorDiv(pot * BigInt(annualBps), 120_000n);
  return next < 0n ? 0n : next;
};

/** Runs month by month; stops early (returning that month count) once the total reaches `until`. */
function run(start: Pots, o: ProjectOpts, until?: bigint): { pots: Pots; months: number } {
  let p = { ...start };
  let monthly = o.monthlyPaise;
  const shockKeep = BigInt(10_000 - bps(ASSUMPTIONS.crashEquityDrop));
  for (let m = 0; m < o.months; m++) {
    if (until !== undefined && potsTotal(p) >= until) return { pots: p, months: m };
    if (m > 0 && m % 12 === 0) monthly += (monthly * BigInt(o.growthBps)) / 10_000n;
    p = {
      equity: grow(p.equity, o.rates.equityBps),
      debt: grow(p.debt, o.rates.debtBps),
      gold: grow(p.gold, o.rates.goldBps),
      cash: grow(p.cash, o.rates.cashBps),
    };
    const eq = (monthly * BigInt(o.mix.equityBps)) / 10_000n;
    const gd = (monthly * BigInt(o.mix.goldBps)) / 10_000n;
    p.equity += eq;
    p.gold += gd;
    p.debt += monthly - eq - gd; // remainder to debt: no paisa lost to rounding
    if (o.shockAtMonth === m) p.equity = (p.equity * shockKeep) / 10_000n;
  }
  return { pots: p, months: o.months };
}

export const project = (start: Pots, opts: ProjectOpts): Pots => run(start, opts).pots;

/**
 * Flat monthly amount (no step-up) whose future value at `annualBps`, under `project`'s own
 * flooring, reaches `gapPaise`; rounded up to the rupee. Found by bisection on `project`
 * itself so the answer is exact for the model, not an analytic approximation of it.
 */
export function levelMonthlyToClose(gapPaise: bigint, months: number, annualBps: number): bigint {
  if (gapPaise <= 0n) return 0n;
  if (months <= 0) return gapPaise;
  const rates = { equityBps: annualBps, debtBps: 0, goldBps: 0, cashBps: 0 };
  const mix = { equityBps: 10_000, debtBps: 0, goldBps: 0 };
  const zero = { equity: 0n, debt: 0n, gold: 0n, cash: 0n };
  const reaches = (monthlyPaise: bigint) =>
    project(zero, { months, monthlyPaise, mix, growthBps: 0, rates }).equity >= gapPaise;
  // The last month's contribution is never grown, so paying the whole gap always reaches it.
  let lo = 0n;
  let hi = gapPaise;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (reaches(mid)) hi = mid; else lo = mid;
  }
  return ((hi + 99n) / 100n) * 100n;
}

/** Smallest month count m ≤ maxMonths after which the total ≥ target (0 = already there), else null. */
export function firstMonthReaching(
  start: Pots, target: bigint, opts: Omit<ProjectOpts, 'months'>, maxMonths = 1200,
): number | null {
  const r = run(start, { ...opts, months: maxMonths }, target);
  return potsTotal(r.pots) >= target ? r.months : null;
}
