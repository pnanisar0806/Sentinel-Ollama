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
    await insertLot({ instrument: 'NSE:GOLDBEES', account: 'zerodha', costPaise: 5_000_000n, acquiredOn: '2023-01-01' });
    await insertLot({ instrument: 'NSE:GOLDBEES', account: 'zerodha', costPaise: 6_300_000n, acquiredOn: '2024-06-01' }); // newer open
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
