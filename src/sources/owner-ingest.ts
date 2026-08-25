import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db/client.js';
import { rupees, type Paise } from '../money/paise.js';

/**
 * Owner-supplied statement ingestion (Telegram photo + guided cost entry).
 *
 * Cost basis is stored as an OPEN LOT on `lots` — the only durable home that
 * survives daily re-syncs (holdings rows are replaced per snapshot; a cost written
 * there would be gone by tomorrow's sync). Rows carry `source = 'owner-telegram'`,
 * `seeded = true`, a pinned `as_of`, and an append-only audit_log entry written in
 * the same transaction. FR-02 discipline applies upstream of this module: nothing
 * is ever invented from a screenshot — every number comes from the owner's reply.
 */

export interface CostCommand {
  /** Zero-based index into the /holdings list the owner is replying to. */
  index: number;
  costPaise: Paise;
  acquiredOn: string;
}

/** Parses `/cost <line#> <totalCostInr> [YYYY-MM-DD]`. Money may carry ₹ and commas. */
export function parseCostCommand(text: string, positionCount: number, now = new Date()): CostCommand {
  const parts = text.trim().split(/\s+/);
  if (parts[0]?.toLowerCase() !== '/cost' || parts.length < 3 || parts.length > 4) {
    throw new Error('usage: /cost <number-from-/holdings> <totalCostInr> [acquiredOn YYYY-MM-DD]');
  }
  const idx = Number(parts[1]);
  if (!Number.isInteger(idx) || idx < 1 || idx > positionCount) {
    throw new Error(`no position ${parts[1]} — pick a line number from /holdings (1–${positionCount})`);
  }
  const money = parts[2]!; // length >= 3 guaranteed above
  const costPaise = rupees(money.replace(/[₹,\s]/g, ''));
  if (costPaise <= 0n) throw new Error('cost must be positive');
  const acquiredOn = parts[3] ?? now.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(acquiredOn)) {
    throw new Error(`bad date ${acquiredOn} — expected YYYY-MM-DD`);
  }
  return { index: idx - 1, costPaise, acquiredOn };
}

/** Writes one open lot plus its audit row atomically. Quantity defaults to 1 because
 *  aggregated holdings model totals (see seed convention): quantity x price == total. */
export async function insertOwnerCostLot(
  db: Db,
  opts: {
    instrumentId: string;
    account: string;
    quantity?: number;
    costPaise: Paise;
    acquiredOn: string;
    now: string;
    /** Provenance of the numbers: 'telegram' (typed by owner) or 'llm' (extracted, owner-approved). */
    via?: string;
  },
): Promise<{ lotId: string }> {
  return db.withTransaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(
      `insert into lots (instrument_id, account, acquired_on, quantity, cost_paise, closed_on, seeded, as_of, source)
       values ($1, $2, $3::date, $4, $5, null, true, $6, 'owner-telegram')
       returning id`,
      [opts.instrumentId, opts.account, opts.acquiredOn, opts.quantity ?? 1,
       opts.costPaise.toString(), opts.now],
    );
    const lotId = rows[0]!.id;
    await tx.query(
      `insert into audit_log (entity, entity_id, action, actor, payload)
       values ('lots', $1, 'ingest', 'owner', $2::jsonb)`,
      [lotId, {
        via: opts.via ?? 'telegram',
        instrumentId: opts.instrumentId,
        account: opts.account,
        quantity: opts.quantity ?? 1,
        // The OBJECT goes in, never JSON.stringify: postgres-js stores a pre-stringified
        // param as a jsonb SCALAR STRING (jsonb_typeof = 'string'), which made every
        // Supabase audit row opaque to payload->>'…'. PGlite parses either form; verified
        // against the live pooler inside a rolled-back transaction 2026-08-25.
        costPaise: opts.costPaise.toString(),
        acquiredOn: opts.acquiredOn,
      }],
    );
    return { lotId };
  });
}

/** Telegram getFile → download → data/screenshots/<updateId>.<ext>. Returns the path. */
export async function saveStatementPhoto(deps: {
  fetchImpl: typeof fetch;
  botToken: string;
  fileId: string;
  dir: string;
  updateId: number | string;
}): Promise<string> {
  const metaRes = await deps.fetchImpl(`https://api.telegram.org/bot${deps.botToken}/getFile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: deps.fileId }),
  });
  const meta = await metaRes.json() as { ok: boolean; result?: { file_path: string }; description?: string };
  if (!meta.ok || !meta.result) throw new Error(`getFile failed: ${meta.description ?? metaRes.status}`);

  const binRes = await deps.fetchImpl(
    `https://api.telegram.org/file/bot${deps.botToken}/${meta.result.file_path}`,
  );
  if (!binRes.ok) throw new Error(`download failed: ${binRes.status}`);
  const bytes = Buffer.from(await binRes.arrayBuffer());

  await mkdir(deps.dir, { recursive: true });
  const ext = meta.result.file_path.includes('.')
    ? meta.result.file_path.slice(meta.result.file_path.lastIndexOf('.'))
    : '.jpg';
  const out = join(deps.dir, `${deps.updateId}${ext}`);
  await writeFile(out, bytes);
  return out;
}
