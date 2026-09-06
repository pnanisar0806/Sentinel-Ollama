// Module swap for `src/domain/ips.ts` in the Next.js bundle. The real module's
// top-level `IPS_V1_TEXT = readFileSync(new URL('../config/ips-v1.md', import.meta.url))`
// cannot run inside a webpack node bundle — `import.meta.url` becomes an asset-import
// URL that fails here. This shim reads the same immutable seed file straight from disk.
// Source of truth is the DB (`currentIps` reads ips_versions); the file is only the
// install seed. substitution handled by webpack.NormalModuleReplacementPlugin in
// `web/next.config.ts`.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Db } from '../../src/db/client.js';

export const IPS_V1_TEXT = readFileSync(resolve(process.cwd(), '..', 'src', 'config', 'ips-v1.md'), 'utf8');

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