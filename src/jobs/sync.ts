import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../config/env.js';
import { ASSUMPTIONS } from '../config/assumptions.js';
import { persistSchedules } from '../domain/loans.js';
import { installIps } from '../domain/ips.js';
import { persistVests, projectVests } from '../domain/rsu.js';
import { FileIndmoneySource } from '../sources/indmoney.js';
import { KiteSource } from '../sources/kite.js';
import { assessStaleness, raiseIncidents } from '../sources/staleness.js';
import { writeSnapshot, type Source } from '../sources/types.js';

export async function runSync(
  db: Db,
  opts: { now: string; sources: Source[] },
): Promise<{ synced: string[]; failed: { source: string; error: string }[] }> {
  const businessDate = opts.now.slice(0, 10);
  const synced: string[] = [];
  const failed: { source: string; error: string }[] = [];

  for (const source of opts.sources) {
    try {
      const { rows, asOf } = await source.fetch();
      await writeSnapshot(db, source.name, businessDate, rows, asOf);
      await db.query(
        `update incidents set resolved_at = now()
         where kind = 'SYNC_FAILURE' and subject = $1 and resolved_at is null`,
        [source.name],
      );
      synced.push(source.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ source: source.name, error: message });

      const open = await db.query<{ id: string }>(
        `select id from incidents where kind = 'SYNC_FAILURE' and subject = $1 and resolved_at is null`,
        [source.name],
      );
      // Second consecutive failure escalates: never degrade silently (PRD §8.2).
      const severity = open.length > 0 ? 'BLOCK' : 'WARN';
      await db.query(
        `insert into incidents (kind, severity, subject, detail) values ('SYNC_FAILURE',$1,$2,$3)`,
        [severity, source.name, message],
      );
    }
  }

  await persistSchedules(db, `${businessDate.slice(0, 7)}-01`);

  const grants = await db.query<{ id: string; granted_on: string | Date; units: string; note: string }>(
    'select id, granted_on, units, note from rsu_grants',
  );
  await persistVests(
    db,
    projectVests(
      grants.map((g) => ({
        id: g.id,
        grantedOn: g.granted_on instanceof Date ? g.granted_on.toISOString().slice(0, 10) : g.granted_on,
        units: Number(g.units),
        note: g.note,
      })),
      {
        priceUsd: ASSUMPTIONS.seedNowPriceUsd,
        usdInr: ASSUMPTIONS.seedUsdInr,
        from: businessDate,
        to: `${Number(businessDate.slice(0, 4)) + 5}-12-31`,
      },
    ),
  );

  await raiseIncidents(db, await assessStaleness(db, opts.now));
  return { synced, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv();
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);
  await installIps(db);

  const sources: Source[] = [new FileIndmoneySource(env.indmoneySnapshotPath)];
  if (env.kiteApiKey && env.kiteAccessToken) {
    sources.push(new KiteSource({ apiKey: env.kiteApiKey, accessToken: env.kiteAccessToken }));
  }

  const result = await runSync(db, { now: new Date().toISOString(), sources });
  console.log(`synced: ${result.synced.join(', ') || 'none'}`);
  if (result.failed.length) {
    console.error(`failed: ${result.failed.map((f) => `${f.source} (${f.error})`).join('; ')}`);
  }
  await db.close();
  if (result.synced.length === 0) process.exitCode = 1;
}