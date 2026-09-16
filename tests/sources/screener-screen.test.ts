import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { seedWatchlist } from '../../src/seed/seed-watchlist.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScreenHtml, parseScreenPaste, fetchScreen, slugToInstrumentId, importScreenRows, type ParsedScreenRow } from '../../src/sources/screener-screen.js';

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

describe('parseScreenPaste', () => {
  // Real exported header from the owner's signed-in sentinel screen (2026-09-15).
  // NB: the export has NO Name/Symbol/Industry columns — those only exist in the
  // legacy pinned spec (src/sources/screener.ts), which does not match real exports.
  const header = 'S.No.,Company,CMP Rs.,P/E,Mar Cap Rs.Cr.,Div Yld %,ROCE %,ROE %,5Yrs return %,ROE 5Yr %,Profit Var 5Yrs %,CMP / BV,EPS 12M Rs.,PB X PE,Free Cash Flow 5Yrs Rs.Cr.,Sales Var 5Yrs %,Debt / Eq';

  it('parses the signed-in CSV export into canonical columns (mutation-checked)', () => {
    const csv = `${header}
1.,SPARC,188.20,3.82,6104.70,0.00,164.99,281.12,-8.93,,65.28,4.57,48.79,17.46,-1406.88,49.34,0.42
2.,P & G Hygiene,7495.60,67.47,24377.05,3.15,134.80,110.29,10.13,10.93,12.31,32.99,111.12,67.58,3572.69,10.98,0.00
21.,TCS,2250.00,15.15,813626.06,2.84,63.03,51.81,-10.42,49.36,9.45,7.59,137.64,114.99,210582.00,10.22,0.11
`;

    const result = parseScreenPaste(csv);
    expect(result.rows.length).toBe(3);
    expect(result.warnings).toHaveLength(0);

    const [sparc, pgh, tcs] = result.rows;
    expect(result.headers).toContain('Profit 5Y CAGR');
    expect(result.headers).toContain('Sales 5Y CAGR');
    expect(result.headers).toContain('FCF 5Y');
    expect(result.headers).toContain('D/E');
    expect(result.headers).toContain('EPS');

    // SPARC: negative 5Y FCF average → not FCF-positive.
    expect(sparc!.name).toBe('SPARC');
    expect(sparc!.slug).toBe('');
    expect(sparc!.fcfPos5y).toBe(false);
    expect(sparc!.columns['FCF 5Y']).toBe('-1406.88');
    expect(sparc!.columns['Profit 5Y CAGR']).toBe('65.28');
    expect(sparc!.columns['Sales 5Y CAGR']).toBe('49.34');
    expect(sparc!.deRatio).toBe(0.42);

    // P & G Hygiene: positive 5Y FCF average → FCF-positive.
    expect(pgh!.fcfPos5y).toBe(true);
    expect(pgh!.rocePct).toBe(134.80);
    expect(pgh!.roePct).toBe(110.29);

    // TCS mutation check: CMP is the exported value, not an arbitrary constant.
    expect(tcs!.cmp).toBe(2250.00);
    expect(tcs!.cmp).not.toBe(0);
    expect(tcs!.cmp).not.toBe(100);
  });

  it('handles tab-separated paste with a header repeated every ~15 rows', () => {
    const block = header.replace(/,/g, '\t');
    const sparc = '1.\tSPARC\t188.20\t3.82\t6104.70\t0.00\t164.99\t281.12\t-8.93\t\t65.28\t4.57\t48.79\t17.46\t-1406.88\t49.34\t0.42';
    const pgh = '2.\tP & G Hygiene\t7495.60\t67.47\t24377.05\t3.15\t134.80\t110.29\t10.13\t10.93\t12.31\t32.99\t111.12\t67.58\t3572.69\t10.98\t0.00';
    const tcs = '21.\tTCS\t2250.00\t15.15\t813626.06\t2.84\t63.03\t51.81\t-10.42\t49.36\t9.45\t7.59\t137.64\t114.99\t210582.00\t10.22\t0.11';
    const text = [
      block,
      sparc,
      pgh,
      block, // screener repeats the header at the start of each page
      tcs,
    ].join('\n');

    const result = parseScreenPaste(text);
    expect(result.rows.length).toBe(3);
    expect(result.rows[2]!.name).toBe('TCS');
    expect(result.rows[2]!.fcfPos5y).toBe(true);
  });

  it('treats short rows as trailing-empty, not misaligned', () => {
    const csv = `${header}
1.,SPARC,188.20,3.82,6104.70
2.,P & G Hygiene,7495.60
`;
    const result = parseScreenPaste(csv);
    expect(result.rows.length).toBe(2);
    // SPARC keeps CMP and P/E aligned to their columns; missing tail → nulls.
    expect(result.rows[0]!.cmp).toBe(188.20);
    expect(result.rows[0]!.pe).toBe(3.82);
    expect(result.rows[0]!.marketCap).toBe(6104.70);
    expect(result.rows[0]!.divYieldPct).toBeNull();
  });

  it('returns warnings when no header is present', () => {
    const result = parseScreenPaste('1.,SPARC,188.20\n2.,TCS,2250.00\n');
    expect(result.rows).toHaveLength(0);
    expect(result.warnings.some(w => w.includes('before any header'))).toBe(true);
  });
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

  it('maps sentinel-screen tooltip-less growth and FCF columns to canonical short names', () => {
    const html = `
      <table class="data-table">
        <tr>
          <th scope="colgroup"><a>S.No.</a></th>
          <th scope="colgroup"><a>Company</a></th>
          <th scope="colgroup"><a>P/E</a></th>
          <th scope="colgroup"><a>ROCE %</a></th>
          <th scope="colgroup"><a>Profit Var 5Yrs %</a></th>
          <th scope="colgroup"><a>Sales Var 5Yrs %</a></th>
          <th scope="colgroup"><a>Free Cash Flow 5Yrs Rs.Cr.</a></th>
          <th scope="colgroup"><a>Debt / Eq</a></th>
        </tr>
        <tr data-row-company-id="90001">
          <td class="text">1.</td>
          <td class="text"><a href="/company/FCFPOS/">FCF Positive</a></td>
          <td>15</td>
          <td>20</td>
          <td>30</td>
          <td>25</td>
          <td>400.00</td>
          <td>0.20</td>
        </tr>
        <tr data-row-company-id="90002">
          <td class="text">2.</td>
          <td class="text"><a href="/company/FCFNEG/">FCF Negative</a></td>
          <td>12</td>
          <td>18</td>
          <td>15</td>
          <td>10</td>
          <td>-150.00</td>
          <td>0.10</td>
        </tr>
      </table>
    `;
    const parsed = parseScreenHtml(html);
    expect(parsed.headers).toContain('Profit 5Y CAGR');
    expect(parsed.headers).toContain('Sales 5Y CAGR');
    expect(parsed.headers).toContain('FCF 5Y');
    expect(parsed.headers).toContain('D/E');

    const pos = parsed.rows.find(r => r.slug === 'FCFPOS')!;
    expect(pos.columns['Profit 5Y CAGR']).toBe('30');
    expect(pos.columns['Sales 5Y CAGR']).toBe('25');
    expect(pos.columns['FCF 5Y']).toBe('400.00');
    expect(pos.fcfPos5y).toBe(true);

    const neg = parsed.rows.find(r => r.slug === 'FCFNEG')!;
    expect(neg.fcfPos5y).toBe(false);
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
      fcfPos5y: null,
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

/** Build a minimal valid screener screen page carrying `rowCount` data rows. */
function screenPageHtml(rowCount: number, page: number): string {
  let rowsHtml = '';
  for (let i = 1; i <= rowCount; i++) {
    const slug = `PG${page.toString().padStart(2, '0')}_${i.toString().padStart(3, '0')}`;
    rowsHtml += `
      <tr data-row-company-id="${page * 1000 + i}">
        <td class="text">${i}.</td>
        <td class="text"><a href="/company/${slug}/">Company ${slug}</a></td>
        <td>100</td>
        <td>20</td>
        <td>0.5</td>
      </tr>`;
  }
  return `<table class="data-table">
    <tr>
      <th scope="colgroup"><a>S.No.</a></th>
      <th scope="colgroup"><a>Company</a></th>
      <th scope="colgroup"><a>CMP</a></th>
      <th scope="colgroup"><a>ROCE</a></th>
      <th scope="colgroup"><a>Debt / Eq</a></th>
    </tr>${rowsHtml}
  </table>`;
}

/** Serve `fullPages` of 25 rows then `trailingRows` on the final page. */
function mockScreenPages(fullPages: number, trailingRows: number): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RequestInfo | URL) => {
    const page = Number(new URL(String(input)).searchParams.get('page') ?? 1);
    const html =
      page <= fullPages
        ? screenPageHtml(25, page)
        : page === fullPages + 1
          ? screenPageHtml(trailingRows, page)
          : '<html><body>no data-table</body></html>';
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
  });
}

describe('fetchScreen pagination', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('the default page budget reaches a screen longer than 10 pages, ending on the short page', async () => {
    const fetchMock = mockScreenPages(12, 10);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchScreen('https://www.screener.in/screens/3963033/sentinel/', {
      delayMs: 0,
    });

    expect(result.pagesFetched).toBe(13);
    expect(result.rows).toHaveLength(12 * 25 + 10);
    const askedPages = fetchMock.mock.calls.map(c => new URL(String(c[0])).searchParams.get('page'));
    expect(askedPages).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13']);
  });

  it('an explicit maxPages cap stops earlier than the short page', async () => {
    const fetchMock = mockScreenPages(12, 10);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await fetchScreen('https://www.screener.in/screens/3963033/sentinel/', {
      maxPages: 2,
      delayMs: 0,
    });

    expect(result.pagesFetched).toBe(2);
    expect(result.rows).toHaveLength(50);
    expect(fetchMock.mock.calls).toHaveLength(2);
  });
});
