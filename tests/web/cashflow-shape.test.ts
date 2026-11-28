import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { rupees } from '../../src/money/paise.js';
import { db, getCashflow } from '../../web/lib/data.js';
import { avg3, dayLabel, hdfcHint, moneyOrUnknown, paydayDueText, surplusVsBudget } from '../../web/lib/cashflow.js';
import type { Cycle } from '../../src/domain/cashflow.js';
import { dataAgeNotices } from '../../web/lib/data-age.js';
import type { DataAge } from '../../src/domain/data-age.js';

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

  it('the /log hint dates the HDFC balance by its last change (the stale warning: dataAgeNotices)', () => {
    const age = { amountPaise: L(135_857), lastChangedOn: '2026-10-01', fetchedOn: '2026-11-12', daysUnchanged: 42, stale: true };
    expect(hdfcHint(age)).toMatch(/unchanged since 1-Oct: for reference only/);
    expect(hdfcHint({ ...age, daysUnchanged: 0 })).toMatch(/changed today/);
    expect(dayLabel('2026-11-27')).toBe('27-Nov');
  });
});

describe('INDmoney data age notices (#29, owner 2026-11-20)', () => {
  const age = (r: number, on: string, d: number, stale: boolean) => ({ amountPaise: L(r), lastChangedOn: on, fetchedOn: '2026-11-19', daysUnchanged: d, stale });
  const fresh: DataAge = { banks: [{ label: 'HDFC Bank', age: age(1, '2026-11-19', 1, false) }], epf: age(5, '2026-11-01', 19, false),
    sipUnits: [{ instrumentId: 'IND:3229', fundName: 'Parag Parikh Flexi Cap', instalmentOn: '2026-11-12', unitsBefore: '3000', unitsNow: '3096.27', stale: false }] };

  it('nothing fresh is shouted about', () => {
    expect(dataAgeNotices(fresh)).toEqual([]);
  });

  it('one line per stale bank and for EPF, naming the date and what to do', () => {
    const d: DataAge = { ...fresh, banks: [{ label: 'HDFC Bank', age: age(1_46_711, '2026-11-18', 2, true) }, { label: 'State Bank Of India', age: age(1_20_964, '2026-11-01', 19, true) }],
      epf: age(13_53_592, '2026-08-24', 88, true) };
    expect(dataAgeNotices(d)).toEqual([
      'HDFC Bank balance ₹1,46,711 is unchanged since 18-Nov (2 days). INDmoney refreshes it only when you open its app: open INDmoney and pull to refresh, and the next sync picks it up.',
      'State Bank Of India balance ₹1,20,964 is unchanged since 1-Nov (19 days). INDmoney refreshes it only when you open its app: open INDmoney and pull to refresh, and the next sync picks it up.',
      'EPF ₹13,53,592 is unchanged since 24-Aug (88 days). INDmoney updates EPF only when it is refreshed in its app: open EPF in INDmoney and refresh it.',
    ]);
  });

  it('SIP units not risen after an instalment: one line naming the funds', () => {
    const d: DataAge = { ...fresh, sipUnits: [
      { instrumentId: 'A', fundName: 'Navi Nifty 50', instalmentOn: '2026-12-12', unitsBefore: '1028.12', unitsNow: '1028.12', stale: true },
      { instrumentId: 'B', fundName: 'Bandhan Small Cap', instalmentOn: '2026-12-12', unitsBefore: '510.93', unitsNow: '510.93', stale: true }] };
    expect(dataAgeNotices(d)).toEqual([
      'SIP units not updated: Navi Nifty 50 (12-Dec instalment), Bandhan Small Cap (12-Dec instalment). The fund mix undercounts them until INDmoney picks the units up: open INDmoney and refresh.',
    ]);
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
