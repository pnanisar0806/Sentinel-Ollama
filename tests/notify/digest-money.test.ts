import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { installIps } from '../../src/domain/ips.js';
import { persistSchedules } from '../../src/domain/loans.js';
import { buildDigestInput, composeDigest } from '../../src/notify/digest.js';
import { bucketStatuses } from '../../src/domain/buckets.js';
import { formatInr } from '../../src/money/paise.js';

const SEED_DATE = '2026-08-12';
let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await installIps(db);
  await seed(db, { asOf: SEED_DATE });
  await persistSchedules(db, '2026-09-01');
});

/**
 * Review item 7: seed writes bucket definitions but no bucket_flows, and no job writes
 * one — so every bucket balance fell through `?? 0n` and the digest read
 * "FI corpus: Rs 0 — 0.0% of Rs 10.29Cr" against Rs 47.69L of real assets.
 *
 * CLAUDE.md is explicit: unknown is NULL, never 0, and an unknown is never rendered as
 * Rs 0. An unallocated bucket is unknown, not empty.
 */
describe('an unfunded bucket reads as unallocated, not as zero', () => {
  it('reports a null balance when a bucket has no flows at all', async () => {
    const buckets = await bucketStatuses(db);
    expect(buckets.length).toBeGreaterThan(0);
    for (const b of buckets) {
      expect(b.balancePaise, `${b.id} has no flows`).toBeNull();
      expect(b.fundedRatio, `${b.id} cannot have a ratio without a balance`).toBeNull();
    }
  });

  it('never prints Rs 0 or 0.0% for a bucket in the digest', async () => {
    const text = composeDigest(await buildDigestInput(db, `${SEED_DATE}T12:00:00Z`));
    const bucketBlock = text.slice(text.indexOf('*Buckets*'), text.indexOf('*Buckets*') + 400);

    expect(bucketBlock).not.toMatch(/₹0\b/);
    expect(bucketBlock).not.toMatch(/0\.0% of/);
    expect(bucketBlock).toMatch(/not yet allocated/i);
  });

  it('reports a real balance once flows exist', async () => {
    await db.query(
      `insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, as_of, source)
       values ('B3', '2026-08-01', 60000000, 'seed', now(), 'manual-seed')`,
    );
    const b3 = (await bucketStatuses(db)).find((b) => b.id === 'B3')!;
    expect(b3.balancePaise).toBe(60000000n);
    expect(b3.fundedRatio).toBeGreaterThan(0);
  });
});

/**
 * Review item 9: previousNetPaise was hard-coded null, so "day-over-day starts
 * tomorrow" printed every day forever — tomorrow never arrived.
 */
describe('day-over-day change is computed, not permanently deferred', () => {
  it('is null on the very first business date, with only one snapshot', async () => {
    const input = await buildDigestInput(db, `${SEED_DATE}T12:00:00Z`);
    expect(input.previousNetPaise).toBeNull();
  });

  it('reports the previous business date once a second snapshot exists', async () => {
    // A later snapshot from the same source: yesterday's is the comparison point.
    const [snap] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ('2026-08-13','manual-seed') returning id`,
    );
    await db.query(
      `insert into holdings (snapshot_id, instrument_id, quantity, avg_cost_paise,
         value_paise, account, as_of, source)
       values ($1,'CASH:SAVINGS',1,null,20000000,'bank','2026-08-13T00:00:00+05:30','manual-seed')`,
      [snap!.id],
    );

    const input = await buildDigestInput(db, '2026-08-13T12:00:00Z');
    expect(input.previousNetPaise).not.toBeNull();

    // Derived: the earlier snapshot's assets minus the same liabilities.
    expect(input.previousNetPaise).toBeGreaterThan(input.netPaise);
  });

  it('renders the change rather than the "starts tomorrow" placeholder', async () => {
    const [snap] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ('2026-08-13','manual-seed') returning id`,
    );
    await db.query(
      `insert into holdings (snapshot_id, instrument_id, quantity, avg_cost_paise,
         value_paise, account, as_of, source)
       values ($1,'CASH:SAVINGS',1,null,20000000,'bank','2026-08-13T00:00:00+05:30','manual-seed')`,
      [snap!.id],
    );
    const text = composeDigest(await buildDigestInput(db, '2026-08-13T12:00:00Z'));
    expect(text).not.toMatch(/starts tomorrow/i);
  });
});

/**
 * The review found NO digest test asserting a single rupee figure — items 17 and 18.
 * `/fresh/i` was matched by the section header "*Data freshness*", so it passed when
 * every source was stale; the "true net figure" test asserted only /Liabilities/i, so
 * swapping netPaise for assetsPaise kept the suite green.
 */
describe('the digest states real money', () => {
  it('prints the exact net worth, assets and liabilities it was given', async () => {
    const input = await buildDigestInput(db, `${SEED_DATE}T12:00:00Z`);
    const text = composeDigest(input);

    // Derived from the input, so a mapper swapping two fields cannot pass.
    expect(text).toContain(formatInr(input.netPaise, { compact: true }));
    expect(text).toContain(formatInr(input.assetsPaise, { compact: true }));
    expect(text).toContain(formatInr(input.liabilitiesPaise, { compact: true }));
  });

  it('distinguishes net worth from assets — they are different numbers here', async () => {
    const input = await buildDigestInput(db, `${SEED_DATE}T12:00:00Z`);
    expect(input.netPaise).not.toBe(input.assetsPaise);
    expect(input.netPaise).toBe(input.assetsPaise - input.liabilitiesPaise);
  });

  it('names every stale source, not merely that a freshness section exists', async () => {
    const input = await buildDigestInput(db, `${SEED_DATE}T12:00:00Z`);
    const text = composeDigest(input);
    const block = text.slice(text.indexOf('*Data freshness*'));

    // `/fresh/i` matched the header "*Data freshness*" itself, so the old assertion
    // passed even when every source was stale. Derive the expected names instead.
    const staleNames = input.staleness.filter((s) => s.stale).map((s) => s.source);
    expect(staleNames.length).toBeGreaterThan(0);
    for (const name of staleNames) expect(block).toContain(name);

    // ...and a source that IS fresh must not be listed as stale.
    expect(input.staleness.filter((s) => !s.stale).map((s) => s.source)).toContain('manual-seed');
    expect(block).not.toMatch(/STALE: manual-seed/);
  });
});
