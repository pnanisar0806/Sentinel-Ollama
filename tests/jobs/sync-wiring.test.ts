import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { runSync } from '../../src/jobs/sync.js';
import { assessStaleness } from '../../src/sources/staleness.js';
import { rateMicros } from '../../src/money/fx.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

const NOW = '2026-08-12T12:00:00.000Z';

/**
 * Review item 5: nothing wrote fx_rates, so `frankfurter` was permanently stale and
 * held an open BLOCK incident. The digest printed red STALE lines after a SUCCESSFUL
 * sync — the loudest safety signal in the product was red on day one.
 */
describe('runSync records the FX rate it fetched', () => {
  const fx = async () => ({ rate: 87.42, asOf: '2026-08-12', source: 'frankfurter' });

  it('writes fx_rates so frankfurter can ever be fresh', async () => {
    await runSync(db, { now: NOW, sources: [], fetchFx: fx });

    const [row] = await db.query<{ pair: string; rate_micros: string | number | bigint; source: string }>(
      'select pair, rate_micros, source from fx_rates',
    );
    expect(row?.pair).toBe('USD/INR');
    expect(BigInt(row!.rate_micros)).toBe(rateMicros(87.42));
    expect(row?.source).toBe('frankfurter');
  });

  it('clears the permanent frankfurter staleness once a rate lands', async () => {
    const before = await assessStaleness(db, NOW);
    expect(before.find((r) => r.source === 'frankfurter')!.stale).toBe(true);

    await runSync(db, { now: NOW, sources: [], fetchFx: fx });

    const after = await assessStaleness(db, NOW);
    expect(after.find((r) => r.source === 'frankfurter')!.stale).toBe(false);
  });

  it('is idempotent — re-running the same day does not duplicate or fail', async () => {
    await runSync(db, { now: NOW, sources: [], fetchFx: fx });
    await runSync(db, { now: NOW, sources: [], fetchFx: fx });
    const rows = await db.query('select 1 from fx_rates');
    expect(rows).toHaveLength(1);
  });

  it('records an FX failure as an incident without aborting the rest of the sync', async () => {
    const failing = async () => { throw new Error('frankfurter unreachable'); };
    const result = await runSync(db, { now: NOW, sources: [], fetchFx: failing });

    expect(result.failed.map((f) => f.source)).toContain('frankfurter');
    const [incident] = await db.query<{ severity: string; detail: string }>(
      "select severity, detail from incidents where kind = 'SYNC_FAILURE' and subject = 'frankfurter'",
    );
    expect(incident?.severity).toBe('WARN');
    expect(incident?.detail).toMatch(/unreachable/);
  });
});

/**
 * Review item 4: RemoteIndmoneySource, McpClient and ensureAccessToken had no
 * production caller — sync.ts wired FileIndmoneySource only, so Tasks 11A and 11B were
 * unreachable in production. MEMORY's own plan audit predicted this verbatim.
 */
describe('the OAuth INDmoney path is reachable from the entrypoint', () => {
  const source = readFileSync('src/jobs/sync.ts', 'utf8');

  it('constructs RemoteIndmoneySource, not only the file fallback', () => {
    expect(source).toMatch(/RemoteIndmoneySource/);
    expect(source).toMatch(/ensureAccessToken/);
    expect(source).toMatch(/McpClient/);
  });

  it('keeps the file source as an explicit fallback', () => {
    expect(source).toMatch(/FileIndmoneySource/);
  });

  it('wires the real FX fetcher too', () => {
    expect(source).toMatch(/fetchUsdInr/);
  });

  it('constrains the MCP client to named read-only tools', () => {
    // The allowlist is required by McpClient, but pinning the VALUE here is what stops a
    // future edit widening it to something that can place an order.
    //
    // Widened once, deliberately, on 2026-09-20: `networth_snapshot` carries the balances
    // and liabilities the daily surplus capture needs, and rides this client rather than
    // a second OAuth path. It is read-only and names no order surface. The guard is now
    // an exhaustive allowlist rather than a single literal, so it still fails on any
    // addition — including a future read-only one, which should be a conscious edit too.
    //
    // Widened again, deliberately, on 2026-09-21: `get_mf_funds_details` carries the
    // expense ratio and AUM, which are 35 of `rankMfs`'s 100 points and exist in no
    // other source. It reads one fund's published facts, names no order surface and
    // takes no amount.
    // Widened again, deliberately, on 2026-09-21: `get_mf_by_category` lists the peer
    // funds `mf_switch` needs as a candidate universe (owner decision). It reads a
    // published category listing, names no order surface and takes no amount.
    const ALLOWED = [
      'networth_holdings', 'networth_snapshot', 'get_mf_funds_details', 'get_mf_by_category',
    ];

    const match = source.match(/allowedTools:\s*\[([^\]]*)\]/);
    expect(match, 'allowedTools literal not found in sync.ts').not.toBeNull();
    const listed = [...match![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(listed).toEqual(ALLOWED);
  });

  it('names no order-shaped tool anywhere in the entrypoint', () => {
    // CLAUDE.md: trading paths are ABSENT code paths, not disabled features. A client
    // that could name an order tool is a trading path, so the literal must never appear.
    for (const forbidden of [
      'place_order', 'modify_order', 'cancel_order',
      'place_gtt_order', 'modify_gtt_order', 'delete_gtt_order',
    ]) {
      expect(source, `sync.ts names ${forbidden}`).not.toContain(forbidden);
    }
  });
});

/**
 * FR-20: every actionable recommendation becomes an approval request. `createOrder` had
 * zero production callers until 2026-09-24, so the approval queue was always empty and
 * the Phase 2 DoD could not begin. These pin the wiring, not the behaviour — the
 * behaviour is in tests/domain/order-drafting.test.ts.
 */
describe('approval requests are drafted in production', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '../..', rel), 'utf8');

  it('the daily job drafts them', () => {
    expect(read('src/jobs/schedule.ts')).toMatch(/draftPendingOrders\(db/);
  });

  it('runs cleanup before the schedule step, so its recommendations are drafted the same day', () => {
    const wf = read('.github/workflows/schedule.yml');
    expect(wf.indexOf('pnpm cleanup')).toBeGreaterThan(-1);
    expect(wf.indexOf('pnpm cleanup')).toBeLessThan(wf.indexOf('src/jobs/schedule.ts'));
  });

  it('promoting an exit drafts it immediately', () => {
    expect(read('web/app/api/exits/promote/route.ts')).toMatch(/draftPendingOrders\(d/);
  });
});
