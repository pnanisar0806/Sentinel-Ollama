import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/client.js';

export const IPS_V1_TEXT = readFileSync(
  fileURLToPath(new URL('../config/ips-v1.md', import.meta.url)),
  'utf8',
);

/** Versioned and append-only in spirit: a new version is a new row, never an edit. */
export async function installIps(
  db: Db,
  opts: { effectiveAt?: string } = {},
): Promise<{ version: number; created: boolean }> {
  const existing = await db.query<{ version: number; full_text: string }>(
    'select version, full_text from ips_versions order by version desc limit 1',
  );

  if (existing[0]?.full_text === IPS_V1_TEXT) {
    return { version: Number(existing[0].version), created: false };
  }

  const version = existing[0] ? Number(existing[0].version) + 1 : 1;
  await db.query(
    'insert into ips_versions (version, full_text, effective_at) values ($1,$2,$3)',
    [version, IPS_V1_TEXT, opts.effectiveAt ?? new Date().toISOString()],
  );
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('ips', $1, 'INSTALLED', 'owner', $2::jsonb)`,
    [String(version), JSON.stringify({ version })],
  );
  return { version, created: true };
}

export async function currentIps(
  db: Db,
): Promise<{ version: number; fullText: string; effectiveAt: string }> {
  const [row] = await db.query<{ version: number; full_text: string; effective_at: string }>(
    'select version, full_text, effective_at from ips_versions order by version desc limit 1',
  );
  if (!row) throw new Error('no IPS installed — run installIps() before generating anything');
  return {
    version: Number(row.version),
    fullText: row.full_text,
    effectiveAt: typeof row.effective_at === 'string'
      ? row.effective_at
      : new Date(row.effective_at).toISOString(),
  };
}

/** Extracts one '## <clause> ...' section. Phase 1 cites clauses on every recommendation. */
export function ipsClause(fullText: string, clause: string): string {
  const start = fullText.indexOf(`## ${clause} `);
  if (start === -1) throw new Error(`IPS clause ${clause} not found`);
  const rest = fullText.slice(start);
  const next = rest.indexOf('\n## ', 1);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

export function renderIps(fullText: string, clause?: string): string {
  return clause ? ipsClause(fullText, clause) : fullText;
}