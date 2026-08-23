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

/**
 * One snapshot per (source, business date). Re-running a sync replaces its rows.
 *
 * The whole write runs in ONE transaction. The holdings delete precedes the
 * inserts, so an unwrapped failure mid-way left the source's holdings partially
 * or entirely gone with a fresh `as_of` — staleness then reported the source
 * healthy and the next digest rendered the loss as fact. This is an unattended
 * daily job against the primary holdings table; it must be all-or-nothing.
 */
export async function writeSnapshot(
  db: Db,
  source: string,
  businessDate: string,
  rows: SourceRow[],
  asOf: string,
): Promise<string> {
  return db.withTransaction(async (tx) => {
    for (const r of rows) {
      const i = r.instrument;
      // A curated row wins on conflict: MEMORY records the payload as the
      // unreliable side for names and issuers (it still returns the pre-rebrand
      // "Indiabulls Housing Finance Ltd" for a Sammaan bond). Only fields the
      // curated row left NULL are enriched from the source — `isin` above all,
      // which was omitted from the column list entirely, leaving every synced
      // instrument unmappable by the PRD 3.5 single-issuer cap.
      await tx.query(
        `insert into instruments (id, kind, name, currency, isin, sector, issuer, is_employer)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (id) do update set
           isin   = coalesce(instruments.isin,   excluded.isin),
           sector = coalesce(instruments.sector, excluded.sector),
           issuer = coalesce(instruments.issuer, excluded.issuer)`,
        [i.id, i.kind, i.name, i.currency, i.isin ?? null,
         i.sector ?? null, i.issuer ?? null, i.isEmployer ?? false],
      );
    }

    // `snapshots` is append-only (UPDATE and DELETE are refused by trigger), so
    // this is `do nothing` + select rather than `do update ... returning`. The
    // unique constraint in 0003 is what makes it safe against a concurrent sync.
    const inserted = await tx.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ($1,$2)
       on conflict (business_date, source) do nothing
       returning id`,
      [businessDate, source],
    );
    let snapshotId = inserted[0]?.id;
    if (!snapshotId) {
      const [existing] = await tx.query<{ id: string }>(
        'select id from snapshots where business_date = $1 and source = $2',
        [businessDate, source],
      );
      snapshotId = existing!.id;
      await tx.query('delete from holdings where snapshot_id = $1', [snapshotId]);
    }

    for (const r of rows) {
      await tx.query(
        `insert into holdings
           (snapshot_id, instrument_id, quantity, avg_cost_paise, value_paise, account, as_of, source)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [snapshotId, r.instrumentId, r.quantity,
         r.avgCostPaise === null ? null : r.avgCostPaise.toString(),
         r.valuePaise.toString(), r.account, asOf, source],
      );
    }

    await tx.query(
      `insert into audit_log (entity, entity_id, action, actor, payload)
       values ('snapshot', $1, 'SYNCED', 'agent', $2::jsonb)`,
      [snapshotId, JSON.stringify({ source, businessDate, rows: rows.length })],
    );

    return snapshotId;
  });
}