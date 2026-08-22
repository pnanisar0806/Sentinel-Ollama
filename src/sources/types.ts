import type { Db } from '../db/client.js';
import type { Paise } from '../money/paise.js';
import type { Account, InstrumentSeed } from '../seed/seed-data.js';

export interface SourceRow {
  instrumentId: string;
  account: Account;
  quantity: number;
  valuePaise: Paise;
  /** null = the source does not know the cost basis (FR-02). Never 0. */
  avgCostPaise: Paise | null;
  instrument: InstrumentSeed;
}

export interface Source {
  readonly name: string;
  fetch(): Promise<{ rows: SourceRow[]; asOf: string }>;
}

/** One snapshot per (source, business date). Re-running a sync replaces its rows. */
export async function writeSnapshot(
  db: Db,
  source: string,
  businessDate: string,
  rows: SourceRow[],
  asOf: string,
): Promise<string> {
  for (const r of rows) {
    const i = r.instrument;
    await db.query(
      `insert into instruments (id, kind, name, currency, sector, issuer, is_employer)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set name = excluded.name`,
      [i.id, i.kind, i.name, i.currency, i.sector ?? null, i.issuer ?? null, i.isEmployer ?? false],
    );
  }

  const existing = await db.query<{ id: string }>(
    'select id from snapshots where business_date = $1 and source = $2',
    [businessDate, source],
  );
  let snapshotId = existing[0]?.id;
  if (snapshotId) {
    await db.query('delete from holdings where snapshot_id = $1', [snapshotId]);
  } else {
    const [row] = await db.query<{ id: string }>(
      'insert into snapshots (business_date, source) values ($1,$2) returning id',
      [businessDate, source],
    );
    snapshotId = row!.id;
  }

  for (const r of rows) {
    await db.query(
      `insert into holdings
         (snapshot_id, instrument_id, quantity, avg_cost_paise, value_paise, account, as_of, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [snapshotId, r.instrumentId, r.quantity,
       r.avgCostPaise === null ? null : r.avgCostPaise.toString(),
       r.valuePaise.toString(), r.account, asOf, source],
    );
  }

  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('snapshot', $1, 'SYNCED', 'agent', $2::jsonb)`,
    [snapshotId, JSON.stringify({ source, businessDate, rows: rows.length })],
  );

  return snapshotId;
}