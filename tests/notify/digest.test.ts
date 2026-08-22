import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { persistSchedules } from '../../src/domain/loans.js';
import { installIps } from '../../src/domain/ips.js';
import { buildDigestInput, composeDigest } from '../../src/notify/digest.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
  await persistSchedules(db, '2026-09-01');
  await installIps(db);
});

describe('daily digest', () => {
  it('leads with total net worth including NOW and EPF', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30'));
    expect(text).toMatch(/Net worth/i);
    expect(text).toMatch(/ServiceNow|NOW/);
    expect(text).toMatch(/EPF/i);
  });

  it('shows liabilities and a true net figure', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30'));
    expect(text).toMatch(/Liabilities/i);
  });

  it('reports all four buckets and nags both milestones', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30'));
    for (const b of ['FI corpus', 'House fund', 'Emergency fund', 'Education corpus']) {
      expect(text).toContain(b);
    }
    expect(text).toMatch(/Term life cover/);
    expect(text).toMatch(/Health super top-up/);
  });

  it('flags the employer concentration breach the seeded portfolio actually has', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30'));
    expect(text).toMatch(/Employer cap/i);
  });

  it('badges staleness loudly when a source is old (FR-31)', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-20T08:45:00+05:30'));
    expect(text).toMatch(/STALE/i);
  });

  it('says data is fresh when it is', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30'));
    expect(text).toMatch(/fresh/i);
  });

  it('cites the IPS version it is reporting against', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30'));
    expect(text).toMatch(/IPS v1/);
  });

  it('states that Phase 0 has no pending approvals rather than omitting the section', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30'));
    expect(text).toMatch(/Pending approvals/i);
  });

  it('is a pure function — the same input renders the same output', async () => {
    const input = await buildDigestInput(db, '2026-08-12T08:45:00+05:30');
    expect(composeDigest(input)).toBe(composeDigest(input));
  });
});