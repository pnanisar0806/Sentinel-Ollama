import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { bucketStatuses, milestoneStatuses } from '../../src/domain/buckets.js';
import { SEED_MILESTONES } from '../../src/seed/seed-data.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

/**
 * Review item 27. `daysOutstanding` was measured from a magic '2026-01-01' that appears
 * in no assumption, no seed row and no PRD line — a fabricated number presented to the
 * owner as a fact. Worse, the field meant two different things: days since COMPLETION
 * for a closed milestone, days since the invented epoch for an open one.
 *
 * The milestones table has no `raised_on` column, so for an open milestone there is
 * genuinely nothing to measure from. CLAUDE.md: never invent a number to close a gap.
 */
describe('milestoneStatuses reports only what it can derive', () => {
  it('returns every seeded milestone', async () => {
    const rows = await milestoneStatuses(db, '2026-08-12');
    expect(rows.map((r) => r.id).sort()).toEqual(SEED_MILESTONES.map((m) => m.id).sort());
  });

  it('reports null days outstanding for an open milestone, not a fabricated count', async () => {
    const rows = await milestoneStatuses(db, '2026-08-12');
    const open = rows.filter((r) => r.completedOn === null);
    expect(open.length).toBeGreaterThan(0);
    for (const m of open) {
      expect(m.daysOutstanding, `${m.id} has no raised_on to measure from`).toBeNull();
    }
  });

  it('reports days since completion for a completed milestone', async () => {
    await db.query("update milestones set completed_on = '2026-08-02' where id = 'M1'");
    const m1 = (await milestoneStatuses(db, '2026-08-12')).find((m) => m.id === 'M1')!;
    expect(m1.completedOn).toBe('2026-08-02');
    expect(m1.daysSinceCompleted).toBe(10);
    // Still null: completion tells us nothing about when it was raised.
    expect(m1.daysOutstanding).toBeNull();
  });

  it('uses no hard-coded date literal anywhere in the module', () => {
    // Comments stripped first: the docstring explaining the defect legitimately names
    // '2026-01-01', and a test that trips on its own documentation is noise.
    const code = readFileSync('src/domain/buckets.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

/** The other half of item 27: bucketStatuses had no direct test either. */
describe('bucketStatuses', () => {
  it('returns only the active buckets, with their targets and notes', async () => {
    const rows = await bucketStatuses(db);
    expect(rows.length).toBeGreaterThan(0);
    for (const b of rows) {
      expect(b.name).toBeTruthy();
      expect(b.targetNote).toBeTruthy();
    }
    expect(rows.map((b) => b.id)).toContain('B1');
  });

  it('sums signed flows rather than counting them', async () => {
    await db.query(
      `insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, as_of, source)
       values ('B3','2026-08-01', 60000000,'seed',   now(),'manual-seed'),
              ('B3','2026-08-05', -10000000,'withdrawal', now(),'manual-seed')`,
    );
    const b3 = (await bucketStatuses(db)).find((b) => b.id === 'B3')!;
    expect(b3.balancePaise).toBe(50000000n); // 6L in, 1L out
  });

  it('derives B1 target from the FI floor band, not from a literal', async () => {
    const { computeFICorpusBand } = await import('../../src/domain/funded-status.js');
    const b1 = (await bucketStatuses(db)).find((b) => b.id === 'B1')!;
    expect(b1.targetPaise).toBe(computeFICorpusBand().floorPaise);
  });
});
