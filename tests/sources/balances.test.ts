import { describe, expect, it } from 'vitest';
import { parseBalanceSnapshot } from '../../src/sources/balances.js';
import { rupees } from '../../src/money/paise.js';

/**
 * Fixture trimmed from a real `networth_snapshot` capture on 2026-09-20 — same shape,
 * same figures, per the fixture-honesty rule. Two SBI housing loans are kept because
 * they are what proves the lender alone is not a unique label.
 */
const REAL = {
  investments: [
    { asset_type: 'EPF', invested_value: 1353592.0, current_value: 1353592.0 },
    { asset_type: 'MF', invested_value: 1090815.35, current_value: 1196695.23 },
    { asset_type: 'STOCK', invested_value: 791280.11, current_value: 791280.11 },
    { asset_type: 'BOND', invested_value: 620000.0, current_value: 632999.0 },
    { asset_type: 'SA', invested_value: 246348.75, current_value: 246348.75 },
    { asset_type: 'US_STOCK', invested_value: 61839.12, current_value: 139763.68 },
    { asset_type: 'US_STOCK_WALLET', invested_value: 1389.25, current_value: 1389.25 },
    { asset_type: 'CRYPTO', invested_value: 0.0, current_value: 0.0 },
  ],
  liabilities: {
    credit_cards: [
      { name: 'REGALIA GOLD •• 2307', total_due: 43869 },
      { name: 'YES_BANK_Klick •• 4282', total_due: 43242.57 },
      { name: 'BPCL SBI Card OCTANE •• xx99', total_due: 9001 },
      { name: 'ICICI Amazon Pay •• 5006', total_due: 7213 },
      { name: 'UPI RuPay •• 6631', total_due: 0 },
      { name: 'IndusInd Bank •• 7953', total_due: 0 },
    ],
    loans: [
      { lender: 'State Bank of India', loan_type: 'HOUSING LOAN', current_balance: 2889877 },
      { lender: 'Bank Of Baroda', loan_type: 'AUTO LOAN', current_balance: 482172 },
      { lender: 'HDFC Bank Ltd', loan_type: 'AUTO LOAN', current_balance: 246582 },
      { lender: 'State Bank of India', loan_type: 'HOUSING LOAN', current_balance: 53810 },
      { lender: 'IDFC FIRST BANK LIMITED', loan_type: 'CONSUMER LOAN', current_balance: 0 },
    ],
  },
};

const find = (rows: ReturnType<typeof parseBalanceSnapshot>, kind: string, label: string) =>
  rows.find((r) => r.kind === kind && r.label === label);

describe('parseBalanceSnapshot', () => {
  it('records savings as savings, not as invested cost', () => {
    const rows = parseBalanceSnapshot(REAL);
    expect(find(rows, 'savings', 'SA')?.amountPaise).toBe(rupees('246348.75'));
    // Counting the cash balance as deployed capital would inflate realised surplus by
    // the entire balance every single month.
    expect(find(rows, 'invested_cost', 'SA')).toBeUndefined();
  });

  it('takes invested COST, never current value', () => {
    const rows = parseBalanceSnapshot(REAL);
    // US_STOCK is the decisive row: cost 61,839.12 against a market value of 139,763.68.
    // Reading current_value would book a 126% rally as if it were money saved.
    expect(find(rows, 'invested_cost', 'US_STOCK')?.amountPaise).toBe(rupees('61839.12'));
    expect(find(rows, 'invested_cost', 'MF')?.amountPaise).toBe(rupees('1090815.35'));
  });

  it('gives two same-lender loans distinct labels', () => {
    const loans = parseBalanceSnapshot(REAL).filter((r) => r.kind === 'loan');
    expect(loans).toHaveLength(5);

    // The label is the snapshot table's uniqueness key within a day. Both SBI rows are
    // HOUSING LOAN, so an undisambiguated label would silently drop one through
    // `on conflict do nothing` — unrecoverable in an append-only table.
    const labels = loans.map((l) => l.label);
    expect(new Set(labels).size, `labels collide: ${labels.join(', ')}`).toBe(loans.length);

    // Ranked by balance, so the pair is stable run to run.
    expect(labels).toContain('State Bank of India HOUSING LOAN #1');
    expect(labels).toContain('State Bank of India HOUSING LOAN #2');
    const first = loans.find((l) => l.label === 'State Bank of India HOUSING LOAN #1');
    expect(first?.amountPaise).toBe(rupees('2889877'));

    // A lender with only one loan keeps a clean, unsuffixed label.
    expect(labels).toContain('Bank Of Baroda AUTO LOAN');
  });

  it('records card dues as positive amounts owed, including zeros', () => {
    const cards = parseBalanceSnapshot(REAL).filter((r) => r.kind === 'credit_card');
    expect(cards).toHaveLength(6);
    expect(find(cards, 'credit_card', 'YES_BANK_Klick •• 4282')?.amountPaise).toBe(rupees('43242.57'));
    // A paid-off card at zero must still be recorded: a missing row and a zero row differ,
    // and the delta needs the zero to see the balance fall.
    expect(find(cards, 'credit_card', 'UPI RuPay •• 6631')?.amountPaise).toBe(0n);
    for (const c of cards) expect(c.amountPaise >= 0n).toBe(true);
  });

  it('converts rupee floats without float drift', () => {
    const rows = parseBalanceSnapshot(REAL);
    // 43242.57 * 100 is 4324256.9999999995 in IEEE754; the fixed-2 string path avoids it.
    expect(find(rows, 'credit_card', 'YES_BANK_Klick •• 4282')?.amountPaise).toBe(4324257n);
  });

  it('refuses an error body instead of recording a day of zeros', () => {
    expect(() => parseBalanceSnapshot({ error: 'RATE_LIMIT', message: 'slow down' }))
      .toThrow(/refused networth_snapshot/);
  });

  it('refuses a payload with no investments array', () => {
    expect(() => parseBalanceSnapshot({})).toThrow(/no investments array/);
  });

  it('refuses a snapshot that yields nothing at all', () => {
    expect(() => parseBalanceSnapshot({ investments: [], liabilities: {} }))
      .toThrow(/no balances at all/);
  });
});
