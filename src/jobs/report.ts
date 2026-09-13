import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDb } from '../db/client.js';
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

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, ENV_PURPOSES);
  const asOf = parseAsOf(process.argv.slice(2));
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);
  await installIps(db);

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
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  await writeFile(join(repoRoot, 'docs', 'dashboard.html'), html, 'utf-8');

  const telegram = new Telegram({
    botToken: env.telegramBotToken!,
    ownerChatId: env.telegramOwnerChatId!,
    dryRun: env.dryRun,
  });
  const { sent } = await telegram.send(text);
  console.log(sent ? `weekly report sent (as of ${asOf})` : `weekly report not sent (dry run)\n\n${text}`);
  await db.close();
}
