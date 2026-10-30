import { createHash } from 'node:crypto';
import { FUND_TYPE_LABEL, byGap, type FundCandidates, type FundType } from './fund-types.js';

/**
 * Deterministic sizing of actionable candidates (Phase 2.5 Task 4).
 *
 * The LLM advisor may choose among these, and choose HOLD/WAIT; it can never change a size.
 * Every amount comes from money and rails — the free envelope: budget − live SIPs, capped by
 * the tactical rail (owner, 2026-09-27: one tranche = min(envelope, max order)), cash that is not the emergency fund, open
 * requests already reserved, the single-stock cap, and units actually owned — never from a
 * score. Pure: the loader that reads the database lives in sizing-input.ts.
 *
 * Funds first (Piece 3, Decisions 7–8): held funds below their signed midpoint are tried
 * before any stock, and stocks wait while any fund type is below its midpoint or no mix is
 * signed. A fund the tranche would take above the single-scheme cap is withheld, never
 * clamped. Fund candidates are only ever BUYs.
 */

export const SIZING_POLICY = 'sizing-v1';
/** The one withheld reason that says nothing against the candidate itself: the month's tranche went first. */
export const TRANCHE_USED = 'this month\'s tactical budget is already used by a higher-ranked candidate';
/** A price older than this cannot size an order. */
const QUOTE_MAX_AGE_DAYS = 5;

type Kind = 'EQUITY' | 'ETF' | 'MF' | 'BOND' | 'GOLD' | string;
/** Bought in whole units at the last close; everything else (MF) by amount at NAV. */
export const EXCHANGE_TRADED = new Set(['EQUITY', 'ETF', 'GOLD']);

export interface SizingInput {
  asOf: string;
  tacticalBudgetPaise: bigint;
  /** Why the monthly budget is 0/unknown (live SIPs). Withheld BUYs quote it verbatim. */
  envelopeReason: string | null;
  maxOrderPaise: bigint;
  /** Bank cash minus the emergency fund. NULL when it cannot be established. */
  cashAvailablePaise: bigint | null;
  /** Open BUY requests not yet executed: money already spoken for. */
  reservedPaise: bigint;
  portfolioPaise: bigint;
  singleStockCapPct: number;
  holdings: { instrumentId: string; valuePaise: bigint; units: string | null; kind: Kind; costKnown: boolean }[];
  quotes: Map<string, { pricePaise: bigint; asOf: string }>;
  buys: { instrumentId: string; name: string; kind: Kind; score: number }[];
  sells: { instrumentId: string; name: string; kind: Kind; action: 'SELL' | 'TRIM'; amountPaise: bigint | null; blockedByMinimumHold: boolean; reason: string }[];
  funds: FundCandidates;
  /** IPS §3.5, of `portfolioPaise` (the base the single-stock cap uses): 35. */
  singleSchemeCapPct: number;
}

export interface Candidate {
  id: string;
  action: 'BUY' | 'SELL' | 'TRIM';
  instrumentId: string;
  name: string;
  status: 'ELIGIBLE' | 'WITHHELD';
  withheldReason: string | null;
  amountPaise: bigint | null;
  /** Whole units for exchange-traded instruments; NULL for a fund bought or redeemed by amount. */
  units: string | null;
  pricePaise: bigint | null;
  quoteAsOf: string | null;
  basis: string;
  constraints: string[];
  policyVersion: string;
  /** BUY: where it came from. SELL/TRIM: FUND for MF and ETF kinds, STOCK otherwise. */
  vehicle: 'FUND' | 'STOCK';
  fund: { fundType: FundType; actualBps: number; midBps: number; minBps: number; maxBps: number; quality: string } | null;
}

const days = (a: string, b: string): number => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
const min = (...xs: bigint[]): bigint => xs.reduce((m, x) => (x < m ? x : m));

/** The last close if it is fresh enough to size an order, else why not. */
export function freshQuote(input: Pick<SizingInput, 'quotes' | 'asOf'>, id: string): { pricePaise: bigint; asOf: string } | string {
  const q = input.quotes.get(id);
  if (!q) return 'no price on record';
  if (days(q.asOf, input.asOf) > QUOTE_MAX_AGE_DAYS) return `price is stale (last close ${q.asOf})`;
  return q;
}

/** Stocks wait while no fund mix is signed or any fund type is below its midpoint; null = they may buy. */
export function stocksWait(funds: FundCandidates): string | null {
  return !funds.approved ? 'no approved fund mix yet — approve it on /funds'
    : funds.typesBelowMidpoint.length > 0
      ? `not this month — a fund is below target (${funds.typesBelowMidpoint.map((t) => FUND_TYPE_LABEL[t]).join(', ')})`
      : null;
}

function withId(c: Omit<Candidate, 'id' | 'policyVersion'>, asOf: string): Candidate {
  const key = JSON.stringify([c.action, c.instrumentId, String(c.amountPaise), c.units, asOf, SIZING_POLICY]);
  return { ...c, id: createHash('sha256').update(key).digest('hex').slice(0, 16), policyVersion: SIZING_POLICY };
}

type BuyBase = Pick<Candidate, 'action' | 'instrumentId' | 'name' | 'amountPaise' | 'units' | 'pricePaise' | 'quoteAsOf' | 'constraints' | 'vehicle' | 'fund'>;

export function sizeCandidates(input: SizingInput): Candidate[] {
  const out: Candidate[] = [];
  const holding = new Map(input.holdings.map((h) => [h.instrumentId, h]));
  const cap = (input.portfolioPaise * BigInt(Math.round(input.singleStockCapPct * 100))) / 10_000n;
  const schemeCap = (input.portfolioPaise * BigInt(Math.round(input.singleSchemeCapPct * 100))) / 10_000n;
  const cash = input.cashAvailablePaise === null ? null : input.cashAvailablePaise - input.reservedPaise;
  let budget = min(input.tacticalBudgetPaise, input.maxOrderPaise);
  let cashLeft = cash;

  const quoteFor = (id: string) => freshQuote(input, id);

  const withholder = (base: BuyBase) => (reason: string, basis = '') =>
    out.push(withId({ ...base, status: 'WITHHELD', withheldReason: reason, basis }, input.asOf));
  /** Why this month has no tranche left, or null. */
  const noTranche = (): string | null => {
    if (input.envelopeReason !== null && budget <= 0n) return input.envelopeReason;
    if (budget <= 0n) return TRANCHE_USED;
    return null;
  };
  /** Whole units for an exchange-traded kind, then the month's single tranche is spent. */
  const fill = (base: BuyBase, kind: Kind, sized: bigint, cashNow: bigint, basis: string): void => {
    let amount = sized;
    let units: string | null = null; let price: bigint | null = null; let quoteAsOf: string | null = null;
    if (EXCHANGE_TRADED.has(kind)) {
      const q = quoteFor(base.instrumentId);
      if (typeof q === 'string') { withholder(base)(q, basis); return; }
      const n = amount / q.pricePaise;
      if (n === 0n) { withholder(base)(`one share costs more than the ₹${amount / 100n} available`, basis); return; }
      units = n.toString(); price = q.pricePaise; quoteAsOf = q.asOf; amount = n * q.pricePaise;
    }
    // One tranche a month (owner, 2026-09-27): the rounding remainder is not a second buy.
    budget = 0n; cashLeft = cashNow - amount;
    out.push(withId({ ...base, status: 'ELIGIBLE', withheldReason: null, amountPaise: amount, units, pricePaise: price, quoteAsOf, basis }, input.asOf));
  };

  for (const f of [...input.funds.buys].sort(byGap)) {
    const base: BuyBase = { action: 'BUY', instrumentId: f.instrumentId, name: f.name, amountPaise: null, units: null, pricePaise: null, quoteAsOf: null,
      constraints: [], vehicle: 'FUND', fund: { fundType: f.fundType, actualBps: f.actualBps, midBps: f.midBps, minBps: f.minBps, maxBps: f.maxBps, quality: f.quality } };
    const withhold = withholder(base);
    if (cashLeft === null) { withhold('cash available cannot be established'); continue; }
    const blocked = noTranche();
    if (blocked !== null) { withhold(blocked); continue; }
    const tranche = min(budget, cashLeft);
    if (tranche <= 0n) { withhold('no free cash after the emergency fund and open requests'); continue; }
    // Withheld, never clamped: a top-up shrunk to fit is not the tranche, and the next fund may take it whole.
    if (f.heldPaise + tranche > schemeCap) { withhold(`would take it above the ${input.singleSchemeCapPct}% single-scheme cap (IPS §3.5)`); continue; }
    fill(base, f.kind, tranche, cashLeft,
      `min(monthly tranche ₹${budget / 100n}, free cash ₹${cashLeft / 100n}); ${FUND_TYPE_LABEL[f.fundType]} ${f.actualBps / 100}% vs midpoint ${f.midBps / 100}%`);
  }

  const wait = stocksWait(input.funds);
  for (const b of [...input.buys].sort((x, y) => y.score - x.score || x.instrumentId.localeCompare(y.instrumentId))) {
    const base: BuyBase = { action: 'BUY', instrumentId: b.instrumentId, name: b.name, amountPaise: null, units: null, pricePaise: null, quoteAsOf: null,
      constraints: [], vehicle: 'STOCK', fund: null };
    const withhold = withholder(base);
    if (wait !== null) { withhold(wait); continue; }
    if (cashLeft === null) { withhold('cash available cannot be established'); continue; }
    const blocked = noTranche();
    if (blocked !== null) { withhold(blocked); continue; }
    const held = holding.get(b.instrumentId)?.valuePaise ?? 0n;
    const headroom = cap - held;
    if (headroom <= 0n) { withhold(`already at the ${input.singleStockCapPct}% single-stock cap`); continue; }
    const amount = min(budget, cashLeft, headroom);
    if (amount <= 0n) { withhold('no free cash after the emergency fund and open requests'); continue; }
    fill(base, b.kind, amount, cashLeft, `min(monthly tranche ₹${budget / 100n}, free cash ₹${cashLeft / 100n}, cap headroom ₹${headroom / 100n})`);
  }

  for (const s of input.sells) {
    const h = holding.get(s.instrumentId);
    const base = { action: s.action, instrumentId: s.instrumentId, name: s.name, amountPaise: null, units: null, pricePaise: null, quoteAsOf: null,
      constraints: h && !h.costKnown ? ['tax on this sale cannot be estimated: cost basis unknown'] : [],
      vehicle: s.kind === 'MF' || s.kind === 'ETF' ? 'FUND' as const : 'STOCK' as const, fund: null };
    const withhold = (reason: string) => out.push(withId({ ...base, status: 'WITHHELD', withheldReason: reason, basis: s.reason }, input.asOf));
    if (s.blockedByMinimumHold) { withhold('inside the 12-month minimum hold (IPS §3.7)'); continue; }
    if (!h) { withhold('not held'); continue; }
    const wanted = s.action === 'SELL' ? h.valuePaise : min(s.amountPaise ?? h.valuePaise, h.valuePaise);

    if (!EXCHANGE_TRADED.has(s.kind)) {
      out.push(withId({ ...base, status: 'ELIGIBLE', withheldReason: null, amountPaise: wanted, basis: `${s.reason}; redeem by amount at NAV` }, input.asOf));
      continue;
    }
    if (h.units === null) { withhold('units owned cannot be counted'); continue; }
    const owned = BigInt(h.units.split('.')[0]!);
    const q = quoteFor(s.instrumentId);
    if (typeof q === 'string') { withhold(q); continue; }
    const units = s.action === 'SELL' ? owned : min(owned, (wanted + q.pricePaise - 1n) / q.pricePaise);
    if (units <= 0n) { withhold('nothing to sell'); continue; }
    out.push(withId({ ...base, status: 'ELIGIBLE', withheldReason: null, units: units.toString(), amountPaise: units * q.pricePaise,
      pricePaise: q.pricePaise, quoteAsOf: q.asOf, basis: s.reason }, input.asOf));
  }
  return out;
}
