import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Purpose } from '../config/env.js';
import { assessStaleness } from '../sources/staleness.js';
import { Telegram } from '../notify/telegram.js';
import { isMainModule } from '../util/main-module.js';

export const ENV_PURPOSES: Purpose[] = ['telegram'];

const REMINDER_ACTION = 'SCREENER_CSV_REMINDED';
const DEDUPE_DAYS = 30;

async function lastReminderDaysAgo(db: Db): Promise<number | null> {
  const rows = await db.query<{ at: Date }>(
    `SELECT at FROM audit_log WHERE action = $1 ORDER BY at DESC LIMIT 1`,
    [REMINDER_ACTION],
  );
  if (!rows.length) return null;
  const diffMs = Date.now() - rows[0]!.at.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

async function logReminder(db: Db): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (entity, entity_id, action, actor, payload)
     VALUES ('screener', 'fundamentals', $1, 'agent', '{}')`,
    [REMINDER_ACTION],
  );
}

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, ['telegram']);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);

  try {
    const now = new Date().toISOString();
    const staleness = await assessStaleness(db, now);
    const screener = staleness.find((s) => s.source === 'screener');

    if (!screener) {
      console.log('[screener-reminder] No screener source in staleness');
      await db.close();
      process.exit(0);
    }

    console.log(`[screener-reminder] screener: ${screener.state} (age ${screener.ageHours.toFixed(1)}h, limit ${screener.limitHours}h)`);

    if (screener.state !== 'stale') {
      console.log('[screener-reminder] Fundamentals fresh — no reminder needed');
      await db.close();
      process.exit(0);
    }

    const lastDays = await lastReminderDaysAgo(db);
    if (lastDays !== null && lastDays < DEDUPE_DAYS) {
      console.log(`[screener-reminder] Last reminder ${lastDays}d ago — skipping (dedupe ${DEDUPE_DAYS}d)`);
      await db.close();
      process.exit(0);
    }

    const ageDays = Math.floor(screener.ageHours / 24);
    const text = `📅 *Screener CSV refresh due*

The latest fundamentals in the database are from *${screener.asOf.split('T')[0]}* (${ageDays} days ago — past the 90-day quarter).

Please log into screener.in, open your Sentinel screen, export the CSV, and upload it via the web UI at \`/screener/upload\`.

The quality gate will unblock once fresh data lands.`;

    const telegram = new Telegram({
      botToken: env.telegramBotToken,
      ownerChatId: env.telegramOwnerChatId,
      dryRun: env.dryRun,
    });

    const { sent } = await telegram.send(text);
    console.log(sent ? 'screener reminder sent' : `reminder not sent (dry run)\n\n${text}`);

    await logReminder(db);
  } finally {
    await db.close();
  }
}