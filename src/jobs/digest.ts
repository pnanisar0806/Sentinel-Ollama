import { openDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Purpose } from '../config/env.js';
import { installIps } from '../domain/ips.js';
import { buildDigestInput, composeDigest } from '../notify/digest.js';
import { Telegram } from '../notify/telegram.js';
import { isMainModule } from '../util/main-module.js';

/** This job messages the owner, so it needs the Telegram pair (and DATABASE_URL). */
export const ENV_PURPOSES: Purpose[] = ['telegram'];

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, ['telegram']);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);
  await installIps(db);

  const now = new Date().toISOString();
  const text = composeDigest(await buildDigestInput(db, now));

  const telegram = new Telegram({
    botToken: env.telegramBotToken,
    ownerChatId: env.telegramOwnerChatId,
    dryRun: env.dryRun,
  });
  const { sent } = await telegram.send(text);
  console.log(sent ? 'digest sent' : `digest not sent (dry run)\n\n${text}`);
  await db.close();
}
