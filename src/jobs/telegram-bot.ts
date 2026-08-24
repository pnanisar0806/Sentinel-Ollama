import { openDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type TelegramEnv } from '../config/env.js';
import { installIps } from '../domain/ips.js';
import { Telegram } from '../notify/telegram.js';
import { TelegramBot } from '../notify/telegram-bot.js';
import { isMainModule } from '../util/main-module.js';

/** This job messages the owner and reads OAuth tokens, so it needs telegram + crypto. */
export const ENV_PURPOSES = ['telegram', 'crypto'] as const;

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, ['telegram', 'crypto']) as TelegramEnv;
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);
  await installIps(db);

  const telegram = new Telegram({
    botToken: env.telegramBotToken,
    ownerChatId: env.telegramOwnerChatId,
    dryRun: env.dryRun,
  });

  const bot = new TelegramBot(telegram, db, env);

  const shutdown = async () => {
    console.log('[telegram-bot] Shutting down...');
    bot.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await bot.start();
}