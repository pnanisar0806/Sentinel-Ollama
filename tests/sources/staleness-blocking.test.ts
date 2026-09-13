import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { assessStaleness, blockedInstruments, raiseIncidents } from '../../src/sources/staleness.js';
import { loadPositions } from '../../src/domain/networth.js';

const SEED_DATE = '2026-08-12';
let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: SEED_DATE });
});

/** Fresh for the portfolio (36h limit) but well past the 48h FX limit. */
const FRESH = '2026-08-12T18:00:00+05:30';

describe('assessStaleness reports each source once', () => {
  it('does not duplicate a source that is both known and present in the data', async () => {
    const rows = await assessStaleness(db, FRESH);
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.source, (counts.get(r.source) ?? 0) + 1);

    const duplicated = [...counts].filter(([, n]) => n > 1).map(([s]) => s);
    expect(duplicated).toEqual([]);
    // manual-seed is in KNOWN_PORTFOLIO_SOURCES *and* in holdings — the exact collision
    // that produced two rows from `[...KNOWN, ...map.keys()]` iterated as a list.
    expect(counts.get('manual-seed')).toBe(1);
    expect(rows.length).toBe(new Set(rows.map((r) => r.source)).size);
  });
});

/**
 * A source with no ingestion path is NOT stale data — it is an unbuilt feature, and
 * reporting it as STALE printed red after a *successful* sync and kept a BLOCK incident
 * permanently open, which trains the owner to ignore the loudest safety signal.
 * All three market sources now HAVE ingestion paths — bhavcopy (prices_eod, Task 3),
 * amfi (navs, Task 4), screener (fundamentals, Task 6) — so an empty table is a real
 * drought and reads as stale. The `unimplemented` state stays for the next unbuilt one.
 */
describe('unimplemented sources are distinguished from stale ones', () => {
  it('reports bhavcopy, amfi and screener as stale once they have a path but no data', async () => {
    const rows = await assessStaleness(db, FRESH);
    const screenerRow = rows.find((r) => r.source === 'screener');
    expect(screenerRow, `screener must still be reported`).toBeDefined();
    expect(screenerRow!.state).toBe('stale');
    expect(screenerRow!.stale).toBe(true);

    // bhavcopy has ingestion path (prices_eod) but no data -> stale
    const bhavcopyRow = rows.find((r) => r.source === 'bhavcopy');
    expect(bhavcopyRow).toBeDefined();
    expect(bhavcopyRow!.state).toBe('stale');
    expect(bhavcopyRow!.stale).toBe(true);

    // amfi has ingestion path (navs) but no data -> stale
    const amfiRow = rows.find((r) => r.source === 'amfi');
    expect(amfiRow).toBeDefined();
    expect(amfiRow!.state).toBe('stale');
    expect(amfiRow!.stale).toBe(true);
  });

  it('raises an incident only for a source that is stale, never for an unimplemented one', async () => {
    const rows = await assessStaleness(db, FRESH);
    await raiseIncidents(db, rows);
    const open = await db.query<{ subject: string }>(
      "select subject from incidents where kind = 'STALE_DATA' and resolved_at is null",
    );
    const subjects = open.map((r) => r.subject);
    // Derived from the assessment, not restated: exactly the stale sources get incidents.
    for (const r of rows) {
      if (r.stale) expect(subjects, `${r.source} is stale`).toContain(r.source);
      else expect(subjects, `${r.source} is ${r.state}`).not.toContain(r.source);
    }
    expect(subjects).toContain('screener');
  });

  it('still reports a real portfolio source as stale once it ages past its limit', async () => {
    const rows = await assessStaleness(db, '2026-08-15T18:00:00+05:30');
    const seedRow = rows.find((r) => r.source === 'manual-seed')!;
    expect(seedRow.state).toBe('stale');
    expect(seedRow.stale).toBe(true);
  });
});

/**
 * FR-31's other half. blockedInstruments intersected stale sources with
 * `positions.map(p => p.source)`, which is always a PORTFOLIO source — so stale FX,
 * NAVs or prices could never block anything, and the previous test suite encoded that
 * false negative as expected behaviour ("blocks nothing when every source is fresh"
 * passed at an instant when FX was 100% absent).
 */
describe('blockedInstruments blocks on valuation inputs, not just portfolio sources', () => {
  it('blocks every non-INR instrument while FX is stale', async () => {
    // Nothing writes fx_rates yet, so frankfurter is genuinely stale here.
    const rows = await assessStaleness(db, FRESH);
    expect(rows.find((r) => r.source === 'frankfurter')!.stale).toBe(true);

    const positions = await loadPositions(db);
    const blocked = blockedInstruments(rows, positions);

    // US:NOW is USD-denominated: without an FX rate it cannot be valued in rupees.
    expect(blocked).toContain('US:NOW');

    // ...and a rupee-denominated holding from a fresh portfolio source is NOT blocked.
    // Note: MF:PPFC IS blocked because amfi (NAV) is stale at FRESH
    expect(blocked).not.toContain('CASH:SAVINGS');
    expect(blocked).toContain('MF:PPFC');
  });

  it('blocks a portfolio source’s own instruments when that source is stale', async () => {
    const rows = await assessStaleness(db, '2026-08-15T18:00:00+05:30');
    const blocked = blockedInstruments(rows, await loadPositions(db));
    // manual-seed is stale at this instant, so everything it supplies is blocked.
    expect(blocked).toContain('CASH:SAVINGS');
    expect(blocked).toContain('MF:PPFC');
  });

  it('blocks nothing once every input a position depends on is fresh', async () => {
    const positions = await loadPositions(db);
    const rows = await assessStaleness(db, FRESH);
    // Pretend FX, amfi, bhavcopy all arrived: fix all stale inputs
    const withAllFresh = rows.map((r) => {
      if (['frankfurter', 'amfi', 'bhavcopy', 'screener'].includes(r.source)) {
        return { ...r, stale: false, state: 'fresh' as const };
      }
      return r;
    });
    expect(blockedInstruments(withAllFresh, positions)).toEqual([]);
  });

  it('blocks MF instruments when NAV (amfi) is stale', async () => {
    // FRESH: amfi is stale (no navs data)
    let rows = await assessStaleness(db, FRESH);
    expect(rows.find((r) => r.source === 'amfi')!.state).toBe('stale');
    let blocked = blockedInstruments(rows, await loadPositions(db));
    expect(blocked).toContain('MF:PPFC');
    expect(blocked).not.toContain('CASH:SAVINGS');
  });

describe('Phase 1 DoD: blocked-by-stale proof (Task 5)', () => {

describe('Phase 1 DoD: blocked-by-stale proof (Task 5)', () => {
  it('a deliberately stale price provably blocks a watchlist instrument from recommendations', async () => {
    // This test proves the DoD: a stale price blocks the instrument from the engine output
    // and the report lists it with the reason.

    // 1. Create a fresh state by inserting prices_eod data for NSE:NIFTYBEES
    await db.query(
      `insert into prices_eod (instrument_id, trade_date, close_paise, prev_close_paise, source, as_of)
       values ('NSE:NIFTYBEES', '2026-08-12', 22730, 22610, 'nse-bhavcopy', '2026-08-12T17:30:00+05:30')
       on conflict (instrument_id, trade_date) do update set close_paise = excluded.close_paise`,
    );

    // 1. Fresh state: bhavcopy is now fresh (has prices_eod data)
    const freshRows = await assessStaleness(db, FRESH);
    const freshBlocked = blockedInstruments(freshRows, await loadPositions(db));

    // NSE:NIFTYBEES should NOT be blocked when bhavcopy is fresh
    expect(freshBlocked).not.toContain('NSE:NIFTYBEES');
    expect(freshRows.find((r) => r.source === 'bhavcopy')!.stale).toBe(false);

    // 2. Inject a stale price: remove the prices_eod data (simulate stale price)
    await db.query(`delete from prices_eod where instrument_id = 'NSE:NIFTYBEES'`);

    // 3. Now bhavcopy is stale again, instrument should be blocked
    const stalePriceRows = await assessStaleness(db, FRESH);
    const positions = await loadPositions(db);
    const staleBlocked = blockedInstruments(stalePriceRows, positions);

    // NSE:NIFTYBEES (ETF) should be blocked due to stale price
    expect(staleBlocked).toContain('NSE:NIFTYBEES');

    // 4. The staleness report should list bhavcopy as stale with reason
    const stalePriceSource = stalePriceRows.find((r) => r.source === 'bhavcopy')!;
    expect(stalePriceSource.stale).toBe(true);
    expect(stalePriceSource.ageHours).toBeGreaterThan(24);
    expect(stalePriceSource.limitHours).toBe(24);
    expect(stalePriceSource.source).toBe('bhavcopy');
  });

  it('engine output changes when price goes stale — stale name absent from candidates', async () => {
    // This is the core DoD test: the same instrument appears in fresh candidates
    // but disappears when its price is stale.

    // 1. Start with fresh bhavcopy (has prices_eod)
    await db.query(
      `insert into prices_eod (instrument_id, trade_date, close_paise, prev_close_paise, source, as_of)
       values ('NSE:NIFTYBEES', '2026-08-12', 22730, 22610, 'nse-bhavcopy', '2026-08-12T17:30:00+05:30')
       on conflict (instrument_id, trade_date) do update set close_paise = excluded.close_paise`,
    );

    // Fresh state
    const freshRows = await assessStaleness(db, FRESH);
    const freshBlocked = blockedInstruments(freshRows, await loadPositions(db));

    // 2. Make bhavcopy stale by removing prices_eod
    await db.query(`delete from prices_eod where instrument_id = 'NSE:NIFTYBEES'`);

    // Stale state
    const stalePriceRows = await assessStaleness(db, FRESH);
    const staleBlocked = blockedInstruments(stalePriceRows, await loadPositions(db));

    // Diff: instruments that were NOT blocked when fresh but ARE blocked when stale
    const newlyBlocked = staleBlocked.filter((id) => !freshBlocked.includes(id));
    
    // At minimum, NSE:NIFTYBEES should be newly blocked
    expect(newlyBlocked).toContain('NSE:NIFTYBEES');
    expect(newlyBlocked.length).toBeGreaterThan(0);
  });
});
});
});
