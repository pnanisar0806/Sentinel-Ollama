import { beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { persistSchedules } from '../../src/domain/loans.js';
import { installIps } from '../../src/domain/ips.js';
import { loadPositions } from '../../src/domain/networth.js';
import { blockedInstruments } from '../../src/sources/staleness.js';
import { buildDigestInput, composeDigest } from '../../src/notify/digest.js';
import { formatInr } from '../../src/money/paise.js';
import { renderPage } from '../../src/ui/render.js';
import { handleRequest } from '../../src/ui/server.js';

const NOW = '2026-08-12T08:45:00+05:30';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
  await persistSchedules(db, '2026-09-01');
  await installIps(db);
});

describe('preview UI', () => {
  it('weekly page shows real, derived figures — not hardcoded literals', async () => {
    const input = await buildDigestInput(db, NOW);
    const positions = await loadPositions(db, input.businessDate);
    const blocked = blockedInstruments(input.staleness, positions);

    const html = await renderPage(db, NOW, 'weekly');

    expect(html).toContain(formatInr(input.netPaise, { compact: true }));
    expect(html).toContain(blocked.join(', '));
    expect(html).toContain(formatInr(positions[0]!.valuePaise, { compact: true }));
  });

  it('weekly page badges every Phase 1 section with the task that fills it', async () => {
    const html = await renderPage(db, NOW, 'weekly');
    for (const task of ['Task 1', 'Task 6', 'Task 7', 'Task 10', 'Task 11', 'Task 12']) {
      expect(html).toContain(task);
    }
    expect(html).toContain('lights up as tasks land');
  });

  it('digest page embeds the composed digest verbatim', async () => {
    const input = await buildDigestInput(db, NOW);
    const escaped = composeDigest(input)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    const html = await renderPage(db, NOW, 'digest');
    expect(html).toContain(escaped);
    expect(html).toContain('Daily Digest');
  });

  it('server routes / and /digest, 404s the rest', async () => {
    expect((await handleRequest(db, '/', NOW)).status).toBe(200);
    expect((await handleRequest(db, '/weekly', NOW)).status).toBe(200);
    expect((await handleRequest(db, '/digest', NOW)).status).toBe(200);
    expect((await handleRequest(db, '/nope', NOW)).status).toBe(404);
  });

  it('ui sources never touch a data-mutating path (read-only preview)', async () => {
    const files = ['../../src/ui/render.ts', '../../src/ui/server.ts'];
    for (const rel of files) {
      const src = await readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8');
      expect(src).not.toMatch(/\b(writeSnapshot|persist\w+|confirmVest|saveStatementPhoto)\b/);
    }
  });
});