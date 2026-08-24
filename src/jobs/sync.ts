import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../config/env.js';
import { ASSUMPTIONS } from '../config/assumptions.js';
import { persistSchedules } from '../domain/loans.js';
import { installIps } from '../domain/ips.js';
import { persistVests, projectVests } from '../domain/rsu.js';
import { FileIndmoneySource, RemoteIndmoneySource } from '../sources/indmoney.js';
import { McpClient } from '../sources/mcp-client.js';
import { ensureAccessToken, discoverMetadata, loadClientSecret, ReauthRequired } from '../sources/oauth.js';
import { fetchUsdInr } from '../sources/fx.js';
import { rateMicros } from '../money/fx.js';
import { KiteSource } from '../sources/kite.js';
import { assessStaleness, raiseIncidents } from '../sources/staleness.js';
import { writeSnapshot, type Source } from '../sources/types.js';
import { isMainModule } from '../util/main-module.js';
import type { Purpose } from '../config/env.js';

/**
 * This job reads DATABASE_URL, INDMONEY_SNAPSHOT_PATH and the optional Kite pair.
 * It messages nobody and decrypts nothing, so it demands no purpose. Wiring
 * RemoteIndmoneySource (which reads stored OAuth tokens) adds 'crypto' here.
 */
export const ENV_PURPOSES: Purpose[] = [];

const INDMONEY_ISSUER = 'https://mcp.indmoney.com';
const INDMONEY_MCP_URL = 'https://mcp.indmoney.com/mcp';
const INDMONEY_SCOPES = ['portfolio:read'] as const;

/** What the FX step returns. Injected so the sync is testable without a network. */
export type FxFetcher = () => Promise<{ rate: number; asOf: string; source: string }>;

export async function runSync(
  db: Db,
  opts: { now: string; sources: Source[]; fetchFx?: FxFetcher },
): Promise<{ synced: string[]; failed: { source: string; error: string }[] }> {
  const businessDate = opts.now.slice(0, 10);
  const synced: string[] = [];
  const failed: { source: string; error: string }[] = [];

  /** PRD §8.2: one failing input never aborts the healthy ones, and never degrades silently. */
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
      await db.query(
        `update incidents set resolved_at = now()
         where kind = 'SYNC_FAILURE' and subject = $1 and resolved_at is null`,
        [name],
      );
      synced.push(name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ source: name, error: message });

      const open = await db.query<{ id: string }>(
        `select id from incidents where kind = 'SYNC_FAILURE' and subject = $1 and resolved_at is null`,
        [name],
      );
      // Second consecutive failure escalates: never degrade silently (PRD §8.2).
      const severity = open.length > 0 ? 'BLOCK' : 'WARN';
      await db.query(
        `insert into incidents (kind, severity, subject, detail) values ('SYNC_FAILURE',$1,$2,$3)`,
        [severity, name, message],
      );
    }
  };

  for (const source of opts.sources) {
    await step(source.name, async () => {
      const { rows, asOf } = await source.fetch();
      await writeSnapshot(db, source.name, businessDate, rows, asOf);
    });
  }

  // Nothing wrote fx_rates, so `frankfurter` was permanently stale and held an open
  // BLOCK incident: the digest printed red STALE lines after a SUCCESSFUL sync.
  if (opts.fetchFx) {
    await step('frankfurter', async () => {
      const { rate, asOf, source } = await opts.fetchFx!();
      await db.query(
        `insert into fx_rates (pair, as_of, rate_micros, source) values ('USD/INR',$1,$2,$3)
         on conflict (pair, as_of) do update set rate_micros = excluded.rate_micros,
                                                 source = excluded.source`,
        [asOf, rateMicros(rate).toString(), source],
      );
    });
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

/**
 * Prefer the live OAuth MCP source; fall back to the owner-refreshed file.
 *
 * RemoteIndmoneySource, McpClient and ensureAccessToken had NO production caller —
 * sync wired the file source only, so Tasks 11A and 11B were unreachable in
 * production. The fallback is deliberate and loud: an expired grant must degrade to
 * the last file snapshot (which the staleness engine then ages) rather than abort the
 * whole sync, but it says so on stderr rather than switching silently.
 */
export async function indmoneySource(
  db: Db,
  env: { indmoneySnapshotPath: string; tokenEncryptionKey: string | undefined },
): Promise<Source> {
  const fileSource = new FileIndmoneySource(env.indmoneySnapshotPath);
  if (!env.tokenEncryptionKey) return fileSource;

  try {
    const key = Buffer.from(env.tokenEncryptionKey, 'base64');

    // The client id is written by `pnpm indmoney:login` (dynamic registration). Reading
    // it from the DB rather than a new env var keeps one source of truth and one less
    // secret on the deployment surface.
    const [registration] = await db.query<{ client_id: string }>(
      'select client_id from oauth_clients where provider = $1', ['indmoney'],
    );
    if (!registration?.client_id) {
      throw new ReauthRequired('indmoney', 'no registered OAuth client');
    }

    const md = await discoverMetadata(INDMONEY_ISSUER);
    const clientSecret = await loadClientSecret(db, 'indmoney', key);

    const client = new McpClient({
      url: INDMONEY_MCP_URL,
      // Exactly the tool this source calls. McpClient requires a non-empty list, and
      // widening it here is what would make an order tool reachable.
      allowedTools: ['networth_holdings'],
      getToken: () => ensureAccessToken(db, 'indmoney', {
        md, clientId: registration.client_id, key, allowedScopes: INDMONEY_SCOPES,
        ...(clientSecret ? { clientSecret } : {}),
      }),
    });
    return new RemoteIndmoneySource({ client });
  } catch (error) {
    const why = error instanceof ReauthRequired ? error.message
      : error instanceof Error ? error.message : String(error);
    console.error(`INDmoney live sync unavailable (${why}); falling back to ${env.indmoneySnapshotPath}`);
    return fileSource;
  }
}

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, ENV_PURPOSES);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);
  await installIps(db);

  const sources: Source[] = [await indmoneySource(db, env)];
  if (env.kiteApiKey && env.kiteAccessToken) {
    sources.push(new KiteSource({ apiKey: env.kiteApiKey, accessToken: env.kiteAccessToken }));
  }

  const result = await runSync(db, {
    now: new Date().toISOString(),
    sources,
    fetchFx: () => fetchUsdInr(),
  });
  console.log(`synced: ${result.synced.join(', ') || 'none'}`);
  if (result.failed.length) {
    console.error(`failed: ${result.failed.map((f) => `${f.source} (${f.error})`).join('; ')}`);
  }
  await db.close();
  if (result.synced.length === 0) process.exitCode = 1;
}