import { rupees } from './format';

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
};

export function validRailValue(key: string, value: unknown): value is number {
  return Object.hasOwn(RAIL_LABELS, key) && typeof value === 'number'
    && Number.isFinite(value) && value > 0
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
    if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
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
  return percentage;
}

export function formatRailValue(key: string, value: number): string {
  return key.endsWith('_paise') ? rupees(String(value)).replace(/\.00$/, '') : `${value}%`;
}

export function railInputValue(key: string, value: number): string {
  if (!key.endsWith('_paise')) return String(value);
  const amount = BigInt(value);
  return `${amount / 100n}.${(amount % 100n).toString().padStart(2, '0')}`;
}
