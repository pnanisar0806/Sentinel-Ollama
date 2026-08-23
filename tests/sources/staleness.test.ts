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
    // Derived, not restated: amfi/bhavcopy/screener are `unimplemented`, not stale, so
    // they raise nothing. Hard-coding 8 here is how this went stale when that changed.
    const expected = rows.filter((r) => r.stale).length;
    expect(expected).toBe(5); // manual-seed, kite, indmoney, composite, frankfurter

    expect(await raiseIncidents(db, rows)).toBe(expected);
    expect(await raiseIncidents(db, rows)).toBe(0);
    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents where kind = 'STALE_DATA' and resolved_at is null`,
    );
    expect(Number(open[0]!.n)).toBe(expected);
  });

  it('opens incidents for multiple stale sources (portfolio + FX)', async () => {
    await db.query(
      `insert into fx_rates (pair, as_of, rate_micros, source) values ('USD/INR', '2026-08-10', 95300000, 'frankfurter')`,
    );
    const rows = await assessStaleness(db, '2026-08-15T18:00:00+05:30');
    // Portfolio sources (4) + frankfurter (stale at 5 days) = 5. Market sources are
    // unimplemented and raise nothing.
    const expected = rows.filter((r) => r.stale).length;
    expect(expected).toBe(5);

    expect(await raiseIncidents(db, rows)).toBe(expected);
    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents where kind = 'STALE_DATA' and resolved_at is null`,
    );
    expect(Number(open[0]!.n)).toBe(expected);
  });

  it('resolves the incident once the source is fresh again', async () => {
    await raiseIncidents(db, await assessStaleness(db, '2026-08-15T18:00:00+05:30'));

    const fresher = await assessStaleness(db, '2026-08-12T18:00:00+05:30');
    await raiseIncidents(db, fresher);

    // manual-seed recovers; kite/indmoney/composite/frankfurter still have no data at all.
    const expected = fresher.filter((r) => r.stale).length;
    expect(expected).toBe(4);
    expect(fresher.find((r) => r.source === 'manual-seed')!.stale).toBe(false);

    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents where kind = 'STALE_DATA' and resolved_at is null`,
    );
    expect(Number(open[0]!.n)).toBe(expected);
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
    const after = await assessStaleness(db, '2026-08-15T18:00:00+05:30');
    await raiseIncidents(db, after);

    // frankfurter recovers (12.5h < 48h); manual-seed is 90h old and stays stale, as do
    // the three portfolio sources that have never produced a row.
    expect(after.find((r) => r.source === 'frankfurter')!.stale).toBe(false);
    const expected = after.filter((r) => r.stale).length;
    expect(expected).toBe(4);

    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents where kind = 'STALE_DATA' and resolved_at is null`,
    );
    expect(Number(open[0]!.n)).toBe(expected);
  });

  it('names every instrument whose recommendations must be blocked (FR-31)', async () => {
    const rows = await assessStaleness(db, '2026-08-15T18:00:00+05:30');
    const blocked = blockedInstruments(rows, await loadPositions(db));
    expect(blocked).toContain('US:NOW');
    expect(blocked.length).toBeGreaterThan(5);
  });

  // This test used to assert `toEqual([])` at an instant when FX was 100% ABSENT, and
  // it passed - which is exactly the false negative the review named. blockedInstruments
  // could only ever see portfolio sources, so a missing exchange rate blocked nothing
  // and USD holdings were reported as if they had a rupee value.
  it('blocks USD holdings while FX is missing, even with a fresh portfolio', async () => {
    const rows = await assessStaleness(db, '2026-08-12T18:00:00+05:30');
    expect(rows.find((r) => r.source === 'manual-seed')!.stale).toBe(false);
    expect(rows.find((r) => r.source === 'frankfurter')!.stale).toBe(true);

    const positions = await loadPositions(db);
    const blocked = blockedInstruments(rows, positions);

    // Derived from the positions themselves, so a currency mapping change moves it.
    const usd = [...new Set(positions.filter((p) => p.currency !== 'INR').map((p) => p.instrumentId))].sort();
    expect(usd.length).toBeGreaterThan(0);
    expect(blocked).toEqual(usd);
  });

  // amfi/bhavcopy/screener have no ingestion path in Phase 0. Reporting them as STALE
  // printed red warnings after a SUCCESSFUL sync and held a BLOCK incident open forever.
  // An unbuilt feature and rotten data are different problems.
  it('reports sources with no ingestion path as unimplemented, not stale', async () => {
    const rows = await assessStaleness(db, '2026-08-12T18:00:00+05:30');
    for (const source of ['amfi', 'bhavcopy', 'screener']) {
      const row = rows.find((r) => r.source === source);
      expect(row, `${source} must still be reported`).toBeDefined();
      expect(row!.state).toBe('unimplemented');
      expect(row!.stale).toBe(false);
    }
  });
});