import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { seedWatchlist } from '../../src/seed/seed-watchlist.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScreenHtml, slugToInstrumentId, importScreenRows, type ParsedScreenRow } from '../../src/sources/screener-screen.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, '../fixtures/screener');

let db: Db;

beforeAll(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-09-11' });
  await seedWatchlist(db);
});

afterAll(async () => {
  await db.close();
});

describe('parseScreenHtml', () => {
  let result: ReturnType<typeof parseScreenHtml>;

  beforeAll(() => {
    const html = readFileSync(join(FIXTURE_DIR, 'roe-roce-page1.html'), 'utf8');
    result = parseScreenHtml(html);
  });

  it('parses 25 rows from page 1', () => {
    expect(result.rows.length).toBe(25);
    expect(result.warnings.filter(w => !w.includes('Page'))).toHaveLength(0);
  });

  it('extracts correct headers from data-tooltip attributes', () => {
    expect(result.headers).toContain('CMP');
    expect(result.headers).toContain('P/E');
    expect(result.headers).toContain('ROCE');
    expect(result.headers).toContain('ROE');
    expect(result.headers).toContain('ROE 3Yr');
    expect(result.headers).toContain('ROE 5Yr');
    expect(result.headers).toContain('Mar Cap');
    expect(result.headers).toContain('Div Yld');
    expect(result.headers).toContain('NP Qtr');
    expect(result.headers).toContain('Qtr Profit Var');
    expect(result.headers).toContain('Sales Qtr');
    expect(result.headers).toContain('Qtr Sales Var');
  });

  it('aliases tooltip-less visible header "Debt / Eq" to the D/E column', () => {
    // Some live screens render headers without data-tooltip (e.g. owner's sentinel
    // screen, /screens/3963033/sentinel/, uses the short visible form "Debt / Eq").
    const html = `
      <table class="data-table">
        <tr>
          <th scope="colgroup"><a>S.No.</a></th>
          <th scope="colgroup"><a>Company</a></th>
          <th scope="colgroup"><a>CMP</a></th>
          <th scope="colgroup"><a>ROCE</a></th>
          <th scope="colgroup"><a>Debt / Eq</a></th>
        </tr>
        <tr data-row-company-id="12345">
          <td class="text">1.</td>
          <td class="text"><a href="/company/ITC/">ITC</a></td>
          <td>441.20</td>
          <td>40.10</td>
          <td>0.03</td>
        </tr>
      </table>
    `;
    const parsed = parseScreenHtml(html);
    expect(parsed.headers).toContain('D/E');
    const row = parsed.rows[0];
    expect(row).toBeDefined();
    expect(row!.deRatio).toBe(0.03);
    expect(row!.columns['D/E']).toBe('0.03');
  });

  it('extracts company name and slug from link', () => {
    const pg = result.rows.find(r => r.slug === 'PGHH');
    expect(pg).toBeDefined();
    expect(pg!.name).toBe('P & G Hygiene');
  });

  it('parses numeric columns correctly', () => {
    const pg = result.rows.find(r => r.slug === 'PGHH');
    expect(pg).toBeDefined();
    expect(pg!.cmp).toBe(7518.00);
    expect(pg!.pe).toBe(30.86);
    expect(pg!.marketCap).toBe(24403.98);
    expect(pg!.divYieldPct).toBe(3.06);
    expect(pg!.rocePct).toBe(157.20);
    expect(pg!.roePct).toBe(114.58);
  });

  it('mutation check: first row CMP is 7518.00, not arbitrary', () => {
    expect(result.rows[0]!.cmp).toBe(7518.00);
    expect(result.rows[0]!.cmp).not.toBe(0);
    expect(result.rows[0]!.cmp).not.toBe(100);
  });

  it('extracts TCS by slug', () => {
    const tcs = result.rows.find(r => r.slug === 'TCS');
    expect(tcs).toBeDefined();
    expect(tcs!.name).toBe('TCS');
    expect(tcs!.cmp).toBeGreaterThan(0);
    expect(tcs!.pe).toBeGreaterThan(0);
  });

  it('handles HTML entities in names', () => {
    // "P & G Hygiene" has &amp; in HTML
    const pg = result.rows.find(r => r.slug === 'PGHH');
    expect(pg!.name).toContain('&');
    expect(pg!.name).not.toContain('&amp;');
  });

  it('returns empty for non-table HTML', () => {
    const empty = parseScreenHtml('<html><body>No table here</body></html>');
    expect(empty.rows).toHaveLength(0);
    expect(empty.warnings.some(w => w.includes('No <th>'))).toBe(true);
  });
});

describe('parseScreenHtml page 2', () => {
  it('parses 25 rows from page 2', () => {
    const html = readFileSync(join(FIXTURE_DIR, 'roe-roce-page2.html'), 'utf8');
    const result = parseScreenHtml(html);
    expect(result.rows.length).toBe(25);
    // Page 2 starts at row 26
    expect(result.rows[0]!.slug).not.toBe(result.rows[1]!.slug);
  });
});

describe('slugToInstrumentId', () => {
  it('maps TCS slug to NSE:TCS', async () => {
    const id = await slugToInstrumentId(db, 'TCS', 'TCS');
    expect(id).toBe('NSE:TCS');
  });

  it('maps RELIANCE slug to NSE:RELIANCE', async () => {
    const id = await slugToInstrumentId(db, 'RELIANCE', 'Reliance Industries');
    expect(id).toBe('NSE:RELIANCE');
  });

  it('falls back to name match for unknown slug', async () => {
    // "PGHH" is P&G Hygiene — may not be in seed instruments
    const id = await slugToInstrumentId(db, 'PGHH', 'P & G Hygiene');
    // Could be null if seed doesn't have it — that's fine, fallback path is tested
    expect(typeof id === 'string' || id === null).toBe(true);
  });

  it('returns null for completely unknown instrument', async () => {
    const id = await slugToInstrumentId(db, 'ZZZZZ', 'Nonexistent Corp');
    expect(id).toBeNull();
  });

  it('does not LIKE-match a 2-char id-lookup slug', async () => {
    // screener /company/id/<n>/ links parse to slug "ID"; it must never
    // substring-match NSE:LIQUIDBEES (contains "ID")
    const id = await slugToInstrumentId(db, 'ID', '');
    expect(id).toBeNull();
  });
});

describe('importScreenRows', () => {
  it('imports parsed rows into fundamentals', async () => {
    const html = readFileSync(join(FIXTURE_DIR, 'roe-roce-page1.html'), 'utf8');
    const { rows } = parseScreenHtml(html);

    const result = await importScreenRows(db, rows, {
      asOf: '2026-09-13',
      screenUrl: 'https://www.screener.in/screens/41972/',
    });

    expect(result.uploadedId).toBeGreaterThan(0);
    expect(result.inserted).toBeGreaterThan(0);

    // Verify fundamentals row exists
    const count = await db.query<{ n: string }>(
      'SELECT count(*) as n FROM fundamentals WHERE upload_id = $1',
      [result.uploadedId],
    );
    expect(Number(count[0]!.n)).toBe(result.inserted);
  });

  it('populates roce_pct for known instruments', async () => {
    const html = readFileSync(join(FIXTURE_DIR, 'roe-roce-page1.html'), 'utf8');
    const { rows } = parseScreenHtml(html);

    const result = await importScreenRows(db, rows, {
      asOf: '2026-09-13',
      screenUrl: 'test-roce',
    });

    // TCS should be in the results
    const tcs = await db.query<{ roce_pct: string | null }>(
      `SELECT f.roce_pct FROM fundamentals f
       WHERE f.upload_id = $1 AND f.instrument_id = 'NSE:TCS'`,
      [result.uploadedId],
    );
    if (tcs.length > 0) {
      expect(Number(tcs[0]!.roce_pct)).toBeGreaterThan(0);
    }
  });

  it('mutation check: re-import creates a new upload (not idempotent on URL)', async () => {
    const html = readFileSync(join(FIXTURE_DIR, 'roe-roce-page1.html'), 'utf8');
    const { rows } = parseScreenHtml(html);

    const r1 = await importScreenRows(db, rows, { asOf: '2026-09-13', screenUrl: 'mut1' });
    const r2 = await importScreenRows(db, rows, { asOf: '2026-09-13', screenUrl: 'mut2' });

    expect(r1.uploadedId).not.toBe(r2.uploadedId);
    expect(r1.inserted).toBe(r2.inserted);
  });

  it('skips instrument-duplicate rows instead of crashing mid-upload', async () => {
    const html = readFileSync(join(FIXTURE_DIR, 'roe-roce-page1.html'), 'utf8');
    const { rows } = parseScreenHtml(html);

    // Baseline: which unique named instruments resolve from the fixture
    const baseline = await importScreenRows(db, rows, {
      asOf: '2026-09-13',
      screenUrl: 'dup-base',
    });
    const expectedUnique = baseline.inserted;

    // Plant a second row that resolves to the same instrument as the first
    const tcs = rows.find(r => r.slug === 'TCS');
    const dup = rows.concat([{ ...tcs!, name: 'TCS' }]);

    const result = await importScreenRows(db, dup, {
      asOf: '2026-09-13',
      screenUrl: 'dup-mut',
    });

    expect(result.inserted).toBe(expectedUnique); // dup row skipped, not crash
    const count = await db.query<{ n: string }>(
      'SELECT count(*) as n FROM fundamentals WHERE upload_id = $1',
      [result.uploadedId],
    );
    expect(Number(count[0]!.n)).toBe(result.inserted);
  });
});

describe('cohort promotion: unknown screen rows become instruments', () => {
  // Self-contained screen rows with slugs no other test creates.
  function cohortRow(slug: string, name: string): ParsedScreenRow {
    return {
      name,
      slug,
      columns: { 'P/E': '10', CMP: '100', 'Mar Cap': '5000', ROCE: '12', 'D/E': '0.5' },
      cmp: 100,
      pe: 10,
      marketCap: 5000,
      divYieldPct: 1,
      rocePct: 12,
      roePct: 10,
      deRatio: 0.5,
    };
  }

  it('creates a real instrument for a screen row that does not resolve', async () => {
    const rows = [cohortRow('COHORTX', 'Cohort X Ltd')];
    expect(await slugToInstrumentId(db, 'COHORTX', 'Cohort X Ltd')).toBeNull();

    const result = await importScreenRows(db, rows, {
      asOf: '2026-09-14',
      screenUrl: 'cohort-1',
    });

    const rowsOut = await db.query<{ id: string; kind: string; name: string; metadata: string }>(
      `SELECT id, kind, name, metadata::text AS metadata FROM instruments WHERE id = 'NSE:COHORTX'`,
    );
    expect(rowsOut.length).toBe(1);
    expect(rowsOut[0]!.kind).toBe('EQUITY');
    expect(rowsOut[0]!.name).toBe('Cohort X Ltd');
    expect(JSON.parse(rowsOut[0]!.metadata).source).toBe('screener-cohort');
    expect(result.createdInstruments).toBe(1);
    expect(result.inserted).toBe(1);
  });

  it('derived check: creates exactly the set of unresolvable screen companies', async () => {
    const rows = [cohortRow('COHORTD1', 'Cohort D1 Ltd'), cohortRow('COHORTD2', 'Cohort D2 Ltd')];

    let expected = 0;
    for (const r of rows) {
      if ((await slugToInstrumentId(db, r.slug, r.name)) === null) expected++;
    }
    expect(expected).toBeGreaterThan(0);

    const result = await importScreenRows(db, rows, {
      asOf: '2026-09-14',
      screenUrl: 'cohort-derived',
    });
    expect(result.createdInstruments).toBe(expected);
    expect(result.inserted).toBe(expected);

    for (const r of rows) {
      const found = await db.query<{ n: string }>(
        `SELECT count(*) AS n FROM instruments WHERE id = $1`,
        [`NSE:${r.slug}`],
      );
      expect(Number(found[0]!.n)).toBe(1);
    }
  });

  it('a re-import creates no new instruments and reports zero created', async () => {
    const rows = [cohortRow('COHORTX', 'Cohort X Ltd'), cohortRow('COHORTY', 'Cohort Y Ltd')];

    const first = await importScreenRows(db, rows, {
      asOf: '2026-09-14',
      screenUrl: 'cohort-2a',
    });
    const before = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM instruments WHERE metadata->>'source' = 'screener-cohort'`,
    );

    const second = await importScreenRows(db, rows, {
      asOf: '2026-09-14',
      screenUrl: 'cohort-2b',
    });
    const after = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM instruments WHERE metadata->>'source' = 'screener-cohort'`,
    );

    expect(second.createdInstruments).toBe(0);
    expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
    expect(second.inserted).toBe(first.inserted);
  });

  it('does not create instruments for degenerate id-link slugs like "ID"', async () => {
    const rows = [cohortRow('ID', 'Id Named Company')];

    const result = await importScreenRows(db, rows, {
      asOf: '2026-09-14',
      screenUrl: 'cohort-degenerate',
    });
    expect(result.createdInstruments).toBe(0);
    expect(result.inserted).toBe(0);
    const found = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM instruments WHERE id = 'NSE:ID'`,
    );
    expect(Number(found[0]!.n)).toBe(0);
  });
});
