import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Purpose } from '../config/env.js';
import { installIps } from '../domain/ips.js';
import { buildDigestInput } from '../notify/digest.js';
import { generateDashboardHtml } from '../notify/dashboard.js';
import { buildReportInput, composeReport, REDEMPTION_HORIZON_DAYS } from '../notify/report.js';
import { listRedemptionsUntil } from '../domain/redemptions.js';
import { maturityRoutingRec } from '../domain/maturities.js';
import { announceMaturity, type Recommendation } from '../domain/recommendations.js';
import { Telegram } from '../notify/telegram.js';
import { isMainModule } from '../util/main-module.js';

/**
 * FR-51 weekly deep report — `pnpm report [--as-of YYYY-MM-DD]`.
 *
 * Replaces the old `pnpm weekly`, which sent the daily digest plus a TODO where this
 * report was meant to go. One weekly entrypoint, so the two cannot drift.
 *
 * This job is a REPORTING surface and so may read bucket status (`maturityRoutingRec`);
 * `notify/report.ts` may not, because it drives the sizing engines. The routing decision
 * is assembled here and handed down as data.
 */
export const ENV_PURPOSES: Purpose[] = ['telegram', 'crypto'];

export function parseAsOf(argv: string[], today = new Date()): string {
  const i = argv.indexOf('--as-of');
  if (i === -1) return today.toISOString().slice(0, 10);
  const value = argv[i + 1];
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('--as-of needs a YYYY-MM-DD date');
  }
  return value;
}

/**
 * An unset GitHub Actions secret interpolates to `''`, not `undefined`, and `Number('')`
 * is 0 — a 0% risk-free rate would score every name as cheap against it. A blank or
 * nonsensical value therefore means "not configured", and the report says so.
 */
export function parseGsecYield(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Has a weekly report already been delivered for this business date?
 *
 * GitHub Actions treats `schedule` as best-effort and drops runs under load — the
 * Sunday 2026-09-20 04:30 UTC slot was dropped, and a weekly cron losing a slot loses
 * the whole week. The workflow therefore carries a retry cron, and a retry is only
 * safe if the second run is a no-op: `persistRecommendation` is a plain INSERT into an
 * append-only table, so running twice on one date would write duplicate advisory rows
 * that no one can delete afterwards.
 *
 * The marker is an `audit_log` row rather than a new table — the report had been
 * leaving no audit trace at all, which was its own gap in a system whose posture is an
 * append-only ledger of every action.
 */
export async function alreadyReportedFor(db: Db, asOf: string): Promise<boolean> {
  const rows = await db.query<{ one: number }>(
    `select 1 as one from audit_log
      where entity = 'weekly_report' and entity_id = $1 and action = 'REPORT_SENT' limit 1`,
    [asOf],
  );
  return rows.length > 0;
}

/** Records a delivered report. A dry run delivered nothing, so it is not recorded and
 *  must not block the real run that follows it. */
export async function recordReportRun(
  db: Db,
  asOf: string,
  meta: { sent: boolean },
): Promise<void> {
  if (!meta.sent) return;
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('weekly_report', $1, 'REPORT_SENT', 'system', $2::jsonb)`,
    [asOf, JSON.stringify({ asOf, sent: true })],
  );
}

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, ENV_PURPOSES);
  const asOf = parseAsOf(process.argv.slice(2));
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);
  await installIps(db);

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dashboardPath = join(repoRoot, 'docs', 'dashboard.html');

  // A retry that lands after a successful run must skip everything irreversible —
  // `persistRecommendation` is a plain INSERT into an append-only table — but it must
  // still write the dashboard. docs/dashboard.html is untracked, so the workflow's
  // Pages upload would otherwise publish a docs/ with no dashboard in it and take the
  // published dashboard down.
  if (await alreadyReportedFor(db, asOf)) {
    const refreshed = generateDashboardHtml(await buildDigestInput(db, new Date().toISOString()));
    await writeFile(dashboardPath, refreshed, 'utf-8');
    console.log(`weekly report already sent for ${asOf} — dashboard refreshed, nothing else to do`);
    await db.close();
    process.exit(0);
  }

  const maturityRecommendations: Recommendation[] = [];
  for (const r of await listRedemptionsUntil(db, REDEMPTION_HORIZON_DAYS, new Date(`${asOf}T00:00:00Z`))) {
    const routing = await maturityRoutingRec(r, db);
    maturityRecommendations.push(announceMaturity(r, routing, asOf));
  }

  const input = await buildReportInput(db, asOf, {
    gsecYieldPct: parseGsecYield(process.env.GSEC_YIELD_PCT),
    maturityRecommendations,
    narration: { apiKey: process.env.LLM_API_KEY, model: process.env.WEEKLY_LLM_MODEL },
  });
  const text = composeReport(input);

  // The dashboard rides along with the weekly run, as it did under `pnpm weekly`.
  const html = generateDashboardHtml(await buildDigestInput(db, input.generatedAt));
  await writeFile(dashboardPath, html, 'utf-8');

  const telegram = new Telegram({
    botToken: env.telegramBotToken!,
    ownerChatId: env.telegramOwnerChatId!,
    dryRun: env.dryRun,
  });
  const { sent } = await telegram.send(text);
  await recordReportRun(db, asOf, { sent });
  console.log(sent ? `weekly report sent (as of ${asOf})` : `weekly report not sent (dry run)\n\n${text}`);
  await db.close();
}
