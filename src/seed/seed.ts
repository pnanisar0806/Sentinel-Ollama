import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import {
  SEED_BUCKETS, SEED_HOLDINGS, SEED_INSTRUMENTS, SEED_LOANS,
  SEED_MILESTONES, SEED_RSU_GRANTS,
} from './seed-data.js';
import { isMainModule } from '../util/main-module.js';
import { DEFAULT_OWNER_RAILS } from '../domain/rails.js';

const SOURCE = 'manual-seed';

/**
 * Idempotent: the manual seed owns exactly one snapshot per business date.
 * snapshots is append-only, so re-seeding clears that snapshot's holdings
 * (holdings is not append-only) and reuses the snapshot row.
 */
export async function seed(db: Db, opts: { asOf?: string } = {}): Promise<{ snapshotId: string }> {
  const businessDate = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const asOf = `${businessDate}T00:00:00+05:30`;

  for (const i of SEED_INSTRUMENTS) {
    await db.query(
      `insert into instruments (id, kind, name, currency, isin, sector, issuer, is_employer, canonical_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (id) do update set name = excluded.name, isin = excluded.isin,
         sector = excluded.sector, issuer = excluded.issuer,
         is_employer = excluded.is_employer, canonical_id = excluded.canonical_id`,
      [i.id, i.kind, i.name, i.currency, i.isin ?? null, i.sector ?? null, i.issuer ?? null,
       i.isEmployer ?? false, i.canonicalId ?? null],
    );
  }

  const existing = await db.query<{ id: string }>(
    `select id from snapshots where business_date = $1 and source = $2`,
    [businessDate, SOURCE],
  );
  let snapshotId = existing[0]?.id;
  if (snapshotId) {
    await db.query('delete from holdings where snapshot_id = $1', [snapshotId]);
  } else {
    const [row] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ($1,$2) returning id`,
      [businessDate, SOURCE],
    );
    snapshotId = row!.id;
  }

  for (const h of SEED_HOLDINGS) {
    await db.query(
      `insert into holdings
         (snapshot_id, instrument_id, quantity, avg_cost_paise, value_paise, account, as_of, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [snapshotId, h.instrumentId, h.quantity,
       h.avgCostPaise === null ? null : h.avgCostPaise.toString(),
       h.valuePaise.toString(), h.account, asOf, SOURCE],
    );
  }

  for (const l of SEED_LOANS) {
    await db.query(
      `insert into loans (id, name, lender, principal_paise, outstanding_paise, annual_rate_bps,
                          emi_paise, started_on, natural_end_on, cascade_order, as_of, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (id) do update set outstanding_paise = excluded.outstanding_paise,
         emi_paise = excluded.emi_paise, as_of = excluded.as_of`,
      [l.id, l.name, l.lender, l.principalPaise.toString(), l.outstandingPaise.toString(),
       l.annualRateBps, l.emiPaise.toString(), l.startedOn, l.naturalEndOn, l.cascadeOrder,
       asOf, SOURCE],
    );
  }

  for (const b of SEED_BUCKETS) {
    await db.query(
      `insert into buckets (id, name, mandate, target_paise, target_note)
       values ($1,$2,$3,$4,$5)
       on conflict (id) do update set mandate = excluded.mandate,
         target_paise = excluded.target_paise, target_note = excluded.target_note`,
      [b.id, b.name, b.mandate, b.targetPaise === null ? null : b.targetPaise.toString(), b.targetNote],
    );
  }

  for (const m of SEED_MILESTONES) {
    await db.query(
      `insert into milestones (id, name, spec, rationale, completed_on)
       values ($1,$2,$3,$4,$5) on conflict (id) do nothing`,
      [m.id, m.name, m.spec, m.rationale, m.completedOn],
    );
  }

  for (const g of SEED_RSU_GRANTS) {
    await db.query(
      `insert into rsu_grants (id, granted_on, units, note)
       values ($1,$2,$3,$4) on conflict (id) do update set units = excluded.units`,
      [g.id, g.grantedOn, g.units, g.note],
    );
  }

  // Append audit log entry on every run by design (audit trail records each seeding; this is not an idempotency issue)
  // Owner rails (settings_rails), distinct from the IPS. Idempotent: an existing rail
  // keeps its value, because the owner may have changed it through the cooling-off.
  for (const [key, value] of Object.entries(DEFAULT_OWNER_RAILS)) {
    await db.query(
      `insert into settings_rails (key, value) values ($1, $2::jsonb)
       on conflict (key) do nothing`,
      [key, value],
    );
  }

  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('seed', $1, 'SEEDED', 'system', $2::jsonb)`,
    [snapshotId, { businessDate, holdings: SEED_HOLDINGS.length }],
  );

  return { snapshotId };
}

if (isMainModule(import.meta.url)) {
  const db = await openDb();
  await runMigrations(db);
  const { snapshotId } = await seed(db);
  console.log(`Seeded snapshot ${snapshotId}`);
  await db.close();
}
