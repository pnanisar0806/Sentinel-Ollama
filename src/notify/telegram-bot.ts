import { type Db } from '../db/client.js';
import { type TelegramEnv } from '../config/env.js';
import { runSync } from '../jobs/sync.js';
import { indmoneySource } from '../jobs/sync.js';
import { KiteSource } from '../sources/kite.js';
import { fetchUsdInr } from '../sources/fx.js';
import { rateMicros } from '../money/fx.js';
import { assessStaleness } from '../sources/staleness.js';
import { parseCostCommand, insertOwnerCostLot, saveStatementPhoto } from '../sources/owner-ingest.js';
import { extractHoldingsFromImage, type LlmProposal } from '../sources/llm-extract.js';
import { resolveTicker, tickerForInstrument, normalizeTicker } from '../sources/statement-tickers.js';
import { loadPositions, type Position } from '../domain/networth.js';
import { formatInr, type Paise } from '../money/paise.js';
import { readFile, readdir } from 'node:fs/promises';
import { extname } from 'node:path';
import { Telegram, escapeMarkdown } from './telegram.js';
import { FIDELITY_EXTRACTION_PROMPT, fidelityVestsToProposals, checkFidelityVestExists, type FidelityProposal } from '../sources/fidelity-ingest.js';

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
  fidelity: 'Process a Fidelity NetBenefits RSU statement screenshot',
  status: 'Show staleness and open incidents',
  help: 'Show this help',
} as const;

type Command = keyof typeof COMMANDS;

/**
 * The ONE owner-facing line-number ordering: /holdings renders it and /cost resolves
 * against it. Two divergent orderings made `/cost 2` write to a different instrument
 * than line 2 displayed (live-test finding, 2026-08-25).
 */
export function displayOrder<T extends { name?: string | null; instrumentId: string }>(
  positions: T[],
): T[] {
  return [...positions].sort((a, b) =>
    (a.name || a.instrumentId).localeCompare(b.name || b.instrumentId),
  );
}

/**
 * Resolves where a proposal's cost should land. A known statement ticker is
 * AUTHORITATIVE — the model's `line` guess flips nondeterministically on
 * near-identical names (TMCV/TMPV wrote three wrong lots on 2026-08-25), while the
 * ticker map is owner-verified. The line anchors only holdings the map doesn't know.
 */
export function resolveProposalTarget(
  p: { name?: string | null; line: number | null },
  positions: { instrumentId: string; account: string }[],
): { instrumentId: string | null; account: string | null } {
  const byTicker = p.name ? resolveTicker(p.name) : undefined;
  if (byTicker) {
    const pos = positions.find((q) => q.instrumentId === byTicker);
    if (pos) return { instrumentId: pos.instrumentId, account: pos.account };
  }
  if (p.line === null || p.line < 0 || p.line >= positions.length) {
    return { instrumentId: null, account: null };
  }
  const pos = positions[p.line]!;
  return { instrumentId: pos.instrumentId, account: pos.account };
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    chat: { id: number | string };
    text?: string;
    caption?: string;
    photo?: { file_id: string; width: number; height: number }[];
    document?: { file_id: string; file_name?: string; mime_type?: string };
    /** Present when the message is part of a multi-photo album — Telegram delivers
     *  each photo as its OWN message, so albums must be buffered and flushed. */
    media_group_id?: string;
    from?: { id: number; is_bot?: boolean };
  };
  callback_query?: {
    id: string;
    from: { id: number };
    message?: { message_id: number; chat: { id: number | string } };
    data: string;
  };
}

export class TelegramBot {
  private readonly telegram: Telegram;
  private readonly db: Db;
  private readonly env: TelegramEnv;
  private offset = 0;
  private running = false;
  /** LLM proposals awaiting /confirm. Single owner, so one slot suffices.
   *  `conflictWithCost` marks a proposal that targets a holding already pending with a
   *  DIFFERENT value — `/confirm all` skips those (last-write-wins roulette wrote a
   *  wrong cost three times on 2026-08-25); only an explicit `/confirm <#>` writes it. */
  private pending: (LlmProposal & {
    instrumentId: string | null;
    account: string | null;
    conflictWithCost?: Paise | null;
  })[] | null = null;
  /** Album buffering: media_group_id → queued files, flushed after a short silence. */
  private readonly mediaBuffers = new Map<string, { fileId: string; mime: string }[]>();
  private readonly mediaTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
          allowed_updates: ['message', 'callback_query'],
        }),
      },
    );
    const body = (await res.json()) as { ok: boolean; result?: TelegramUpdate[]; description?: string };
    if (!body.ok) throw new Error(`getUpdates failed: ${body.description ?? res.status}`);
    return body.result ?? [];
  }

  private async handleUpdate(update: TelegramUpdate, sources: Awaited<ReturnType<typeof this.buildSources>>): Promise<void> {
    // Handle callback queries (inline keyboard buttons)
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      this.offset = update.update_id + 1;
      return;
    }

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
        case 'fidelity':
          await this.handleFidelity(text);
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
   *  then ask the owner what TYPE of statement it is before processing. */
  private async handleStatementFile(update: TelegramUpdate, msg: NonNullable<TelegramUpdate['message']>): Promise<void> {
    const fileId = msg.document
      ? msg.document.file_id
      : msg.photo![msg.photo!.length - 1]!.file_id;
    const mime = msg.document
      ? (msg.document.mime_type?.startsWith('image/') ? msg.document.mime_type : 'image/jpeg')
      : 'image/jpeg';

    const groupId = msg.media_group_id;
    const files = [{ fileId, mime }];

    if (!groupId) {
      await this.archiveAndPromptForType(update.update_id, files, msg.caption);
      return;
    }

    const buffer = this.mediaBuffers.get(groupId) ?? [];
    buffer.push({ fileId, mime });
    this.mediaBuffers.set(groupId, buffer);

    const timer = this.mediaTimers.get(groupId);
    if (timer) clearTimeout(timer);
    this.mediaTimers.set(groupId, setTimeout(async () => {
      this.mediaTimers.delete(groupId);
      const batch = this.mediaBuffers.get(groupId) ?? [];
      this.mediaBuffers.delete(groupId);
      if (batch.length) {
        // Use caption from first message in album
        const firstMsg = update.message;
        await this.archiveAndPromptForType(update.update_id, batch, firstMsg?.caption);
      }
    }, 2_500));
  }

  /** Save images to disk, then ask owner what type of statement this is. */
  private async archiveAndPromptForType(
    updateId: number,
    files: { fileId: string; mime: string }[],
    caption?: string
  ): Promise<void> {
    const savedPaths: string[] = [];
    for (const [i, f] of files.entries()) {
      const path = await saveStatementPhoto({
        fetchImpl: this.telegram['fetchImpl'],
        botToken: this.telegram['botToken'],
        fileId: f.fileId,
        dir: SCREENSHOTS_DIR,
        updateId: updateId + i,
      });
      savedPaths.push(path);
    }

    // If caption contains a known keyword, auto-route
    const captionLower = (caption ?? '').toLowerCase();
    let autoType: 'brokerage' | 'fidelity' | null = null;
    if (captionLower.includes('fidelity') || captionLower.includes('rsu') || captionLower.includes('vest')) {
      autoType = 'fidelity';
    } else if (captionLower.includes('kite') || captionLower.includes('zerodha') || captionLower.includes('broker') || captionLower.includes('mf') || captionLower.includes('mutual')) {
      autoType = 'brokerage';
    }

    if (autoType) {
      await this.telegram.send(
        `📸 Saved ${savedPaths.length} image(s). Auto-detected: **${autoType === 'fidelity' ? 'Fidelity RSU' : 'Brokerage/MF Statement'}** from caption.\n` +
        `Processing now…`
      );
      if (autoType === 'fidelity') {
        await this.processFidelityStatement(updateId, files);
      } else {
        await this.processStatements(updateId, files);
      }
      return;
    }

    // No auto-detect: ask owner via inline keyboard
    const keyboard = {
      inline_keyboard: [
        [{ text: '📊 Brokerage / MF Statement', callback_data: `stmt_type:brokerage:${updateId}` }],
        [{ text: '🏢 Fidelity RSU Vest', callback_data: `stmt_type:fidelity:${updateId}` }],
      ],
    };
    await this.telegram.send(
      `📸 Saved ${savedPaths.length} image(s) to ${SCREENSHOTS_DIR}.\n\n` +
      `What type of statement is this?`,
      { reply_markup: JSON.stringify(keyboard) }
    );
  }

  /** Handle inline keyboard callback: stmt_type:<brokerage|fidelity>:<updateId> */
  private async handleCallbackQuery(cq: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const chatId = String(cq.from.id);
    if (!this.telegram.isOwner(chatId)) {
      await this.telegram.answerCallbackQuery(cq.id, 'Unauthorized');
      return;
    }

    const data = cq.data;
    if (!data?.startsWith('stmt_type:')) {
      await this.telegram.answerCallbackQuery(cq.id, 'Unknown action');
      return;
    }

    const [_prefix, type, updateIdStr] = data.split(':');
    const updateId = Number(updateIdStr);
    if (!Number.isInteger(updateId)) {
      await this.telegram.answerCallbackQuery(cq.id, 'Invalid updateId');
      return;
    }

    // Acknowledge the button press immediately
    await this.telegram.answerCallbackQuery(cq.id, `Processing as ${type === 'fidelity' ? 'Fidelity RSU' : 'Brokerage/MF'}…`);

    // Find the saved files for this updateId
    const dir = SCREENSHOTS_DIR;
    let files: { fileId: string; mime: string }[] = [];

    try {
      const entries = await readdir(dir);
      // Find files matching this updateId (format: <updateId>.<ext> or <updateId>_<index>.<ext>)
      const matching = entries.filter((f) => f.startsWith(`${updateId}.`) || f.startsWith(`${updateId}_`));
      for (const f of matching) {
        const ext = extname(f).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.pdf' ? 'application/pdf' : 'image/jpeg';
        files.push({ fileId: f, mime });
      }
    } catch {
      // directory might not exist
    }

    if (!files.length) {
      await this.telegram.send(`⚠️ Could not find saved images for update ${updateId}. Please re-upload.`);
      return;
    }

    if (type === 'fidelity') {
      await this.processFidelityStatement(updateId, files);
    } else {
      await this.processStatements(updateId, files);
    }
  }

  /** Archive every file, then read all pages in one extraction pass against the
   *  current portfolio; proposals ACCUMULATE across batches until /confirm or /reject. */
  private async processStatements(updateId: number, files: { fileId: string; mime: string }[]): Promise<void> {
    try {
      const images: { base64: string; mimeType: string }[] = [];
      const savedPaths: string[] = [];
      for (const [i, f] of files.entries()) {
        const path = await saveStatementPhoto({
          fetchImpl: this.telegram['fetchImpl'],
          botToken: this.telegram['botToken'],
          fileId: f.fileId,
          dir: SCREENSHOTS_DIR,
          updateId: updateId + i,
        });
        savedPaths.push(path);
        const bytes = await readFile(path);
        images.push({ base64: bytes.toString('base64'), mimeType: f.mime });
      }

      if (!this.env.llmApiKey) {
        await this.telegram.send(
          `📸 Saved ${savedPaths.length} image(s) to ${SCREENSHOTS_DIR}.\n\n(LLM extraction is off — set LLM_API_KEY.)\nNow run /holdings and reply with:\n/cost <line#> <total cost in ₹> [bought YYYY-MM-DD]`,
        );
        return;
      }

      await this.telegram.send(`📸 Saved ${images.length} page(s). Reading the statement…`);
      const positions = await loadPositions(this.db);
      const knownTickers = positions
        .map((pos) => {
          const t = tickerForInstrument(pos.instrumentId);
          return t ? `${t} = ${pos.name || pos.instrumentId}` : undefined;
        })
        .filter((s): s is string => s !== undefined);
      const proposals = await extractHoldingsFromImage({
        fetchImpl: this.telegram['fetchImpl'],
        apiKey: this.env.llmApiKey,
        ...(this.env.llmModel ? { model: this.env.llmModel } : {}),
        images,
        positions,
        ...(knownTickers.length ? { knownTickers } : {}),
      });

      if (!proposals.length) {
        await this.telegram.send('Could not read any costs from those pages. Use /holdings + /cost manually.');
        return;
      }

      const prior = this.pending?.length ?? 0;
      const incoming = proposals.map((p) => {
        const target = resolveProposalTarget(p, positions);
        // Same holding already pending at a DIFFERENT value → mark, don't trust.
        // Two album batches proposing conflicting costs used to both write,
        // last-write-wins (the Tata swap, 2026-08-25).
        const clash = (this.pending ?? []).find(
          (q) => q.instrumentId !== null && q.instrumentId === target.instrumentId
            && q.account === target.account && q.costPaise !== p.costPaise,
        );
        return { ...p, ...target, conflictWithCost: clash ? clash.costPaise : null };
      });
      this.pending = [...(this.pending ?? []), ...incoming];
      const lines = incoming.map((p, i) => {
        const target = p.instrumentId === null
          ? '⚠️ no matching holding'
          : `${p.instrumentId} (${p.account})`;
        const flag = p.conflictWithCost != null
          ? ` ⚠️ pending already has ${formatInr(p.conflictWithCost)} for it`
          : '';
        return `${prior + i + 1}. ${p.name} → ${target} = ${formatInr(p.costPaise)}${flag} [${p.confidence}]`;
      });
      lines.push('', `_Pending total: ${this.pending.length}. Writes only after:_ /confirm all · /confirm <#> · /reject`);
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
    // /confirm all refuses CONFLICTED entries — two batches proposing different costs
    // for the same holding used to both write, last one winning by accident. An
    // explicit /confirm <#> is the owner's conscious override.
    const targets = arg === 'all'
      ? this.pending.map((_, i) => i).filter((i) => this.pending![i]!.conflictWithCost == null)
      : [Number(arg) - 1];
    if (targets.some((t) => !Number.isInteger(t) || t < 0 || t >= this.pending!.length)) {
      await this.telegram.send('usage: /confirm all | /confirm <proposal#>');
      return;
    }
    const conflictedIdx = this.pending
      .map((p, i) => (p.conflictWithCost != null ? i : -1))
      .filter((i) => i >= 0);

    const written: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const skipped: string[] = [];
    for (const t of targets) {
      const p = this.pending[t]!;
      if (p.instrumentId === null || p.account === null) {
        skipped.push(`${p.name} (no matching holding — use /cost)`);
        continue;
      }
      const res = await insertOwnerCostLot(this.db, {
        instrumentId: p.instrumentId,
        account: p.account,
        quantity: 1,
        costPaise: p.costPaise,
        acquiredOn: p.acquiredOn,
        now: new Date().toISOString(),
        via: 'llm',
      });
      if (res.outcome === 'unchanged') {
        unchanged.push(`• ${p.name} = ${formatInr(p.costPaise)} (already recorded)`);
      } else if (res.outcome === 'superseded') {
        updated.push(
          `• ${p.name}: ${formatInr(res.previousCostPaise!)} → ${formatInr(p.costPaise)}`,
        );
      } else {
        written.push(`• ${p.name} = ${formatInr(p.costPaise)}`);
      }
    }
    // Written AND skipped entries leave the queue: a skipped proposal can never be
    // confirmed (no matching holding), and leaving either in invited double-writes —
    // a repeat /confirm or a later /confirm all re-wrote already-recorded lots
    // (live-test finding, 2026-08-25: 89 lots for ~31 instruments in production).
    const consumed = new Set(targets);
    const remaining = this.pending!.filter((_, i) => !consumed.has(i));
    this.pending = remaining.length ? remaining : null;

    const lines: string[] = [];
    if (written.length) lines.push(`✅ Recorded:`, ...written);
    if (updated.length) lines.push(`♻️ Updated:`, ...updated);
    if (unchanged.length) lines.push(`➖ Unchanged:`, ...unchanged);
    if (skipped.length) lines.push('', `⏭️ Skipped:`, ...skipped.map((s) => `• ${escapeMarkdown(s)}`));
    if (arg === 'all' && conflictedIdx.length) {
      lines.push(
        '',
        `⚠️ Conflicting proposals skipped: #${conflictedIdx.map((i) => i + 1).join(', #')} — review and /confirm <#> to write one anyway`,
      );
    }
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
    const lines = displayOrder(positions)
      .map((p, i) =>
        `${i + 1}. ${p.name || p.instrumentId} — ${formatInr(p.valuePaise)} (${p.account})`,
      );
    lines.push('', '_Reply with:_ /cost <line#> <total cost in ₹> [YYYY-MM-DD]');
    await this.telegram.send(lines.join('\n'));
  }

  /** Owner-supplied total cost for position <n>, persisted as an open lot. */
  private async handleCost(text: string): Promise<void> {
    // Same ordering /holdings rendered — resolving against the raw loadPositions
    // order wrote the cost to a DIFFERENT instrument than the line shown.
    const positions = displayOrder(await loadPositions(this.db));
    const cmd = parseCostCommand(text, positions.length);
    const p = positions[cmd.index]!;
    const res = await insertOwnerCostLot(this.db, {
      instrumentId: p.instrumentId,
      account: p.account,
      quantity: 1,
      costPaise: cmd.costPaise,
      acquiredOn: cmd.acquiredOn,
      now: new Date().toISOString(),
    });
    const body = res.outcome === 'unchanged'
      ? `Already recorded: ${p.instrumentId} (${p.account}) = ${formatInr(cmd.costPaise)}. Nothing changed.`
      : res.outcome === 'superseded'
        ? `♻️ Updated: ${p.instrumentId} (${p.account}) ${formatInr(res.previousCostPaise!)} → ${formatInr(cmd.costPaise)}, acquired ${cmd.acquiredOn}.`
        : `✅ Cost recorded: ${p.instrumentId} (${p.account}) = ${formatInr(cmd.costPaise)}, acquired ${cmd.acquiredOn}.`;
    await this.telegram.send(`${body}\nIt feeds P&L from the next digest onward.`);
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

  /** Fidelity RSU statement ingestion — extracts vest events and queues for /confirm. */
  private async handleFidelity(text: string): Promise<void> {
    if (!this.env.llmApiKey) {
      await this.telegram.send(
        `Fidelity extraction requires LLM_API_KEY. Set it and restart the bot.\n` +
        `For now, use /holdings + /cost manually for Fidelity vests.`,
      );
      return;
    }

    const parts = text.trim().split(/\s+/);
    if (parts.length < 2) {
      await this.telegram.send(
        `Usage: /fidelity <updateId>\n` +
        `Reply to a Fidelity statement screenshot with this command, or send the screenshot now.`
      );
      return;
    }

    const updateId = Number(parts[1]);
    if (!Number.isInteger(updateId)) {
      await this.telegram.send(`Invalid updateId: ${parts[1]}`);
      return;
    }

    await this.telegram.send(`📸 Processing Fidelity statement…`);
    
    // We need to fetch the file from Telegram - but the file was already saved when the photo arrived
    // The owner should reply to the saved screenshot with /fidelity <updateId>
    await this.telegram.send(
      `Fidelity statement processing not yet wired to the media buffer.\n` +
      `For now: send the Fidelity screenshot, then run /holdings and use /cost <line#> <inr> [date] for each vest.`
    );
  }

  /** Process a Fidelity statement image from the media buffer. */
  private async processFidelityStatement(updateId: number, files: { fileId: string; mime: string }[]): Promise<void> {
    if (!this.env.llmApiKey) return;

    try {
      const images: { base64: string; mimeType: string }[] = [];
      for (const [i, f] of files.entries()) {
        const path = await saveStatementPhoto({
          fetchImpl: this.telegram['fetchImpl'],
          botToken: this.telegram['botToken'],
          fileId: f.fileId,
          dir: SCREENSHOTS_DIR,
          updateId: updateId + i,
        });
        const bytes = await readFile(path);
        images.push({ base64: bytes.toString('base64'), mimeType: f.mime });
      }

      await this.telegram.send(`📸 Saved ${images.length} page(s). Reading Fidelity RSU statement…`);

      // Use the Fidelity-specific prompt - LLM returns raw JSON we parse
      const proposals = await extractHoldingsFromImage({
        fetchImpl: this.telegram['fetchImpl'],
        apiKey: this.env.llmApiKey,
        ...(this.env.llmModel ? { model: this.env.llmModel } : {}),
        images,
        positions: [], // Fidelity uses grant IDs, not current holdings
        knownTickers: [],
        customPrompt: FIDELITY_EXTRACTION_PROMPT,
      });

      if (!proposals.length) {
        await this.telegram.send('Could not read any RSU vest events from the Fidelity statement.');
        return;
      }

      // The LLM returns LlmProposal[] but for Fidelity we interpret differently:
      // - name = grantId
      // - costPaise = priceUsd * 100 (cents)
      // - acquiredOn = vestOn
      // We need priceUsd and units from the custom prompt output, but LlmProposal doesn't have them.
      // For now, queue as cost entries the owner can review via /confirm.
      
      const fxRate = await fetchUsdInr();
      const prior = this.pending?.length ?? 0;
      
      const incoming = proposals.map((p) => ({
        ...p,
        name: `Fidelity: ${p.name}`,
        line: null,
        confidence: p.confidence === 'high' ? 'high' : 'low',
      } as LlmProposal & {
        instrumentId: string | null;
        account: string | null;
        conflictWithCost?: Paise | null;
      }));

      this.pending = [...(this.pending ?? []), ...incoming];

      const lines = incoming.map((p, i) => {
        return `${prior + i + 1}. ${p.name} vested ${p.acquiredOn}: ${formatInr(p.costPaise)} [${p.confidence}]`;
      });
      lines.push('', `_Pending total: ${this.pending.length}. Review and /confirm all or /confirm <#> to write._`);
      await this.telegram.send(lines.join('\n'));

    } catch (error) {
      const m = error instanceof Error ? error.message : String(error);
      console.error('[telegram-bot] Fidelity statement failed:', m);
      await this.telegram.send(`⚠️ Fidelity processing failed: ${escapeMarkdown(m)}`);
    }
  }
}
