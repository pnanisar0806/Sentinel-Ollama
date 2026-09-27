import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  decideProposal, loadProposals, recordLlmCall, recordProposal,
} from '../../src/advisor/proposals.js';

/**
 * Phase 2.5 Task 1. The advisor (the LLM layer) may write its own evidence and nothing
 * else: it must not be able to reach order flow, recommendation persistence, safety
 * controls or funded status, however many hops away. The import graph is the mechanism,
 * as in tests/architecture/no-catch-up.test.ts.
 */
const SRC = resolve(fileURLToPath(new URL('../../src/', import.meta.url)));
const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const rel = (abs: string) => relative(REPO, abs).split(/[\\/]/).join('/');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
  });
}
function deps(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)]
    .map((m) => m[1]!).filter((s) => s.startsWith('.'))
    .map((s) => normalize(join(dirname(file), s.replace(/\.js$/, '.ts'))))
    .filter((p) => existsSync(p));
}
const graph = new Map(files(SRC).map((f) => [rel(f), deps(f).map(rel)]));

function reach(from: string): Set<string> {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    for (const d of graph.get(stack.pop()!) ?? []) if (!seen.has(d)) { seen.add(d); stack.push(d); }
  }
  return seen;
}

/** What the advisor must never reach, directly or transitively. */
const FORBIDDEN = [
  'src/domain/orders.ts', 'src/domain/order-drafting.ts', 'src/domain/controls.ts',
  'src/domain/funded-status.ts', 'src/domain/recommendations.ts', 'src/domain/exit-promotion.ts',
  'src/notify/telegram-bot.ts', 'src/db/migrate.ts',
];

/** The only tables advisor code may write. */
const ADVISOR_TABLES = new Set([
  'advisor_proposals', 'advisor_decisions', 'replay_runs', 'llm_calls',
  'news_events', 'news_fetch_runs', 'event_sentiment', 'audit_log',
]);

const advisorFiles = () => [...graph.keys()].filter((f) => f.startsWith('src/advisor/'));

describe('the advisor capability firewall', () => {
  it('walked a real advisor module', () => {
    expect(advisorFiles().length).toBeGreaterThan(0);
    expect(graph.size).toBeGreaterThan(50);
  });

  it('no advisor module can reach order flow, recommendation writes, controls or funded status', () => {
    const offences = advisorFiles().flatMap((f) => [...reach(f)].filter((d) => FORBIDDEN.includes(d)).map((d) => `${f} -> ${d}`));
    expect(offences).toEqual([]);
  });

  it('the reach check is transitive — a two-hop path counts', () => {
    // A synthetic advisor module that reaches orders.ts only through order-drafting.ts.
    graph.set('src/advisor/__probe.ts', ['src/domain/order-drafting.ts']);
    try {
      expect([...reach('src/advisor/__probe.ts')]).toContain('src/domain/orders.ts');
    } finally {
      graph.delete('src/advisor/__probe.ts');
    }
  });

  it('advisor code writes only advisor tables', () => {
    const writes = advisorFiles().flatMap((f) => {
      const sql = readFileSync(join(REPO, f), 'utf8');
      return [...sql.matchAll(/\b(?:insert\s+into|update|delete\s+from|truncate)\s+([a-z_]+)/gi)]
        .map((m) => m[1]!.toLowerCase())
        .filter((t) => !ADVISOR_TABLES.has(t))
        .map((t) => `${f} writes ${t}`);
    });
    expect(writes).toEqual([]);
  });
});

describe('advisor proposals are evidence, and immutable', () => {
  let db: Db;
  beforeEach(async () => { db = await openDb(); await runMigrations(db); });

  const proposal = {
    kind: 'ADVISE' as const,
    payload: { action: 'WAIT', candidateId: 'c1' },
    inputSnapshot: { candidates: ['c1'] },
    evidenceIds: ['news:1'],
    model: 'm', promptVersion: 'p1', schemaVersion: 's1', asOf: '2026-09-27T10:00:00Z',
  };

  it('stores a proposal with its provenance, and refuses UPDATE, DELETE and TRUNCATE', async () => {
    const id = await recordProposal(db, proposal);
    const [row] = await db.query<{ model: string; source: string }>(`select model, source from advisor_proposals where id = $1`, [id]);
    expect(row).toEqual({ model: 'm', source: 'advisor' });
    await expect(db.query(`update advisor_proposals set model = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from advisor_proposals`)).rejects.toThrow(/append-only/);
    await expect(db.query(`truncate advisor_proposals cascade`)).rejects.toThrow(/append-only/);
    await db.close();
  });

  it('derives status from decision events rather than editing the proposal', async () => {
    const id = await recordProposal(db, proposal);
    expect((await loadProposals(db))[0]!.status).toBe('OPEN');
    await decideProposal(db, id, 'DISMISSED', 'not convinced');
    expect((await loadProposals(db))[0]!.status).toBe('DISMISSED');
    await expect(decideProposal(db, id, 'SIGNED', '')).rejects.toThrow(/already/);
    await db.close();
  });

  it('logs an LLM call with unreported usage as NULL, never zero', async () => {
    await recordLlmCall(db, { seam: 'advise', model: 'm', latencyMs: 812, outcome: 'ok', promptTokens: null, completionTokens: null, error: null });
    const [row] = await db.query<{ prompt_tokens: number | null }>(`select prompt_tokens from llm_calls`);
    expect(row!.prompt_tokens).toBeNull();
    await db.close();
  });
});
