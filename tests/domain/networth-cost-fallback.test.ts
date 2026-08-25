import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadPositions } from '../../src/domain/networth.js';

/**
 * Owner-supplied cost basis lives in `lots` (durable across re-syncs — holdings are
 * replaced on every sync, so cost stored there would be wiped within a day). A
 * position whose source reports no cost must fall back to the newest OPEN lot for
 * the same (instrument_id, account); a closed lot is history and must be ignored.
 */
const SEED_DATE = '2026-08-24';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: SEED_DATE });
});

const gold = async () => {
  const positions = await loadPositions(db);
  return positions.find((p) => p.instrumentId === 'NSE:GOLDBEES' && p.account === 'zerodha')!;
};

describe('cost-basis fallback to owner-ingested lots', () => {
  it('fills a missing holding cost from the open owner lot', async () => {
    await insertLot({ instrument: 'NSE:GOLDBEES', account: 'zerodha', costPaise: 6_300_000n, acquiredOn: '2024-01-15' });
    expect((await gold()).avgCostPaise).toBe(6_300_000n);
  });

  it('keeps the source-reported cost when the holding carries one', async () => {
    // BOND:SAMMAAN-2026 is seeded WITH cost (owner-verified). A stray owner lot must
    // not override what the snapshot itself says.
    await insertLot({ instrument: 'BOND:SAMMAAN-2026', account: 'indmoney', costPaise: 9_999n, acquiredOn: '2024-01-01' });
    const positions = await loadPositions(db);
    const bond = positions.find((p) => p.instrumentId === 'BOND:SAMMAAN-2026')!;
    expect(bond.avgCostPaise).toBe(28_405_770n); // the seed's own verified figure
  });

  it('uses the NEWEST open lot and ignores closed ones regardless of age', async () => {
    // Migration 0006 forbids two OPEN owner lots per position — an older value must
    // be closed (superseded), which is exactly the history this test walks through.
    await insertLot({ instrument: 'NSE:GOLDBEES', account: 'zerodha', costPaise: 5_000_000n, acquiredOn: '2023-01-01', closedOn: '2024-06-01' }); // superseded
    await insertLot({ instrument: 'NSE:GOLDBEES', account: 'zerodha', costPaise: 6_300_000n, acquiredOn: '2024-06-01' }); // newest open
    await insertLot({ instrument: 'NSE:GOLDBEES', account: 'zerodha', costPaise: 9_999_999n, acquiredOn: '2025-01-01', closedOn: '2025-02-01' }); // closed
    expect((await gold()).avgCostPaise).toBe(6_300_000n);
  });

  it('leaves positions with neither source cost nor lots as NULL — never zero (FR-02)', async () => {
    expect((await gold()).avgCostPaise).toBeNull();
  });

  async function insertLot(o: { instrument: string; account: string; costPaise: bigint; acquiredOn: string; closedOn?: string }) {
    await db.query(
      `insert into lots (instrument_id, account, acquired_on, quantity, cost_paise, closed_on, seeded, as_of, source)
       values ($1, $2, $3::date, 1, $4, $5::date, true, '2026-08-25T10:00:00Z', 'owner-telegram')`,
      [o.instrument, o.account, o.acquiredOn, o.costPaise.toString(), o.closedOn ?? null],
    );
  }
});

describe('curated display names for canonical twins', () => {
  /** A live row carrying INDmoney's stale pre-rebrand name for the Sammaan 2026 bond. */
  async function insertLiveRow(o: { instrumentId: string; canonicalId?: string; name: string; valuePaise: bigint; kind: string; account: string }) {
    await db.query(
      `insert into instruments (id, kind, name, currency, canonical_id) values ($1,$2,$3,'INR',$4)
       on conflict (id) do update set canonical_id = excluded.canonical_id`,
      [o.instrumentId, o.kind, o.name, o.canonicalId ?? null],
    );
    const [snap] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source, taken_at) values ('2026-08-25','indmoney','2026-08-25T10:00:00Z') returning id`,
    );
    await db.query(
      `insert into holdings (snapshot_id, instrument_id, quantity, avg_cost_paise, value_paise, account, as_of, source)
       values ($1,$2,1,null,$3,$4,'2026-08-25T10:00:00Z','indmoney')`,
      [snap!.id, o.instrumentId, o.valuePaise.toString(), o.account],
    );
  }

  it('shows the curated seed name over a stale live name (bond rebrand trap)', async () => {
    await insertLiveRow({
      instrumentId: 'ISIN:INE148I07GL3', canonicalId: 'ISIN:INE148I07GL3',
      name: 'Indiabulls Housing Finance Ltd', valuePaise: 29_964_000n, kind: 'BOND', account: 'indmoney',
    });
    const positions = await loadPositions(db);
    const bond = positions.find((p) => p.instrumentId === 'ISIN:INE148I07GL3')!;
    expect(bond.name).toBe('Sammaan Capital 9% 26-Sep-2026'); // the seed's verified name
  });

  it('keeps live bank names — they carry detail the seed\u2019s generic label lacks', async () => {
    await insertLiveRow({
      instrumentId: 'IND:3004965_HDFC_Bank', canonicalId: 'CASH:SAVINGS_HDFC_FEDERAL',
      name: 'HDFC Bank (XX6652)', valuePaise: 16_333_611n, kind: 'CASH', account: 'bank',
    });
    const positions = await loadPositions(db);
    const bank = positions.find((p) => p.instrumentId === 'IND:3004965_HDFC_Bank')!;
    expect(bank.name).toBe('HDFC Bank (XX6652)');
  });

  it('leaves unmapped stocks with whatever the payload named them', async () => {
    await insertLiveRow({
      instrumentId: 'IND:SOMETHING-NEW', name: 'Some New Listing Ltd',
      valuePaise: 47_255_00n, kind: 'EQUITY', account: 'zerodha',
    });
    const positions = await loadPositions(db);
    expect(positions.find((p) => p.instrumentId === 'IND:SOMETHING-NEW')!.name)
      .toBe('Some New Listing Ltd');
  });

  async function insertLot(o: { instrument: string; account: string; costPaise: bigint; acquiredOn: string; closedOn?: string }) {
    await db.query(
      `insert into lots (instrument_id, account, acquired_on, quantity, cost_paise, closed_on, seeded, as_of, source)
       values ($1, $2, $3::date, 1, $4, $5::date, true, '2026-08-25T10:00:00Z', 'owner-telegram')`,
      [o.instrument, o.account, o.acquiredOn, o.costPaise.toString(), o.closedOn ?? null],
    );
  }
});
