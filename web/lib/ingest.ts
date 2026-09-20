import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../src/db/client.js';
import { loadPositions } from '../../src/domain/networth.js';
import { persistVests, confirmVest } from '../../src/domain/rsu.js';
import { fetchUsdInr } from '../../src/sources/fx.js';
import { extractHoldingsFromImage } from '../../src/sources/llm-extract.js';
import {
  extractRsuVestsFromImage,
  fidelityVestsToProposals,
  checkFidelityVestExists,
} from '../../src/sources/fidelity-ingest.js';
import { insertOwnerCostLot } from '../../src/sources/owner-ingest.js';
import { tickerForInstrument } from '../../src/sources/statement-tickers.js';
import { displayOrder, resolveProposalTarget } from '../../src/sources/proposal-target.js';
import { formatInr, type Paise } from '../../src/money/paise.js';

/**
 * Web-side statement ingestion — the browser twin of the Telegram bot's
 * /cost+/confirm and /fidelity flows. Same discipline (FR-02): the statement is
 * archived, the LLM reads it into PROPOSALS, and NOTHING writes until the owner
 * clicks confirm from /import. Writes go through the same platform functions as the
 * bot (insertOwnerCostLot / persistVests + confirmVest) so bot and web can never
 * diverge; the queue rows in `web_uploads` are the durable "what was shown to the
 * owner and what they did with it" record.
 *
 * Server-only. Runs in the Next server process, whose `process.cwd()` is `web/` — the
 * repo root is one parent up.
 */

export type IngestKind = 'brokerage' | 'fidelity';
export type UploadStatus = 'proposed' | 'confirmed' | 'rejected' | 'unusable';

export interface BrokerageProposal {
  kind: 'brokerage';
  name: string;
  instrumentId: string | null;
  account: string | null;
  costPaise: string;
  acquiredOn: string;
  confidence: string;
  /** A sibling proposal proposes a DIFFERENT cost for the same holding — confirm-all skips these. */
  conflictWithCost?: string | null;
}

export interface FidelityProposal {
  kind: 'fidelity';
  grantId: string;
  vestOn: string;
  units: number;
  priceUsdCents: string;
  usdInrMicros: string;
  grossPaise: string;
  netPaise: string;
  confidence: string;
}

export type StoredProposal = BrokerageProposal | FidelityProposal;

const dbFrom = (s: string): Paise => BigInt(s) as Paise;

function repoRoot(): string {
  return resolve(process.cwd(), '..');
}

/** Same archive the Telegram bot uses (data/screenshots, gitignored). */
export function screenshotsDir(): string {
  return join(repoRoot(), 'data', 'screenshots');
}

/** Applies the web-ingest migration idempotently on first use. The schema still lives
 *  ONLY in migrations/0009_web_uploads.sql — this just executes that file, so the
 *  CLI `pnpm migrate` path and the web path can never drift.
 *
 *  The file read is gated on the table being absent, and that gate is load-bearing in
 *  production, not an optimisation. `migrations/` is never bundled into the Vercel
 *  serverless output: Next traces only statically-visible paths, and this one is built
 *  at runtime from `process.cwd()`. An unconditional read therefore throws ENOENT on
 *  every /import render once deployed. On a deployed database `pnpm migrate` has
 *  already created the table, so the read is skipped; the only caller that reaches it
 *  is a fresh local PGlite, where the file is present. Same class of bug as
 *  src/config/ips-v1.md, which became a .ts template literal for this reason. */
let ensured = false;
export async function ensureWebIngestion(db: Db): Promise<void> {
  if (ensured) return;
  const [present] = await db.query<{ present: boolean }>(
    "select to_regclass('public.web_uploads') is not null as present",
  );
  if (!present?.present) {
    const sql = await readFile(join(repoRoot(), 'migrations', '0009_web_uploads.sql'), 'utf8');
    await db.exec(sql);
  }
  ensured = true;
}

/** Test seam: `ensured` is module-level, so a second test would otherwise inherit the
 *  first one's short-circuit and assert nothing. */
export function resetWebIngestionCacheForTests(): void {
  ensured = false;
}

/** Guesses a sane image mime type from the filename when the browser sent none. */
export function mimeFor(name: string, fallback: string): string {
  if (fallback.startsWith('image/') || fallback === 'application/pdf') return fallback;
  const ext = extname(name).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.pdf') return 'application/pdf';
  return 'image/jpeg';
}

export interface ArchivedPage {
  storedPath: string;
  fileName: string;
  mime: string;
  base64: string;
}

/** Writes each upload to data/screenshots/web-<uuid>.<ext> and base64s it for the LLM. */
export async function archiveFiles(files: { name: string; bytes: Buffer; mime: string }[]): Promise<ArchivedPage[]> {
  const dir = screenshotsDir();
  await mkdir(dir, { recursive: true });
  const out: ArchivedPage[] = [];
  for (const f of files) {
    const mime = mimeFor(f.name, f.mime);
    const storedPath = join(dir, `web-${randomUUID()}${extname(f.name).toLowerCase() || '.' + (mime === 'image/png' ? 'png' : 'jpg')}`);
    await writeFile(storedPath, f.bytes);
    out.push({ storedPath, fileName: f.name, mime, base64: f.bytes.toString('base64') });
  }
  return out;
}

export interface UploadInsert {
  kind: IngestKind;
  fileName: string;
  storedPaths: string[];
  pageCount: number;
  status: UploadStatus;
  proposals: StoredProposal[];
  error?: string;
}

export async function insertUpload(db: Db, u: UploadInsert): Promise<string> {
  const rows = await db.query<{ id: string }>(
    `insert into web_uploads (kind, file_name, stored_path, page_count, status, proposals, error)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7) returning id`,
    [u.kind, u.fileName, u.storedPaths.join('\n'), u.pageCount, u.status, u.proposals, u.error ?? null],
  );
  return rows[0]!.id;
}

/** LLM pass for a brokerage/Kite statement, resolved onto current positions. */
export async function extractBrokerage(db: Db, pages: ArchivedPage[]): Promise<BrokerageProposal[]> {
  const positions = displayOrder(await loadPositions(db));
  const knownTickers = positions
    .map((pos) => {
      const t = tickerForInstrument(pos.instrumentId);
      return t ? `${t} = ${pos.name || pos.instrumentId}` : undefined;
    })
    .filter((s): s is string => s !== undefined);
  const extracted = await extractHoldingsFromImage({
    fetchImpl: fetch,
    apiKey: process.env.LLM_API_KEY!,
    ...(process.env.LLM_MODEL ? { model: process.env.LLM_MODEL } : {}),
    images: pages.map((p) => ({ base64: p.base64, mimeType: p.mime })),
    positions,
    ...(knownTickers.length ? { knownTickers } : {}),
  });
  const resolved: BrokerageProposal[] = extracted.map((p) => {
    const target = resolveProposalTarget(p, positions);
    return {
      kind: 'brokerage' as const,
      name: p.name,
      instrumentId: target.instrumentId,
      account: target.account,
      costPaise: p.costPaise.toString(),
      acquiredOn: p.acquiredOn,
      confidence: p.confidence,
    };
  });
  // Two rows of the same upload proposing DIFFERENT costs for one holding would
  // both write on confirm-all (the bot's 2026-08-25 lesson). Flag, don't trust.
  for (const r of resolved) {
    if (r.instrumentId === null) continue;
    const clash = resolved.find((q) =>
      q !== r && q.instrumentId === r.instrumentId && q.account === r.account && q.costPaise !== r.costPaise,
    );
    r.conflictWithCost = clash ? clash.costPaise : null;
  }
  return resolved;
}

/** LLM pass for a Fidelity RSU statement, priced at the live FX rate, dead-dropped
 *  when already confirmed ACTUAL (FR-03 — a confirmed vest is immutable). */
export async function extractFidelity(db: Db, pages: ArchivedPage[]): Promise<FidelityProposal[]> {
  const vests = await extractRsuVestsFromImage({
    fetchImpl: fetch,
    apiKey: process.env.LLM_API_KEY!,
    ...(process.env.LLM_MODEL ? { model: process.env.LLM_MODEL } : {}),
    images: pages.map((p) => ({ base64: p.base64, mimeType: p.mime })),
  });
  const fx = await fetchUsdInr();
  const priced = fidelityVestsToProposals(vests, fx.rate);
  const fresh: FidelityProposal[] = [];
  for (const p of priced) {
    if (await checkFidelityVestExists(db, p.grantId, p.vestOn)) continue;
    fresh.push({
      kind: 'fidelity',
      grantId: p.grantId,
      vestOn: p.vestOn,
      units: p.units,
      priceUsdCents: p.priceUsdCents.toString(),
      usdInrMicros: p.usdInrMicros.toString(),
      grossPaise: p.grossPaise.toString(),
      netPaise: p.netPaise.toString(),
      confidence: p.confidence,
    });
  }
  return fresh;
}

export interface UploadRow {
  id: string;
  kind: IngestKind;
  fileName: string;
  storedPaths: string[];
  pageCount: number;
  status: UploadStatus;
  proposals: StoredProposal[];
  summary: string | null;
  error: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

interface UploadQueryRow {
  id: string;
  kind: IngestKind;
  file_name: string;
  stored_path: string;
  page_count: number;
  status: UploadStatus;
  proposals: unknown;
  summary: string | null;
  error: string | null;
  created_at: string | Date;
  resolved_at: string | Date | null;
}

const iso = (v: string | Date | null): string | null =>
  v == null ? null : (v instanceof Date ? v.toISOString() : String(v));

function parseProposals(p: unknown): StoredProposal[] {
  if (p == null) return [];
  const arr = typeof p === 'string' ? (JSON.parse(p) as unknown[]) : (p as unknown[]);
  return arr.filter((x): x is StoredProposal => typeof x === 'object' && x !== null);
}

export async function listUploads(db: Db, limit = 20): Promise<UploadRow[]> {
  const rows = await db.query<UploadQueryRow>(
    `select id, kind, file_name, stored_path, page_count, status, proposals, summary, error, created_at, resolved_at
     from web_uploads order by created_at desc limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    fileName: r.file_name,
    storedPaths: r.stored_path ? r.stored_path.split('\n') : [],
    pageCount: r.page_count,
    status: r.status,
    proposals: parseProposals(r.proposals),
    summary: r.summary,
    error: r.error,
    createdAt: iso(r.created_at) ?? '',
    resolvedAt: iso(r.resolved_at),
  }));
}

async function loadPending(db: Db, id: string): Promise<{ kind: IngestKind; fileName: string; proposals: StoredProposal[] }> {
  const rows = await db.query<UploadQueryRow>(
    'select kind, file_name, status, proposals from web_uploads where id = $1',
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error('no such upload');
  if (row.status !== 'proposed') throw new Error('that upload is not pending');
  return { kind: row.kind, fileName: row.file_name, proposals: parseProposals(row.proposals) };
}

/** Marks a row resolved and writes the audit trail. The web_uploads row itself may
 *  only change status/summary/resolved_at (0009's trigger); everything else is filed. */
async function resolveUpload(
  db: Db,
  id: string,
  status: Exclude<UploadStatus, 'proposed'>,
  fileName: string,
  kind: IngestKind,
  summary: string | null,
): Promise<void> {
  await db.withTransaction(async (tx) => {
    await tx.query(
      `update web_uploads set status = $2, summary = $3, resolved_at = now() where id = $1`,
      [id, status, summary],
    );
    await tx.query(
      `insert into audit_log (entity, entity_id, action, actor, payload)
       values ('web_upload', $1, $2, 'owner', $3::jsonb)`,
      [id, status, { kind, fileName, ...(summary != null ? { summary } : {}) }],
    );
  });
}

export interface ConfirmResult {
  summary: string;
  written: number;
  skipped: number;
  unchanged: number;
  updated: number;
}

/** Writes the owner-approved proposals exactly like the bot's /confirm: brokerage
 *  costs land as open owner lots, Fidelity vests as ACTUAL rsu_vests. `indexes`
 *  confirms a subset (1-based, mirroring /confirm <#>); absent = all. */
export async function confirmUpload(db: Db, id: string, indexes?: number[]): Promise<ConfirmResult> {
  const { kind, fileName, proposals } = await loadPending(db, id);
  const selected = indexes === undefined
    ? proposals
    : indexes.map((i) => {
        const p = proposals[i - 1];
        if (!p) throw new Error(`no proposal #${i}`);
        return p;
      });

  let written = 0;
  let unchanged = 0;
  let updated = 0;
  let skip = 0;
  const lines: string[] = [];
  const now = new Date().toISOString();

  if (kind === 'brokerage') {
    for (const p of selected as BrokerageProposal[]) {
      if (p.instrumentId === null || p.account === null) {
        skip++;
        lines.push(`⏭️ ${p.name} — no matching holding (use /cost)`);
        continue;
      }
      const res = await insertOwnerCostLot(db, {
        instrumentId: p.instrumentId,
        account: p.account,
        quantity: 1,
        costPaise: dbFrom(p.costPaise),
        acquiredOn: p.acquiredOn,
        now,
        via: 'llm',
      });
      if (res.outcome === 'unchanged') {
        unchanged++;
        lines.push(`➖ ${p.name} = ${formatInr(dbFrom(p.costPaise))} (already recorded)`);
      } else if (res.outcome === 'superseded') {
        updated++;
        lines.push(`♻️ ${p.name}: ${formatInr(res.previousCostPaise!)} → ${formatInr(dbFrom(p.costPaise))}`);
      } else {
        written++;
        lines.push(`✅ ${p.name} = ${formatInr(dbFrom(p.costPaise))}`);
      }
    }
  } else {
    for (const p of selected as FidelityProposal[]) {
      const grants = await db.query<{ id: string }>('select id from rsu_grants where id = $1', [p.grantId]);
      if (!grants.length) {
        skip++;
        lines.push(`⏭️ ${p.grantId} vesting ${p.vestOn} — no such grant in seed data`);
        continue;
      }
      await persistVests(db, [{
        grantId: p.grantId,
        vestOn: p.vestOn,
        units: p.units,
        status: 'PROJECTED',
        grossPaise: dbFrom(p.grossPaise),
        netPaise: dbFrom(p.netPaise),
      }], { asOf: now });
      const vestRows = await db.query<{ id: string }>(
        'select id from rsu_vests where grant_id = $1 and vest_on = $2',
        [p.grantId, p.vestOn],
      );
      if (!vestRows[0]) {
        skip++;
        lines.push(`⏭️ ${p.grantId} vesting ${p.vestOn} — could not locate the vest row`);
        continue;
      }
      await confirmVest(db, vestRows[0].id, {
        units: p.units,
        priceUsdCents: BigInt(p.priceUsdCents),
        usdInrMicros: BigInt(p.usdInrMicros),
        netPaise: dbFrom(p.netPaise),
      }, { asOf: now });
      written++;
      lines.push(
        `✅ ${p.grantId} vesting ${p.vestOn}: net ${formatInr(dbFrom(p.netPaise))} (gross ${formatInr(dbFrom(p.grossPaise))})`,
      );
    }
  }

  const summary = lines.join('\n');
  await resolveUpload(db, id, 'confirmed', fileName, kind, summary);
  return { summary, written, skipped: skip, unchanged, updated };
}

/** Owner says no — nothing writes, the row is filed as rejected. */
export async function rejectUpload(db: Db, id: string): Promise<void> {
  const { kind, fileName } = await loadPending(db, id);
  await resolveUpload(db, id, 'rejected', fileName, kind, null);
}