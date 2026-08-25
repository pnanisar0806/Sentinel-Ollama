import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/client.js';

export const IPS_V1_TEXT = readFileSync(
  fileURLToPath(new URL('../config/ips-v1.md', import.meta.url)),
  'utf8',
);

/** Versioned and append-only in spirit: a new version is a new row, never an edit. */
/**
 * Installs the current IPS text as a new version if it differs from the tip.
 *
 * Runs in ONE transaction. The two inserts used to be unwrapped, and `audit_log`
 * refuses UPDATE — since migration 0004 so does `ips_versions` — so a failure between
 * them left a policy version with no provenance record that could never be corrected:
 * not back-filled in place, not deleted. This is the text shown to the owner at a -20%
 * drawdown, so it is all-or-nothing.
 *
 * `on conflict (version) do nothing` covers the race: every job start calls this, and
 * two jobs starting together both read the same tip and compute the same next version.
 */
export async function installIps(
  db: Db,
  opts: { effectiveAt?: string } = {},
): Promise<{ version: number; created: boolean }> {
  return db.withTransaction(async (tx) => {
    const tip = async () => (await tx.query<{ version: number; full_text: string }>(
      'select version, full_text from ips_versions order by version desc limit 1',
    ))[0];

    const existing = await tip();
    if (existing?.full_text === IPS_V1_TEXT) {
      return { version: Number(existing.version), created: false };
    }

    // A revert to older text is a genuine new version, not a no-op, so the comparison
    // is deliberately against the TIP rather than against every version ever written.
    const version = existing ? Number(existing.version) + 1 : 1;
    const inserted = await tx.query<{ version: number }>(
      `insert into ips_versions (version, full_text, effective_at) values ($1,$2,$3)
       on conflict (version) do nothing
       returning version`,
      [version, IPS_V1_TEXT, opts.effectiveAt ?? new Date().toISOString()],
    );

    if (inserted.length === 0) {
      // Another install won the race and wrote this version. Report theirs.
      const winner = await tip();
      return { version: Number(winner!.version), created: false };
    }

    await tx.query(
      `insert into audit_log (entity, entity_id, action, actor, payload)
       values ('ips', $1, 'INSTALLED', 'owner', $2::jsonb)`,
      [String(version), { version }],
    );
    return { version, created: true };
  });
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