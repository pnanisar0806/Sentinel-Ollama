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
    // Derived, not restated: every market + portfolio + FX source is stale with no data.
    const expected = rows.filter((r) => r.stale).length;
    // manual-seed, indmoney, frankfurter, bhavcopy, amfi, screener. `composite` was
    // removed on 2026-09-20 — nothing ever wrote it, so it held an incident that could
    // never clear. One fewer source, hence 6 rather than 7.
    expect(expected).toBe(6);

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
    // Portfolio (3) + frankfurter (stale at 5 days) + bhavcopy + amfi + screener (all empty) = 7.
    const expected = rows.filter((r) => r.stale).length;
    expect(expected).toBe(6);

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

    // manual-seed recovers; indmoney/frankfurter/bhavcopy/amfi still have no data at all.
    const expected = fresher.filter((r) => r.stale).length;
    expect(expected).toBe(5);
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
    // the two portfolio sources that never produced a row and the three empty market tables.
    expect(after.find((r) => r.source === 'frankfurter')!.stale).toBe(false);
    const expected = after.filter((r) => r.stale).length;
    expect(expected).toBe(5);

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
    // Make bhavcopy, amfi and screener fresh so only FX is stale
    await db.query(
      `insert into prices_eod (instrument_id, trade_date, close_paise, prev_close_paise, source, as_of)
       values ('NSE:NIFTYBEES', '2026-08-12', 22730, 22610, 'nse-bhavcopy', '2026-08-12T17:30:00+05:30')
       on conflict (instrument_id, trade_date) do update set close_paise = excluded.close_paise`,
    );
    await db.query(
      `insert into navs (instrument_id, nav_date, nav_micros, source, as_of)
       values ('MF:PPFC', '2026-08-12', 52850000, 'amfi', '2026-08-12T17:30:00+05:30')
       on conflict (instrument_id, nav_date) do update set nav_micros = excluded.nav_micros`,
    );
    const [upload] = await db.query<{ id: number }>(
      `insert into screener_uploads (as_of, filename, source)
       values ('2026-08-12', 'fresh.csv', 'screener-in') returning id`,
    );
    await db.query(
      `insert into fundamentals (upload_id, instrument_id, data, roce_pct, de_ratio, fcf_pos_5y, red_flags, as_of)
       values ($1, 'NSE:NIFTYBEES', '{}', 18, 0.3, true, 0, '2026-08-12T17:30:00+05:30')`,
      [upload!.id],
    );

    const rows = await assessStaleness(db, '2026-08-12T18:00:00+05:30');
    expect(rows.find((r) => r.source === 'manual-seed')!.stale).toBe(false);
    expect(rows.find((r) => r.source === 'frankfurter')!.stale).toBe(true);
    expect(rows.find((r) => r.source === 'bhavcopy')!.stale).toBe(false);
    expect(rows.find((r) => r.source === 'amfi')!.stale).toBe(false);
    expect(rows.find((r) => r.source === 'screener')!.stale).toBe(false);

    const positions = await loadPositions(db);
    const blocked = blockedInstruments(rows, positions);

    // Derived from the positions themselves, so a currency mapping change moves it.
    const usd = [...new Set(positions.filter((p) => p.currency !== 'INR').map((p) => p.instrumentId))].sort();
    expect(usd.length).toBeGreaterThan(0);
    expect(blocked).toEqual(usd);
  });

  // A source with no ingestion path reported as STALE printed red after a SUCCESSFUL
  // sync and held a BLOCK incident open forever — an unbuilt feature and rotten data are
  // different problems. All three market sources now have paths (bhavcopy → prices_eod,
  // amfi → navs, screener → fundamentals), so an empty table is a genuine drought.
  it('reports a source with a path but no data as stale, never as unimplemented', async () => {
    const rows = await assessStaleness(db, '2026-08-12T18:00:00+05:30');
    expect(rows.some((r) => r.state === 'unimplemented')).toBe(false);

    const screenerRow = rows.find((r) => r.source === 'screener');
    expect(screenerRow).toBeDefined();
    expect(screenerRow!.state).toBe('stale');
    expect(screenerRow!.stale).toBe(true);

    // amfi now has ingestion path (navs) but no data → stale
    const amfiRow = rows.find((r) => r.source === 'amfi');
    expect(amfiRow).toBeDefined();
    expect(amfiRow!.state).toBe('stale');
    expect(amfiRow!.stale).toBe(true);

    // bhavcopy has ingestion path (prices_eod) but no data → stale
    const bhavcopyRow = rows.find((r) => r.source === 'bhavcopy');
    expect(bhavcopyRow).toBeDefined();
    expect(bhavcopyRow!.state).toBe('stale');
    expect(bhavcopyRow!.stale).toBe(true);
  });
});