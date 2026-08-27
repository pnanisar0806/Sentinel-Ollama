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

/** This job messages the owner, so it needs the Telegram pair (and DATABASE_URL). */
export const ENV_PURPOSES: Purpose[] = ['telegram'];

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, ['telegram']);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);
  await installIps(db);

  const now = new Date().toISOString();
  const input = await buildDigestInput(db, now);
  const text = composeDigest(input);

  const html = generateDashboardHtml(input);
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const docsDir = join(repoRoot, 'docs');
  await writeFile(join(docsDir, 'dashboard.html'), html, 'utf-8');

  const dashboardUrl = 'https://pnanisar0806.github.io/Sentinel-Ollama/dashboard.html';
  const telegramText = `📊 *Dashboard:* ${dashboardUrl}\n\n${text}`;

  const telegram = new Telegram({
    botToken: env.telegramBotToken,
    ownerChatId: env.telegramOwnerChatId,
    dryRun: env.dryRun,
  });
  const { sent } = await telegram.send(telegramText);
  console.log(sent ? 'digest sent' : `digest not sent (dry run)\n\n${telegramText}`);
  await db.close();
}
