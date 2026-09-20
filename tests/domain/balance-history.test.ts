import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { persistBalanceSnapshot, loadBalanceDays } from '../../src/domain/balance-history.js';
import type { BalanceRow } from '../../src/sources/balances.js';
import { rupees } from '../../src/money/paise.js';

const row = (kind: BalanceRow['kind'], label: string, amount: string): BalanceRow =>
  ({ kind, label, amountPaise: rupees(amount) });

describe('balance history', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
  });

  it('is a no-op on a same-day re-run rather than a double count', async () => {
    const rows = [
      row('savings', 'HDFC Bank', '126471.72'),
      row('savings', 'State Bank Of India', '119877.03'),
      row('credit_card', 'REGALIA GOLD •• 2307', '43869'),
    ];

    expect(await persistBalanceSnapshot(db, '2026-09-20', rows, 'indmoney')).toBe(3);
    // balance_snapshots is append-only, so a duplicate could never be deleted afterwards.
    // The daily job will re-run on retries.
    expect(await persistBalanceSnapshot(db, '2026-09-20', rows, 'indmoney')).toBe(0);

    const [day] = await loadBalanceDays(db, '2026-01-01');
    expect(day?.savingsPaise).toBe(rupees('246348.75'));
    await db.close();
  });

  it('sums every savings account into one day, so a transfer nets to zero', async () => {
    // Day 1: 126,471.72 + 119,877.03. Day 2: 1L moved HDFC -> SBI for the LIC premium.
    // The housing EMI debits from SBI, so SBI is not idle and cannot be excluded.
    await persistBalanceSnapshot(db, '2026-09-20', [
      row('savings', 'HDFC Bank', '126471.72'),
      row('savings', 'State Bank Of India', '119877.03'),
    ], 'indmoney');
    await persistBalanceSnapshot(db, '2026-09-21', [
      row('savings', 'HDFC Bank', '26471.72'),
      row('savings', 'State Bank Of India', '219877.03'),
    ], 'indmoney');

    const days = await loadBalanceDays(db, '2026-01-01');
    expect(days).toHaveLength(2);
    // Watching HDFC alone would read this as ₹1L of spending. Summed, it is zero.
    expect(days[1]!.savingsPaise - days[0]!.savingsPaise).toBe(0n);
    await db.close();
  });

  it('keeps the four kinds apart and orders days oldest first', async () => {
    await persistBalanceSnapshot(db, '2026-09-21', [row('loan', 'SBI HOUSING LOAN #1', '2889877')], 'indmoney');
    await persistBalanceSnapshot(db, '2026-09-20', [
      row('savings', 'HDFC Bank', '100'),
      row('invested_cost', 'MF', '1090815.35'),
      row('credit_card', 'YES_BANK_Klick •• 4282', '43242.57'),
      row('loan', 'SBI HOUSING LOAN #1', '2890000'),
    ], 'indmoney');

    const days = await loadBalanceDays(db, '2026-01-01');
    expect(days.map((d) => d.asOf)).toEqual(['2026-09-20', '2026-09-21']);
    expect(days[0]!.investedCostPaise).toBe(rupees('1090815.35'));
    expect(days[0]!.cardOutstandingPaise).toBe(rupees('43242.57'));
    expect(days[0]!.loanBalancePaise).toBe(rupees('2890000'));
    // A kind absent on a day reads zero, not the previous day's figure — carrying it
    // forward would invent a balance that was never observed.
    expect(days[1]!.savingsPaise).toBe(0n);
    await db.close();
  });

  it('refuses to let a recorded day be rewritten', async () => {
    await persistBalanceSnapshot(db, '2026-09-20', [row('savings', 'HDFC Bank', '100')], 'indmoney');
    await expect(
      db.query("update balance_snapshots set amount_paise = 1 where kind = 'savings'"),
    ).rejects.toThrow();
    await db.close();
  });
});
