import { rupees } from './format';
import { validGoalCeilingPct } from '../../src/domain/rail-values.js';

export const RAIL_LABELS: Record<string, string> = {
  monthly_budget_paise: 'Monthly investment budget',
  tactical_monthly_paise: 'Tactical monthly cap',
  max_order_paise: 'Maximum per order',
  cash_ceiling_pct: 'Cash ceiling',
  single_stock_cap_pct: 'Single stock cap',
  employer_cap_pct: 'Employer stock cap',
  mf_scheme_cap_pct: 'Mutual fund scheme cap',
  sector_cap_pct: 'Sector cap',
  issuer_cap_pct: 'Issuer cap',
  goal_equity_ceiling_pct: 'Goal equity ceiling (the rebalance dilutes equity only above this; raising it never triggers a sale)',
  goal_setaside_monthly_paise: 'Goal set-aside (house + emergency) per month',
};

/** Success messages use a short label; the long description stays on the form. */
const SHORT_LABELS: Record<string, string> = { goal_equity_ceiling_pct: 'Goal equity ceiling' };
export const railShortLabel = (key: string) => SHORT_LABELS[key] ?? RAIL_LABELS[key] ?? key;

const GOAL_CEILING = 'goal_equity_ceiling_pct';
/** The one rail that may be 0: ending the set-aside. */
const SET_ASIDE = 'goal_setaside_monthly_paise';

export function validRailValue(key: string, value: unknown): value is number {
  if (key === GOAL_CEILING) return validGoalCeilingPct(value);
  return Object.hasOwn(RAIL_LABELS, key) && typeof value === 'number'
    && Number.isFinite(value) && (key === SET_ASIDE ? value >= 0 : value > 0)
    && (key.endsWith('_paise') ? Number.isSafeInteger(value) : value <= 100);
}

export function parseRailInput(key: string, input: string): number {
  if (!Object.hasOwn(RAIL_LABELS, key)) throw new Error('Unknown investment limit.');
  const value = input.trim();
  if (key.endsWith('_paise')) {
    // Grouping commas, spaces and ₹ are display only; what remains must be plain digits.
    const money = value.replace(/[,\s₹]/g, '');
    if (!/^\d+(?:\.\d{1,2})?$/.test(money)) {
      throw new Error('Enter a rupee amount, with at most two decimal places.');
    }
    const [whole, fraction = ''] = money.split('.');
    const amount = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
    if ((key === SET_ASIDE ? amount < 0n : amount <= 0n) || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Enter a positive amount within the supported range.');
    }
    // The existing rail API stores numbers; only exact integer paise cross that boundary.
    return Number(amount);
  }
  if (!/^\d+(?:\.\d+)?$/.test(value)) throw new Error('Enter a percentage greater than 0 and at most 100.');
  const percentage = Number(value);
  if (!Number.isFinite(percentage) || percentage <= 0 || percentage > 100) {
    throw new Error('Enter a percentage greater than 0 and at most 100.');
  }
  if (key === GOAL_CEILING && !validGoalCeilingPct(percentage)) {
    throw new Error('Enter a whole percentage from 60 to 92.');
  }
  return percentage;
}

export function formatRailValue(key: string, value: number): string {
  return key.endsWith('_paise') ? rupees(String(value)).replace(/\.00$/, '') : `${value}%`;
}

/** The success text for a scheduled rail change: its label, the value as shown, the IST time. */
export function railChangeMessage(key: string, value: number, activatesAtIst: string, loosening: boolean): string {
  return `${railShortLabel(key)} → ${formatRailValue(key, value)} takes effect ${activatesAtIst}`
    + (loosening ? ' (a loosening: drawdown is checked again then)' : '');
}

export function railInputValue(key: string, value: number): string {
  if (!key.endsWith('_paise')) return String(value);
  const amount = BigInt(value);
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}
