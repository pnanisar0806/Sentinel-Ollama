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
 * A source with no ingestion path in Phase 0 is NOT stale data — it is an unbuilt
 * feature. Reporting amfi/bhavcopy/screener as STALE made the digest print red
 * warnings after a *successful* sync and kept a BLOCK incident permanently open,
 * which trains the owner to ignore the loudest safety signal in the product.
 */
describe('unimplemented sources are distinguished from stale ones', () => {
  it('marks amfi, bhavcopy and screener unimplemented, not stale', async () => {
    const rows = await assessStaleness(db, FRESH);
    for (const source of ['amfi', 'bhavcopy', 'screener']) {
      const row = rows.find((r) => r.source === source);
      expect(row, `${source} must still be reported`).toBeDefined();
      expect(row!.state).toBe('unimplemented');
      expect(row!.stale).toBe(false);
    }
  });

  it('raises no incident for an unimplemented source', async () => {
    await raiseIncidents(db, await assessStaleness(db, FRESH));
    const open = await db.query<{ subject: string }>(
      "select subject from incidents where kind = 'STALE_DATA' and resolved_at is null",
    );
    const subjects = open.map((r) => r.subject);
    expect(subjects).not.toContain('amfi');
    expect(subjects).not.toContain('bhavcopy');
    expect(subjects).not.toContain('screener');
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
    expect(blocked).not.toContain('CASH:SAVINGS');
    expect(blocked).not.toContain('MF:PPFC');
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
    // Pretend FX arrived: the only remaining stale inputs are unimplemented ones.
    const withFx = rows.map((r) =>
      r.source === 'frankfurter' ? { ...r, stale: false, state: 'fresh' as const } : r,
    );
    expect(blockedInstruments(withFx, positions)).toEqual([]);
  });
});
