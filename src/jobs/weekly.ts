import { openDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Purpose } from '../config/env.js';
import { installIps } from '../domain/ips.js';
import { buildDigestInput, composeDigest } from '../notify/digest.js';
import { generateDashboardHtml } from '../notify/dashboard.js';
import { Telegram } from '../notify/telegram.js';
import { isMainModule } from '../util/main-module.js';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** Weekly deep report job — needs Telegram + crypto (for LLM key). */
export const ENV_PURPOSES: Purpose[] = ['telegram', 'crypto'];

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, ['telegram', 'crypto']);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);
  await installIps(db);

  const now = new Date().toISOString();
  const input = await buildDigestInput(db, now);
  const dailyText = composeDigest(input);

  const html = generateDashboardHtml(input);
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const docsDir = join(repoRoot, 'docs');
  await writeFile(join(docsDir, 'dashboard.html'), html, 'utf-8');

  const dashboardUrl = 'https://pnanisar0806.github.io/Sentinel-Ollama/dashboard.html';

  // Weekly deep report: daily digest + Opus 5 qualitative synthesis (FR-51)
  // TODO(Phase 1): integrate LLM client for Opus 5 synthesis of:
  // - Signal review (satellite scores, quality gate passes/fails)
  // - Watchlist changes (additions/removals)
  // - Recommendation pipeline (this week's candidates)
  // - Suppressed-action log (FR-12: ≤4/month, 12m hold, overrides)
  // - Staleness incidents and their impact
  const weeklyHeader = `🗓 *Weekly Deep Report* — ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', month: 'long', day: 'numeric' })}`;
  const telegramText = `${weeklyHeader}\n\n${dailyText}\n\n📊 *Dashboard:* ${dashboardUrl}\n\n_Opus 5 synthesis coming in Phase 1 (signal review, pipeline, suppressed actions)._`;

  const telegram = new Telegram({
    botToken: env.telegramBotToken!,
    ownerChatId: env.telegramOwnerChatId!,
    dryRun: env.dryRun,
  });
  const { sent } = await telegram.send(telegramText);
  console.log(sent ? 'weekly report sent' : `weekly report not sent (dry run)\n\n${telegramText}`);
  await db.close();
}