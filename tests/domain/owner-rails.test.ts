import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { IPS_BANDS, allocationDrift } from '../../src/domain/allocation.js';
import { loadOwnerRails, evaluateRails, DEFAULT_OWNER_RAILS } from '../../src/domain/rails.js';
import { loadPositions, netWorth } from '../../src/domain/networth.js';
import { rupees, type Paise } from '../../src/money/paise.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

/**
 * Owner decision 2026-08-23. PRD 3.3 says "Debt/EPF/cash: remainder", so a 25% DEBT
 * floor was an invented rail — and a harmful one here: the owner's only CHOSEN debt is
 * bonds (Rs 6.16L, 12.9% of the portfolio, halving when Sammaan matures 26-Sep-2026).
 * EPF is 68.7% of the debt bucket and is passive, so a debt-percentage floor is really
 * an EPF floor, and it would have nagged him to buy debt he has decided against.
 */
describe('IPS_BANDS carries only rails the PRD states', () => {
  it('keeps the two PRD-verbatim rails', () => {
    expect(IPS_BANDS.EQUITY.max).toBe(0.60);
    expect(IPS_BANDS.GOLD.min).toBe(0.05);
    expect(IPS_BANDS.GOLD.max).toBe(0.10);
  });

  it('imposes no debt floor and no cash ceiling', () => {
    expect(IPS_BANDS.DEBT.min).toBe(0);
    expect(IPS_BANDS.CASH.max).toBe(1);
  });

  it('reports no IPS breach for debt even at the post-maturity level', async () => {
    // Sammaan redeems 26-Sep-2026: chosen debt roughly halves. Under the old 25% floor
    // this produced an "UNDER by Rs X" nudge to buy debt. It must not any more.
    const byClass = new Map<string, Paise>([
      ['EQUITY', rupees(3_500_000) as Paise],
      ['DEBT', rupees(616_000) as Paise],   // bonds + liquid only, no EPF
      ['CASH', rupees(490_000) as Paise],
      ['GOLD', rupees(63_000) as Paise],
    ]);
    const rows = allocationDrift(byClass as never);
    const debt = rows.find((r) => r.assetClass === 'DEBT')!;
    expect(debt.breach).toBeNull();
  });

  it('still reports the gold shortfall, which IS a PRD clause', async () => {
    const nw = netWorth(await loadPositions(db), 0n as Paise);
    const gold = allocationDrift(nw.byAssetClass).find((r) => r.assetClass === 'GOLD')!;
    expect(gold.breach).toBe('UNDER');
  });
});

/**
 * The cash ceiling survives as an OWNER rail: the owner's own rule, not an IPS clause,
 * reported separately and changeable only through the 48h cooling-off.
 */
describe('owner rails live in settings_rails, not in the IPS', () => {
  it('seeds the cash ceiling', async () => {
    const rails = await loadOwnerRails(db);
    expect(rails.find((r) => r.key === 'cash.ceiling')?.value).toBe(0.20);
  });

  it('ships a default the seed actually uses', () => {
    expect(DEFAULT_OWNER_RAILS['cash.ceiling']).toBe(0.20);
  });

  it('does not flag cash below the ceiling', async () => {
    const nw = netWorth(await loadPositions(db), 0n as Paise);
    const breaches = evaluateRails(await loadOwnerRails(db), nw.byAssetClass, nw.assetsPaise);
    expect(breaches).toEqual([]);
  });

  it('flags cash above the ceiling, naming it as an owner rail', async () => {
    const byClass = new Map<string, Paise>([
      ['CASH', rupees(1_500_000) as Paise],
      ['EQUITY', rupees(3_000_000) as Paise],
    ]);
    const breaches = evaluateRails(
      await loadOwnerRails(db), byClass as never, rupees(4_500_000) as Paise,
    );
    expect(breaches).toHaveLength(1);
    expect(breaches[0]!.key).toBe('cash.ceiling');
    expect(breaches[0]!.message).toMatch(/cash/i);
    expect(breaches[0]!.message).toMatch(/owner rail/i);
  });

  it('honours a changed rail rather than the hard-coded default', async () => {
    await db.query(
      `update settings_rails set value = '0.05'::jsonb where key = 'cash.ceiling'`,
    );
    const nw = netWorth(await loadPositions(db), 0n as Paise);
    // Seed cash is 3.42%, under 5%... so raise the bar to prove the value is read.
    await db.query(`update settings_rails set value = '0.01'::jsonb where key = 'cash.ceiling'`);
    const breaches = evaluateRails(await loadOwnerRails(db), nw.byAssetClass, nw.assetsPaise);
    expect(breaches.map((b) => b.key)).toEqual(['cash.ceiling']);
  });
});
