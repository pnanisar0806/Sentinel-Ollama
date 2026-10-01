import { createHash } from 'node:crypto';

/**
 * Deterministic sizing of actionable candidates (Phase 2.5 Task 4).
 *
 * The LLM advisor may choose among these, and choose HOLD/WAIT; it can never change a size.
 * Every amount comes from money and rails — the monthly tactical budget (owner, 2026-09-27:
 * one tranche = min(tactical, max order)), cash that is not the emergency fund, open
 * requests already reserved, the single-stock cap, and units actually owned — never from a
 * score. Pure: the loader that reads the database lives in sizing-input.ts.
 */

export const SIZING_POLICY = 'sizing-v1';
/** A price older than this cannot size an order. */
const QUOTE_MAX_AGE_DAYS = 5;

type Kind = 'EQUITY' | 'ETF' | 'MF' | 'BOND' | 'GOLD' | string;
const EXCHANGE_TRADED = new Set(['EQUITY', 'ETF', 'GOLD']);

export interface SizingInput {
  asOf: string;
  tacticalBudgetPaise: bigint;
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
}

const days = (a: string, b: string): number => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
const min = (...xs: bigint[]): bigint => xs.reduce((m, x) => (x < m ? x : m));

function withId(c: Omit<Candidate, 'id' | 'policyVersion'>, asOf: string): Candidate {
  const key = JSON.stringify([c.action, c.instrumentId, String(c.amountPaise), c.units, asOf, SIZING_POLICY]);
  return { ...c, id: createHash('sha256').update(key).digest('hex').slice(0, 16), policyVersion: SIZING_POLICY };
}

export function sizeCandidates(input: SizingInput): Candidate[] {
  const out: Candidate[] = [];
  const holding = new Map(input.holdings.map((h) => [h.instrumentId, h]));
  const cap = (input.portfolioPaise * BigInt(Math.round(input.singleStockCapPct * 100))) / 10_000n;
  const cash = input.cashAvailablePaise === null ? null : input.cashAvailablePaise - input.reservedPaise;
  let budget = min(input.tacticalBudgetPaise, input.maxOrderPaise);
  let cashLeft = cash;

  const quoteFor = (id: string): { pricePaise: bigint; asOf: string } | string => {
    const q = input.quotes.get(id);
    if (!q) return 'no price on record';
    if (days(q.asOf, input.asOf) > QUOTE_MAX_AGE_DAYS) return `price is stale (last close ${q.asOf})`;
    return q;
  };

  for (const b of [...input.buys].sort((x, y) => y.score - x.score || x.instrumentId.localeCompare(y.instrumentId))) {
    const base = { action: 'BUY' as const, instrumentId: b.instrumentId, name: b.name, amountPaise: null, units: null, pricePaise: null, quoteAsOf: null, constraints: [] as string[] };
    const withhold = (reason: string, basis = '') => out.push(withId({ ...base, status: 'WITHHELD', withheldReason: reason, basis }, input.asOf));
    if (cashLeft === null) { withhold('cash available cannot be established'); continue; }
    if (budget <= 0n) { withhold('this month\'s tactical budget is already used by a higher-ranked candidate'); continue; }
    const held = holding.get(b.instrumentId)?.valuePaise ?? 0n;
    const headroom = cap - held;
    if (headroom <= 0n) { withhold(`already at the ${input.singleStockCapPct}% single-stock cap`); continue; }
    let amount = min(budget, cashLeft, headroom);
    if (amount <= 0n) { withhold('no free cash after the emergency fund and open requests'); continue; }
    const basis = `min(monthly tranche ₹${budget / 100n}, free cash ₹${cashLeft / 100n}, cap headroom ₹${headroom / 100n})`;

    let units: string | null = null; let price: bigint | null = null; let quoteAsOf: string | null = null;
    if (EXCHANGE_TRADED.has(b.kind)) {
      const q = quoteFor(b.instrumentId);
      if (typeof q === 'string') { withhold(q, basis); continue; }
      const n = amount / q.pricePaise;
      if (n === 0n) { withhold(`one share costs more than the ₹${amount / 100n} available`, basis); continue; }
      units = n.toString(); price = q.pricePaise; quoteAsOf = q.asOf; amount = n * q.pricePaise;
    }
    // One tranche a month (owner, 2026-09-27): the rounding remainder is not a second buy.
    budget = 0n; cashLeft -= amount;
    out.push(withId({ ...base, status: 'ELIGIBLE', withheldReason: null, amountPaise: amount, units, pricePaise: price, quoteAsOf, basis }, input.asOf));
  }

  for (const s of input.sells) {
    const h = holding.get(s.instrumentId);
    const base = { action: s.action, instrumentId: s.instrumentId, name: s.name, amountPaise: null, units: null, pricePaise: null, quoteAsOf: null,
      constraints: h && !h.costKnown ? ['tax on this sale cannot be estimated: cost basis unknown'] : [] };
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
