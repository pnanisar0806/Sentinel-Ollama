import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadPositions } from '../../src/domain/networth.js';
import { assessStaleness, blockedInstruments, raiseIncidents, FRESHNESS_HOURS } from '../../src/sources/staleness.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

describe('staleness engine', () => {
  it('reports a fresh portfolio source as fresh', async () => {
    const rows = await assessStaleness(db, '2026-08-12T18:00:00+05:30');
    const seedRow = rows.find((r) => r.source === 'manual-seed')!;
    expect(seedRow.stale).toBe(false);
    expect(seedRow.limitHours).toBe(36);
  });

  it('flags a portfolio source older than 36 hours', async () => {
    const rows = await assessStaleness(db, '2026-08-15T18:00:00+05:30');
    expect(rows.find((r) => r.source === 'manual-seed')!.stale).toBe(true);
  });

  it('flags a portfolio source at exactly 36 hours as fresh (boundary)', async () => {
    // 36 hours exactly from 2026-08-12T00:00:00+05:30 = 2026-08-13T12:00:00+05:30
    const rows = await assessStaleness(db, '2026-08-13T12:00:00+05:30');
    expect(rows.find((r) => r.source === 'manual-seed')!.stale).toBe(false);
  });

  it('flags a portfolio source at 36 hours + 1 minute as stale (boundary)', async () => {
    // 36 hours + 1 minute from 2026-08-12T00:00:00+05:30 = 2026-08-13T12:01:00+05:30
    const rows = await assessStaleness(db, '2026-08-13T12:01:00+05:30');
    expect(rows.find((r) => r.source === 'manual-seed')!.stale).toBe(true);
  });

  it('reports FX source (frankfurter) separately from portfolio', async () => {
    // First insert an FX rate
    await db.query(
      `insert into fx_rates (pair, as_of, rate_micros, source) values ('USD/INR', '2026-08-12', 95300000, 'frankfurter')`,
    );
    const rows = await assessStaleness(db, '2026-08-12T18:00:00+05:30');
    const fxRow = rows.find((r) => r.source === 'frankfurter')!;
    expect(fxRow).toBeDefined();
    expect(fxRow.limitHours).toBe(FRESHNESS_HOURS.fx); // 48
    expect(fxRow.stale).toBe(false);
  });

  it('flags FX source as stale after 48 hours', async () => {
    await db.query(
      `insert into fx_rates (pair, as_of, rate_micros, source) values ('USD/INR', '2026-08-10', 95300000, 'frankfurter')`,
    );
    // 2026-08-12T18:00:00 is ~54 hours after 2026-08-10
    const rows = await assessStaleness(db, '2026-08-12T18:00:00+05:30');
    const fxRow = rows.find((r) => r.source === 'frankfurter')!;
    expect(fxRow.stale).toBe(true);
  });

  it('opens exactly one incident per stale source and does not duplicate on re-run', async () => {
    const rows = await assessStaleness(db, '2026-08-15T18:00:00+05:30');
    // All 8 sources are stale: manual-seed, kite, indmoney, composite, frankfurter, amfi, bhavcopy, screener
    expect(await raiseIncidents(db, rows)).toBe(8);
    expect(await raiseIncidents(db, rows)).toBe(0);
    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents where kind = 'STALE_DATA' and resolved_at is null`,
    );
    expect(Number(open[0]!.n)).toBe(8);
  });

  it('opens incidents for multiple stale sources (portfolio + FX)', async () => {
    await db.query(
      `insert into fx_rates (pair, as_of, rate_micros, source) values ('USD/INR', '2026-08-10', 95300000, 'frankfurter')`,
    );
    const rows = await assessStaleness(db, '2026-08-15T18:00:00+05:30');
    // Portfolio sources (4) + frankfurter (1, stale) + market sources (3) = 8 stale
    const opened = await raiseIncidents(db, rows);
    expect(opened).toBe(8);
    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents where kind = 'STALE_DATA' and resolved_at is null`,
    );
    expect(Number(open[0]!.n)).toBe(8);
  });

  it('resolves the incident once the source is fresh again', async () => {
    await raiseIncidents(db, await assessStaleness(db, '2026-08-15T18:00:00+05:30'));
    await raiseIncidents(db, await assessStaleness(db, '2026-08-12T18:00:00+05:30'));
    // Only manual-seed has data and becomes fresh. kite, indmoney, composite have no data (stale).
    // frankfurter has no data (stale). Market sources (3) have no data (stale).
    // Total stale: kite, indmoney, composite, frankfurter, amfi, bhavcopy, screener = 7
    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents where kind = 'STALE_DATA' and resolved_at is null`,
    );
    expect(Number(open[0]!.n)).toBe(7);
  });

  it('resolves FX incident when FX becomes fresh', async () => {
    await db.query(
      `insert into fx_rates (pair, as_of, rate_micros, source) values ('USD/INR', '2026-08-10', 95300000, 'frankfurter')`,
    );
    await raiseIncidents(db, await assessStaleness(db, '2026-08-15T18:00:00+05:30'));
    // Now add fresh FX rate
    await db.query(
      `insert into fx_rates (pair, as_of, rate_micros, source) values ('USD/INR', '2026-08-15', 95300000, 'frankfurter')`,
    );
    await raiseIncidents(db, await assessStaleness(db, '2026-08-15T18:00:00+05:30'));
    // At 2026-08-15T18:00:00+05:30: manual-seed is 90h old (stale > 36h), frankfurter is fresh (12.5h < 48h).
    // kite, indmoney, composite have no data (stale). Market sources (3) have no data (stale).
    // Total stale: manual-seed, kite, indmoney, composite, amfi, bhavcopy, screener = 7
    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents where kind = 'STALE_DATA' and resolved_at is null`,
    );
    expect(Number(open[0]!.n)).toBe(7);
  });

  it('names every instrument whose recommendations must be blocked (FR-31)', async () => {
    const rows = await assessStaleness(db, '2026-08-15T18:00:00+05:30');
    const blocked = blockedInstruments(rows, await loadPositions(db));
    expect(blocked).toContain('US:NOW');
    expect(blocked.length).toBeGreaterThan(5);
  });

  it('blocks nothing when every source is fresh', async () => {
    const rows = await assessStaleness(db, '2026-08-12T18:00:00+05:30');
    expect(blockedInstruments(rows, await loadPositions(db))).toEqual([]);
  });

  it('reports sources with no data as stale (amfi, bhavcopy, screener)', async () => {
    const rows = await assessStaleness(db, '2026-08-12T18:00:00+05:30');
    const amfi = rows.find((r) => r.source === 'amfi');
    const bhavcopy = rows.find((r) => r.source === 'bhavcopy');
    const screener = rows.find((r) => r.source === 'screener');
    // These sources have no data, so they should be reported as stale (or at least present)
    expect(amfi).toBeDefined();
    expect(bhavcopy).toBeDefined();
    expect(screener).toBeDefined();
    // With no data, ageHours should be very large (Infinity or a large number), so stale = true
    expect(amfi!.stale).toBe(true);
    expect(bhavcopy!.stale).toBe(true);
    expect(screener!.stale).toBe(true);
  });
});