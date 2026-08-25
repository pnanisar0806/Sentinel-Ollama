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
import { parseCostCommand, insertOwnerCostLot, saveStatementPhoto } from '../sources/owner-ingest.js';
import { extractHoldingsFromImage, type LlmProposal } from '../sources/llm-extract.js';
import { loadPositions, type Position } from '../domain/networth.js';
import { formatInr } from '../money/paise.js';
import { readFile } from 'node:fs/promises';
import { Telegram, escapeMarkdown } from './telegram.js';
import { isMainModule } from '../util/main-module.js';

const POLL_TIMEOUT = 30; // seconds
const POLL_INTERVAL_MS = 1000;
const SCREENSHOTS_DIR = 'data/screenshots';

/** Commands the bot understands. */
const COMMANDS = {
  sync: 'Trigger an on-demand portfolio sync (Kite + INDmoney + FX)',
  holdings: 'List open positions with their /cost line numbers',
  cost: 'Record a holding\u2019s total cost from a statement: /cost <n> <inr> [YYYY-MM-DD]',
  confirm: 'Write LLM-read costs: /confirm all or /confirm <proposal#>',
  reject: 'Discard the pending LLM proposals',
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
    photo?: { file_id: string; width: number; height: number }[];
    document?: { file_id: string; file_name?: string; mime_type?: string };
    from?: { id: number; is_bot?: boolean };
  };
}

export class TelegramBot {
  private readonly telegram: Telegram;
  private readonly db: Db;
  private readonly env: TelegramEnv;
  private offset = 0;
  private running = false;
  /** LLM proposals awaiting /confirm. Single owner, so one slot suffices. */
  private pending: (LlmProposal & { instrumentId: string | null; account: string | null })[] | null = null;

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
    if (!msg) return;

    const chatId = String(msg.chat.id);
    if (!this.telegram.isOwner(chatId)) {
      console.log('[telegram-bot] Ignored message from non-owner:', chatId);
      return;
    }

    // Photos/documents arrive before any text routing — a statement screenshot is
    // valid input even with no caption.
    if (msg.photo?.length || msg.document) {
      await this.handleStatementFile(update, msg);
      return;
    }
    if (!msg.text) return;

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
        case 'holdings':
          await this.handleHoldings();
          break;
        case 'cost':
          await this.handleCost(text);
          break;
        case 'confirm':
          await this.handleConfirm(text);
          break;
        case 'reject':
          this.pending = null;
          await this.telegram.send('Discarded. Nothing was written.');
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

  /** Photo or document from the owner → archive under data/screenshots (gitignored),
   *  then — when LLM_API_KEY is set — propose extracted costs for /confirm. */
  private async handleStatementFile(update: TelegramUpdate, msg: NonNullable<TelegramUpdate['message']>): Promise<void> {
    try {
      const fileId = msg.document
        ? msg.document.file_id
        : msg.photo![msg.photo!.length - 1]!.file_id; // Telegram sends size variants; take the largest
      const path = await saveStatementPhoto({
        fetchImpl: this.telegram['fetchImpl'],
        botToken: this.telegram['botToken'],
        fileId,
        dir: SCREENSHOTS_DIR,
        updateId: update.update_id,
      });

      if (!this.env.llmApiKey) {
        await this.telegram.send(
          `📸 Saved ${path}\n\nNow run /holdings and reply with:\n/cost <line#> <total cost in ₹> [bought YYYY-MM-DD]`,
        );
        return;
      }

      await this.telegram.send('📸 Saved. Reading the statement…');
      const positions = await loadPositions(this.db);
      const bytes = await readFile(path);
      const proposals = await extractHoldingsFromImage({
        fetchImpl: this.telegram['fetchImpl'],
        apiKey: this.env.llmApiKey,
        ...(this.env.llmModel ? { model: this.env.llmModel } : {}),
        imageBase64: bytes.toString('base64'),
        imageMimeType: path.endsWith('.png') ? 'image/png' : 'image/jpeg',
        positions,
      });

      if (!proposals.length) {
        await this.telegram.send('Could not read any costs from that image. Use /holdings + /cost manually.');
        return;
      }

      this.pending = proposals.map((p) => ({
        ...p,
        instrumentId: p.line === null ? null : positions[p.line]!.instrumentId,
        account: p.line === null ? null : positions[p.line]!.account,
      }));
      const lines = this.pending.map((p, i) => {
        const target = p.line === null
          ? '⚠️ no matching holding'
          : `${p.instrumentId} (${p.account})`;
        return `${i + 1}. ${p.name} → ${target} = ${formatInr(p.costPaise)} [${p.confidence}]`;
      });
      lines.push('', '_Writes only after:_ /confirm all · /confirm <#> · /reject');
      await this.telegram.send(lines.join('\n'));
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error);
      console.error('[telegram-bot] Statement handling failed:', m);
      await this.telegram.send(
        `⚠️ Could not process that file: ${escapeMarkdown(m)}\nYou can still use /holdings + /cost manually.`,
      );
    }
  }

  /** Writes confirmed LLM proposals as owner lots. Nothing writes without this. */
  private async handleConfirm(text: string): Promise<void> {
    if (!this.pending?.length) {
      await this.telegram.send('Nothing pending. Send a statement screenshot first.');
      return;
    }
    const parts = text.trim().split(/\s+/);
    const arg = parts[1]?.toLowerCase();
    const targets = arg === 'all'
      ? this.pending.map((_, i) => i)
      : [Number(arg) - 1];
    if (targets.some((t) => !Number.isInteger(t) || t < 0 || t >= this.pending!.length)) {
      await this.telegram.send('usage: /confirm all | /confirm <proposal#>');
      return;
    }

    const written: string[] = [];
    const skipped: string[] = [];
    for (const t of targets) {
      const p = this.pending[t]!;
      if (p.instrumentId === null || p.account === null) {
        skipped.push(`${p.name} (no matching holding — use /cost)`);
        continue;
      }
      await insertOwnerCostLot(this.db, {
        instrumentId: p.instrumentId,
        account: p.account,
        quantity: 1,
        costPaise: p.costPaise,
        acquiredOn: p.acquiredOn,
        now: new Date().toISOString(),
        via: 'llm',
      });
      written.push(`${p.name} = ${formatInr(p.costPaise)}`);
    }
    if (targets.length === this.pending.length) this.pending = null;

    const lines: string[] = [];
    if (written.length) lines.push(`✅ Recorded:`, ...written.map((w) => `• ${w}`));
    if (skipped.length) lines.push('', `⏭️ Skipped:`, ...skipped.map((s) => `• ${escapeMarkdown(s)}`));
    lines.push('', 'Feeds P&L from the next digest onward.');
    await this.telegram.send(lines.join('\n'));
  }

  /** Numbered open positions — the line numbers /cost expects. */
  private async handleHoldings(): Promise<void> {
    const positions = await loadPositions(this.db);
    if (!positions.length) {
      await this.telegram.send('_No positions yet — run /sync first._');
      return;
    }
    const lines = [...positions]
      .sort((a, b) => (a.name || a.instrumentId).localeCompare(b.name || b.instrumentId))
      .map((p, i) =>
        `${i + 1}. ${p.name || p.instrumentId} — ${formatInr(p.valuePaise)} (${p.account})`,
      );
    lines.push('', '_Reply with:_ /cost <line#> <total cost in ₹> [YYYY-MM-DD]');
    await this.telegram.send(lines.join('\n'));
  }

  /** Owner-supplied total cost for position <n>, persisted as an open lot. */
  private async handleCost(text: string): Promise<void> {
    const positions = await loadPositions(this.db);
    const cmd = parseCostCommand(text, positions.length);
    const p = positions[cmd.index]!;
    await insertOwnerCostLot(this.db, {
      instrumentId: p.instrumentId,
      account: p.account,
      quantity: 1,
      costPaise: cmd.costPaise,
      acquiredOn: cmd.acquiredOn,
      now: new Date().toISOString(),
    });
    await this.telegram.send(
      `✅ Cost recorded: ${p.instrumentId} (${p.account}) = ${formatInr(cmd.costPaise)}, acquired ${cmd.acquiredOn}.\nIt feeds P&L from the next digest onward.`,
    );
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