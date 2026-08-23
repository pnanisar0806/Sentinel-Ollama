import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { writeSnapshot, type SourceRow } from '../../src/sources/types.js';
import { rupees } from '../../src/money/paise.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

const row = (id: string, value: number, name = `Name of ${id}`): SourceRow => ({
  instrumentId: id,
  account: 'indmoney',
  quantity: 1,
  valuePaise: rupees(value),
  avgCostPaise: null,
  instrument: { id, kind: 'BOND', name, currency: 'INR' },
});

describe('writeSnapshot is atomic', () => {
  /**
   * The delete precedes the writes and ran unwrapped, on an unattended daily job
   * against the primary holdings table. A failure mid-way left the source's
   * holdings partially or entirely deleted with a fresh as_of, so staleness
   * reported the source healthy and the next digest rendered the loss as fact.
   */
  it('leaves the previous holdings intact when a later insert fails', async () => {
    const good = [row('BOND:A', 1000), row('BOND:B', 2000)];
    await writeSnapshot(db, 'indmoney', '2026-08-12', good, '2026-08-12T00:00:00Z');

    const before = await db.query<{ instrument_id: string; value_paise: string }>(
      'select instrument_id, value_paise from holdings order by instrument_id',
    );
    expect(before).toHaveLength(2);

    // Fail on the second holdings insert of the replacement write. The failure has
    // to land on the connection INSIDE the transaction, so wrap the tx too.
    let holdingInserts = 0;
    const breakOn = (inner: Db): Db => ({
      ...inner,
      query: async (sql: string, params?: unknown[]) => {
        if (/insert into holdings/i.test(sql) && ++holdingInserts === 2) {
          throw new Error('connection reset mid-write');
        }
        return inner.query(sql, params);
      },
      withTransaction: (fn) => inner.withTransaction((tx) => fn(breakOn(tx))),
    });
    const flaky = breakOn(db);

    await expect(
      writeSnapshot(flaky, 'indmoney', '2026-08-12', [row('BOND:A', 9999), row('BOND:B', 8888)],
        '2026-08-13T00:00:00Z'),
    ).rejects.toThrow(/connection reset/);

    const after = await db.query<{ instrument_id: string; value_paise: string }>(
      'select instrument_id, value_paise from holdings order by instrument_id',
    );
    expect(after).toEqual(before);
  });

  it('refuses a duplicate (business_date, source) snapshot at the schema level', async () => {
    await writeSnapshot(db, 'indmoney', '2026-08-12', [row('BOND:A', 1000)], '2026-08-12T00:00:00Z');
    // select-then-insert is check-then-act without this constraint.
    await expect(
      db.query("insert into snapshots (business_date, source) values ('2026-08-12','indmoney')"),
    ).rejects.toThrow();
  });
});

describe('writeSnapshot does not corrupt curated instrument rows', () => {
  it('writes isin so the single-issuer cap has something to map from', async () => {
    const r = row('BOND:SAMMAAN-2026', 1000);
    r.instrument.isin = 'INE148I07GL3';
    await writeSnapshot(db, 'indmoney', '2026-08-12', [r], '2026-08-12T00:00:00Z');

    const [inst] = await db.query<{ isin: string | null }>(
      'select isin from instruments where id = $1', ['BOND:SAMMAAN-2026'],
    );
    expect(inst?.isin).toBe('INE148I07GL3');
  });

  it('keeps the curated name and fills only the fields the seed left null', async () => {
    await db.query(
      `insert into instruments (id, kind, name, currency, sector, issuer)
       values ('BOND:SAMMAAN-2026','BOND','Sammaan Capital Limited','INR', null, 'Sammaan Capital')`,
    );

    const r = row('BOND:SAMMAAN-2026', 1000, 'Indiabulls Housing Finance Ltd'); // stale API name
    r.instrument.sector = 'Financials';
    r.instrument.issuer = 'Indiabulls Housing Finance Ltd';
    await writeSnapshot(db, 'indmoney', '2026-08-12', [r], '2026-08-12T00:00:00Z');

    const [inst] = await db.query<{ name: string; sector: string | null; issuer: string }>(
      'select name, sector, issuer from instruments where id = $1', ['BOND:SAMMAAN-2026'],
    );
    // MEMORY records the payload as the unreliable side for names and issuers.
    expect(inst?.name).toBe('Sammaan Capital Limited');
    expect(inst?.issuer).toBe('Sammaan Capital');
    // ...but a null the seed never filled is worth enriching.
    expect(inst?.sector).toBe('Financials');
  });
});
