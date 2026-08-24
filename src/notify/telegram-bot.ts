import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type TelegramEnv } from '../config/env.js';
import { installIps } from '../domain/ips.js';
import { runSync } from '../jobs/sync.js';
import { indmoneySource } from '../jobs/sync.js';
import { KiteSource } from '../sources/kite.js';
import { fetchUsdInr } from '../sources/fx.js';
import { rateMicros } from '../money/fx.js';
import { assessStaleness } from '../sources/staleness.js';
import { Telegram, escapeMarkdown } from './telegram.js';
import { isMainModule } from '../util/main-module.js';

const POLL_TIMEOUT = 30; // seconds
const POLL_INTERVAL_MS = 1000;

/** Commands the bot understands. */
const COMMANDS = {
  sync: 'Trigger an on-demand portfolio sync (Kite + INDmoney + FX)',
  status: 'Show staleness and open incidents',
  help: 'Show this help',
} as const;

type Command = keyof typeof COMMANDS;

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number | string };
    text?: string;
    from?: { id: number; is_bot?: boolean };
  };
}

export class TelegramBot {
  private readonly telegram: Telegram;
  private readonly db: Db;
  private readonly env: TelegramEnv;
  private offset = 0;
  private running = false;

  constructor(telegram: Telegram, db: Db, env: TelegramEnv) {
    this.telegram = telegram;
    this.db = db;
    this.env = env;
  }

  async start(): Promise<void> {
    this.running = true;
    console.log('[telegram-bot] Started polling for updates...');

    // Prime the sync sources once at startup
    const sources = await this.buildSources();

    while (this.running) {
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update, sources);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error('[telegram-bot] Poll error:', msg);
        // Brief backoff on error
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const res = await this.telegram['fetchImpl'](
      `https://api.telegram.org/bot${this.telegram['botToken']}/getUpdates`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset: this.offset,
          timeout: POLL_TIMEOUT,
          allowed_updates: ['message'],
        }),
      },
    );
    const body = (await res.json()) as { ok: boolean; result?: TelegramUpdate[]; description?: string };
    if (!body.ok) throw new Error(`getUpdates failed: ${body.description ?? res.status}`);
    return body.result ?? [];
  }

  private async handleUpdate(update: TelegramUpdate, sources: Awaited<ReturnType<typeof this.buildSources>>): Promise<void> {
    const msg = update.message;
    if (!msg?.text) return;

    const chatId = String(msg.chat.id);
    if (!this.telegram.isOwner(chatId)) {
      console.log('[telegram-bot] Ignored message from non-owner:', chatId);
      return;
    }

    const text = msg.text.trim();
    if (!text.startsWith('/')) return;

    const [rawCmd, ...args] = text.slice(1).split(/\s+/);
    if (!rawCmd) return;
    const cmd = rawCmd.toLowerCase() as Command;

    console.log('[telegram-bot] Command from owner:', cmd, args);

    try {
      switch (cmd) {
        case 'sync':
          await this.handleSync(sources);
          break;
        case 'status':
          await this.handleStatus();
          break;
        case 'help':
          await this.handleHelp();
          break;
        default:
          await this.telegram.send(`Unknown command: /${rawCmd}\nUse /help for available commands.`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[telegram-bot] Command error:', msg);
      await this.telegram.send(`⚠️ Command failed: ${escapeMarkdown(msg)}`);
    }
  }

  private async buildSources() {
    const srcs = [await indmoneySource(this.db, {
      indmoneySnapshotPath: this.env.indmoneySnapshotPath,
      tokenEncryptionKey: this.env.tokenEncryptionKey,
    })];
    if (this.env.kiteApiKey && this.env.kiteAccessToken) {
      srcs.push(new KiteSource({ apiKey: this.env.kiteApiKey, accessToken: this.env.kiteAccessToken }));
    }
    return srcs;
  }

  private async handleSync(sources: Awaited<ReturnType<typeof this.buildSources>>): Promise<void> {
    await this.telegram.send('🔄 *Syncing portfolio...*');

    const now = new Date().toISOString();
    const result = await runSync(this.db, {
      now,
      sources,
      fetchFx: () => fetchUsdInr(),
    });

    const lines = ['*Sync complete*', ''];
    if (result.synced.length) {
      lines.push('✅ Synced:', ...result.synced.map((s) => `• ${s}`));
    }
    if (result.failed.length) {
      lines.push('', '❌ Failed:', ...result.failed.map((f) => `• ${f.source}: ${escapeMarkdown(f.error)}`));
    }
    if (!result.synced.length && !result.failed.length) {
      lines.push('_No sources configured_');
    }

    await this.telegram.send(lines.join('\n'));
  }

  private async handleStatus(): Promise<void> {
    const now = new Date().toISOString();
    const staleness = await assessStaleness(this.db, now);
    const incidents = await this.db.query<{ severity: string; subject: string; detail: string }>(
      `select severity, subject, detail from incidents where resolved_at is null order by severity desc, created_at desc limit 10`,
    );

    const lines = ['*Status*', ''];

    if (staleness.length) {
      lines.push('*Staleness:*');
      for (const s of staleness) {
        const badge = s.state === 'fresh' ? '✅' : s.state === 'stale' ? '⚠️' : '❓';
        lines.push(`${badge} ${s.source}: ${s.state} (age ${s.ageHours}h, limit ${s.limitHours}h)`);
      }
    } else {
      lines.push('*Staleness:* _no sources tracked_');
    }

    if (incidents.length) {
      lines.push('', '*Open incidents:*');
      for (const i of incidents) {
        const badge = i.severity === 'BLOCK' ? '🔴' : '🟡';
        lines.push(`${badge} ${i.severity} — ${i.subject}: ${escapeMarkdown(i.detail)}`);
      }
    } else {
      lines.push('', '*Open incidents:* _none_');
    }

    await this.telegram.send(lines.join('\n'));
  }

  private async handleHelp(): Promise<void> {
    const lines = ['*Available commands*', ''];
    for (const [cmd, desc] of Object.entries(COMMANDS)) {
      lines.push(`/${cmd} — ${desc}`);
    }
    lines.push('', '_Only the owner chat ID may use these commands._');
    await this.telegram.send(lines.join('\n'));
  }
}

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

  // Graceful shutdown
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