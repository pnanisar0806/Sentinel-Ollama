import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { runSync } from '../../src/jobs/sync.js';
import { FileIndmoneySource } from '../../src/sources/indmoney.js';
import type { Source } from '../../src/sources/types.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

const failing: Source = {
  name: 'kite',
  fetch: async () => { throw new Error('Invalid access token'); },
};

describe('sync job', () => {
  it('writes a snapshot per healthy source', async () => {
    const result = await runSync(db, {
      now: '2026-08-12T17:30:00+05:30',
      sources: [new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json')],
    });
    expect(result.synced).toEqual(['indmoney']);
    expect(result.failed).toEqual([]);
  });

  it('records a failing source without aborting the healthy ones', async () => {
    const result = await runSync(db, {
      now: '2026-08-12T17:30:00+05:30',
      sources: [failing, new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json')],
    });
    expect(result.synced).toEqual(['indmoney']);
    expect(result.failed[0]).toMatchObject({ source: 'kite' });
    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents where kind = 'SYNC_FAILURE' and resolved_at is null`,
    );
    expect(Number(open[0]!.n)).toBe(1);
  });

  // The escalation test alone never pinned the FIRST severity, so hard-coding
  // severity = 'BLOCK' in runSync stayed green and the WARN->BLOCK ladder was untested.
  it('records the FIRST failure as WARN, not BLOCK', async () => {
    await runSync(db, { now: '2026-08-12T17:30:00+05:30', sources: [failing] });
    const rows = await db.query<{ severity: string }>(
      `select severity from incidents where kind = 'SYNC_FAILURE' order by opened_at`,
    );
    expect(rows.map((r) => r.severity)).toEqual(['WARN']);
  });

  it('escalates to BLOCK severity after two consecutive failures (PRD 8.2)', async () => {
    const opts = { now: '2026-08-12T17:30:00+05:30', sources: [failing] };
    await runSync(db, opts);
    await runSync(db, { ...opts, now: '2026-08-13T17:30:00+05:30' });
    const rows = await db.query<{ severity: string }>(
      `select severity from incidents where kind = 'SYNC_FAILURE' order by opened_at`,
    );
    // The whole ladder, in order — not merely "a BLOCK exists somewhere".
    expect(rows.map((r) => r.severity)).toEqual(['WARN', 'BLOCK']);
  });

  it('de-escalates: a recovered source resolves its incident', async () => {
    const opts = { now: '2026-08-12T17:30:00+05:30', sources: [failing] };
    await runSync(db, opts);

    const healthy = {
      name: failing.name,
      fetch: async () => ({ rows: [], asOf: '2026-08-13T00:00:00Z' }),
    };
    await runSync(db, { now: '2026-08-13T17:30:00+05:30', sources: [healthy] });

    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents
        where kind = 'SYNC_FAILURE' and subject = $1 and resolved_at is null`,
      [failing.name],
    );
    expect(Number(open[0]!.n)).toBe(0);
  });

  it('refreshes loan schedules and projected vests as part of the sync', async () => {
    await runSync(db, {
      now: '2026-08-12T17:30:00+05:30',
      sources: [new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json')],
    });
    const [sched] = await db.query<{ n: string }>('select count(*) as n from loan_schedule');
    const [vests] = await db.query<{ n: string }>('select count(*) as n from rsu_vests');
    expect(Number(sched!.n)).toBeGreaterThan(0);
    expect(Number(vests!.n)).toBeGreaterThan(0);
  });
});