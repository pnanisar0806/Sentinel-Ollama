import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { persistSchedules } from '../../src/domain/loans.js';
import { installIps } from '../../src/domain/ips.js';
import { buildDigestInput, composeDigest } from '../../src/notify/digest.js';
import { formatInr } from '../../src/money/paise.js';

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

  // This asserted only /Liabilities/i, so swapping netPaise for assetsPaise in the
  // renderer kept it green. The figures are asserted exactly in digest-money.test.ts;
  // here we pin that net is not merely present but DIFFERENT from assets.
  it('shows liabilities and a true net figure', async () => {
    const input = await buildDigestInput(db, '2026-08-12T08:45:00+05:30');
    const text = composeDigest(input);
    expect(text).toMatch(/Liabilities/i);
    expect(input.liabilitiesPaise).toBeGreaterThan(0n);
    expect(text).toContain(formatInr(input.netPaise, { compact: true }));
    expect(text).not.toContain(`*Net: ${formatInr(input.assetsPaise, { compact: true })}*`);
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

  // `/fresh/i` was matched by the section header "*Data freshness*" itself, so this
  // passed when every single source was stale. Assert the actual all-clear line.
  it('says data is fresh when it is', async () => {
    const input = await buildDigestInput(db, '2026-08-12T08:45:00+05:30');
    const text = composeDigest(input);
    expect(input.staleness.filter((x) => x.stale).map((x) => x.source)).not.toContain('manual-seed');
    expect(text).not.toMatch(/STALE: manual-seed/);
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