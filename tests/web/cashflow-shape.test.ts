import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { rupees } from '../../src/money/paise.js';
import { db, getCashflow } from '../../web/lib/data.js';
import { avg3, dayLabel, hdfcHint, moneyOrUnknown, paydayDueText, staleBankText, surplusVsBudget } from '../../web/lib/cashflow.js';
import type { Cycle } from '../../src/domain/cashflow.js';

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

describe('budget against the real surplus on /advisor (open list #28, gap 2)', () => {
  const cyc = (surplus: number | null) => ({ surplusPaise: surplus === null ? null : L(surplus) }) as Cycle;
  const B = L(50_000); const S = L(49_804);

  it('waits for three known cycles, and says how many it has', () => {
    expect(avg3([cyc(60_000), cyc(70_000)], (c) => c.surplusPaise)).toBeNull();
    expect(surplusVsBudget([cyc(60_000), cyc(70_000)], B, S)).toBe('Your real surplus appears here once Cash flow has three known pay cycles (2 so far).');
    expect(surplusVsBudget([cyc(60_000), cyc(null), cyc(70_000)], B, S)).toBe('Your real surplus appears here once Cash flow has three known pay cycles (2 so far).');
  });

  it('averages the newest three, and names surplus left outside the budget', () => {
    const cycles = [cyc(80_000), cyc(70_000), cyc(60_000), cyc(1_000_000)];
    expect(avg3(cycles, (c) => c.surplusPaise)).toBe(L(70_000));
    expect(surplusVsBudget(cycles, B, S)).toBe(
      'Average surplus over the last 3 pay cycles: ₹70,000. Monthly budget: ₹50,000, of which SIPs ₹49,804. '
      + 'About ₹20,000 a month of surplus is outside the budget and stays in the bank. Changing the budget is your call, on Overview.');
  });

  it('says when the budget is more than the surplus, and never invents a budget', () => {
    expect(surplusVsBudget([cyc(40_000), cyc(40_000), cyc(40_000)], B, S)).toMatch(/The budget is ₹10,000 more than the average surplus\./);
    expect(surplusVsBudget([cyc(40_000), cyc(40_000), cyc(40_000)], null, null)).toMatch(/Monthly budget: unknown, of which SIPs unknown\.$/);
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
