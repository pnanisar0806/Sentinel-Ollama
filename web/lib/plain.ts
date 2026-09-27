import type { RecLeg } from '../../src/domain/recommendations.js';
import { rupees } from './format';

/**
 * Plain English for the owner. Ids like NSE:BAJAJ-AUTO or IND:INDS29570 are for the
 * machine; every sentence the owner reads names the instrument and says what to do.
 */

export type Names = Map<string, string>;

export function nameOf(id: string | null, names: Names): string {
  if (id === null) return 'the portfolio as a whole';
  return names.get(id) ?? id.replace(/^[A-Z]+:/, '');
}

const VERB: Record<string, string> = {
  BUY: 'Buy', TRIM: 'Sell part of', SELL: 'Sell all of', REDEEM: 'Redeem',
  HOLD: 'Do nothing with', REDIRECT: 'Send new money away from', PREPAY: 'Prepay',
};

/** "Buy ₹50,000 of Zerodha Gold ETF", "Sell part of CRISIL Ltd — about ₹29,711". */
export function sentence(leg: RecLeg, names: Names): string {
  if (leg.action === 'HOLD') {
    return leg.instrumentId === null ? 'Do nothing this month' : `Keep holding ${nameOf(leg.instrumentId, names)}`;
  }
  const what = nameOf(leg.instrumentId, names);
  const amount = leg.amountPaise === null ? null : rupees(String(leg.amountPaise));
  if (leg.action === 'BUY') return amount ? `Buy ${amount} of ${what}` : `Buy ${what} (amount not worked out yet)`;
  const verb = VERB[leg.action] ?? leg.action;
  return amount ? `${verb} ${what} — about ${amount}` : `${verb} ${what}`;
}

/** The kill condition, as a reason you would change your mind. */
export function killCondition(f: RecLeg['falsification'], names: Names, instrumentId: string | null): string | null {
  // "Do nothing" has no position to rethink.
  if (!f || instrumentId === null) return null;
  const c = f as { metric?: string; op?: string; value?: string | number };
  const below = c.op === 'lt';
  const what = nameOf(instrumentId, names);
  switch (c.metric) {
    case 'price_paise':
      return `Rethink if ${what}'s price ${below ? 'falls below' : 'rises above'} ${rupees(String(c.value))}.`;
    case 'roce_pct':
      return `Rethink if its return on capital ${below ? 'drops below' : 'rises above'} ${c.value}%.`;
    case 'de_ratio':
      return `Rethink if its debt-to-equity ${below ? 'drops below' : 'rises above'} ${c.value}.`;
    case 'red_flags':
      return 'Rethink if a governance red flag appears.';
    default:
      return `Rethink if ${c.metric} ${below ? '<' : '>'} ${c.value}.`;
  }
}

const KIND: Record<string, string> = {
  satellite: 'Stock idea', mf_switch: 'Fund switch', rebalance: 'Rebalance',
  sell: 'Exit', prepay: 'Loan prepayment', maturity_routing: 'Bond maturity', legacy_note: 'Note',
};
export const kindLabel = (k: string): string => KIND[k] ?? k;

/** Engine prose names instruments by id; swap each for its human name. */
export function humanize(text: string, names: Names): string {
  return text.replace(/\b(?:NSE|BSE|IND|MF|US|ISIN|BOND|EPF|CASH):[A-Za-z0-9_.&-]+/g, (id) => nameOf(id, names));
}
