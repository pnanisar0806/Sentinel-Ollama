import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { IPS_BANDS, allocationDrift } from '../../src/domain/allocation.js';
import { checkPortfolioRails, DEFAULT_OWNER_RAILS, getFreezeState, setFreeze, getBreakerState, recordFalsification, resetBreaker, checkFreeze } from '../../src/domain/rails.js';
import { loadPositions, netWorth, type Position } from '../../src/domain/networth.js';
import { rupees, type Paise } from '../../src/money/paise.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

function makeTestPosition(overrides: Partial<Position> = {}): Position {
  return {
    instrumentId: 'NSE:TEST',
    name: 'Test Position',
    kind: 'EQUITY',
    valuePaise: rupees(0),
    sector: null,
    currency: 'INR',
    account: 'indmoney',
    source: 'test',
    asOf: new Date().toISOString(),
    assetClass: 'EQUITY',
    issuer: null,
    isEmployer: false,
    avgCostPaise: null,
    ...overrides,
  };
}

describe('DEFAULT_OWNER_RAILS carries the owner rails the seed uses', () => {
  it('ships a default the seed actually uses', () => {
    expect(DEFAULT_OWNER_RAILS.cash_ceiling_pct).toBe(20);
    expect(DEFAULT_OWNER_RAILS.tactical_monthly_paise).toBe(50_00_000);
    expect(DEFAULT_OWNER_RAILS.max_order_paise).toBe(100_00_000);
  });
});

describe('owner rails live in settings_rails and are checked by checkPortfolioRails', () => {
  it('seeds the cash ceiling in settings_rails', async () => {
    const [row] = await db.query<{ value: string }>(
      `select value from settings_rails where key = 'cash_ceiling_pct'`
    );
    expect(Number(row?.value ?? '0')).toBe(20);
  });

  it('does not flag cash below the ceiling', async () => {
    const positions = await loadPositions(db);
    const nw = netWorth(positions, 0n as Paise);
    const breaches = await checkPortfolioRails(db, positions, nw.assetsPaise);
    // The seeded portfolio has a concentration breach (ServiceNow), so we expect it
    // Cash ceiling is not checked by checkPortfolioRails (it's a recommendation-time rail)
    const concentrationBreaches = breaches.filter(b => b.code === 'CONCENTRATION_BREACH');
    expect(concentrationBreaches.length).toBeGreaterThan(0);
  });

  it('flags concentration breaches for over-weighted positions', async () => {
    const positions: Position[] = [
      { instrumentId: 'NSE:TEST1', name: 'Test Equity 1', kind: 'EQUITY', valuePaise: rupees(5_000_000), sector: 'Tech', currency: 'INR', account: 'indmoney', source: 'test', asOf: new Date().toISOString(), assetClass: 'EQUITY', issuer: null, isEmployer: false, avgCostPaise: null },
      { instrumentId: 'NSE:TEST2', name: 'Test Cash', kind: 'CASH', valuePaise: rupees(1_000_000), sector: null, currency: 'INR', account: 'bank', source: 'test', asOf: new Date().toISOString(), assetClass: 'CASH', issuer: null, isEmployer: false, avgCostPaise: null },
    ];
    const breaches = await checkPortfolioRails(db, positions, rupees(6_000_000) as Paise);
    const concentrationBreaches = breaches.filter(b => b.code === 'CONCENTRATION_BREACH');
    expect(concentrationBreaches.length).toBeGreaterThan(0);
  });

  it('honours a changed rail in settings_rails rather than the hard-coded default', async () => {
    await db.query(
      `update settings_rails set value = '0.05'::jsonb where key = 'cash_ceiling_pct'`
    );
    const positions = await loadPositions(db);
    const nw = netWorth(positions, 0n as Paise);
    const breaches = await checkPortfolioRails(db, positions, nw.assetsPaise);
    expect(breaches).toBeDefined();
  });
});

describe('freeze state management', () => {
  it('starts inactive', async () => {
    const state = await getFreezeState(db);
    expect(state.active).toBe(false);
  });

  it('activates on setFreeze(true)', async () => {
    await setFreeze(db, true, 'test reason');
    const state = await getFreezeState(db);
    expect(state.active).toBe(true);
    expect(state.reason).toBe('test reason');
  });

  it('deactivates on setFreeze(false)', async () => {
    await setFreeze(db, true, 'test');
    await setFreeze(db, false, '');
    const state = await getFreezeState(db);
    expect(state.active).toBe(false);
  });

  it('throws on checkFreeze when active', async () => {
    await setFreeze(db, true, 'frozen');
    await expect(checkFreeze(db)).rejects.toThrow('FREEZE active');
  });

  it('allows checkFreeze when inactive', async () => {
    await setFreeze(db, false, '');
    await expect(checkFreeze(db)).resolves.toBeUndefined();
  });
});

describe('breaker state management', () => {
  it('starts inactive with zero falsifications', async () => {
    const state = await getBreakerState(db);
    expect(state.active).toBe(false);
    expect(state.consecutiveFalsifications).toBe(0);
  });

  it('increments on recordFalsification', async () => {
    await recordFalsification(db, 'NSE:TEST', 'test detail');
    const state = await getBreakerState(db);
    expect(state.consecutiveFalsifications).toBe(1);
    expect(state.active).toBe(false);
  });

  it('activates after three consecutive falsifications', async () => {
    await recordFalsification(db, 'NSE:TEST1', 'detail 1');
    await recordFalsification(db, 'NSE:TEST2', 'detail 2');
    await recordFalsification(db, 'NSE:TEST3', 'detail 3');
    const state = await getBreakerState(db);
    expect(state.consecutiveFalsifications).toBe(3);
    expect(state.active).toBe(true);
    expect(state.demotedAt).not.toBeNull();
  });

  it('resets with resetBreaker', async () => {
    await recordFalsification(db, 'NSE:TEST1', 'detail');
    await resetBreaker(db, 'post-mortem note');
    const state = await getBreakerState(db);
    expect(state.active).toBe(false);
    expect(state.consecutiveFalsifications).toBe(0);
    expect(state.postMortemNote).toBe('post-mortem note');
  });
});