import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { rupees } from '../../src/money/paise.js';
import { db, getCashflow } from '../../web/lib/data.js';
import { dayLabel, hdfcHint, moneyOrUnknown, paydayDueText, staleBankText } from '../../web/lib/cashflow.js';

const L = (n: number) => BigInt(rupees(n));

describe('/cashflow display helpers', () => {
  it('an unknown amount reads "unknown", never ₹0', () => {
    expect(moneyOrUnknown(null)).toBe('unknown');
    expect(moneyOrUnknown(0n)).toContain('0');
  });

  it('asks for a payday only when one is due', () => {
    expect(paydayDueText({ due: false, month: '2026-11', from: '2026-11-27', lastOn: null })).toBeNull();
    expect(paydayDueText({ due: true, month: '2026-11', from: '2026-11-27', lastOn: '2026-10-29' }))
      .toBe('Payday for Nov 2026: enter the salary credited and the HDFC balance right after it. Last entry: 29-Oct.');
  });

  it('warns about the HDFC balance only when stale, and dates it by its last change', () => {
    const age = { amountPaise: L(135_857), lastChangedOn: '2026-10-01', fetchedOn: '2026-11-12', daysUnchanged: 42, stale: true };
    expect(staleBankText({ ...age, stale: false })).toBeNull();
    expect(staleBankText(null)).toBeNull();
    expect(staleBankText(age)).toMatch(/unchanged since 1-Oct \(42 days\)/);
    expect(hdfcHint(age)).toMatch(/unchanged since 1-Oct: for reference only/);
    expect(hdfcHint({ ...age, daysUnchanged: 0 })).toMatch(/changed today/);
    expect(dayLabel('2026-11-27')).toBe('27-Nov');
  });
});

describe('/cashflow getter', () => {
  beforeAll(async () => { await runMigrations(await db()); });

  it('with no payday entered: no cycles, nothing invented', async () => {
    const c = await getCashflow();
    expect(c.cycles).toEqual([]);
    expect(c.paydays).toEqual([]);
    expect(c.hdfc).toBeNull();
    expect(c.due.month).toMatch(/^\d{4}-\d{2}$/);
  });
});
