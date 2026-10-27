import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { rawNumber } from '../../src/domain/engine.js';
import {
  awaitingGovernance, evaluateChecks, isPassed, loadStockChecks, uploadSectorPe,
  type CheckName, type CheckResult, type StockCheckInput,
} from '../../src/domain/stock-checks.js';

/** All five pass. Each test below changes one field. */
const clean = (): StockCheckInput => ({
  sector: 'Chemicals',
  deRatio: 0.2,
  pledgedPct: 0,
  eps: 10,
  close: { pricePaise: 20_000n, asOf: '2026-10-23' }, // ₹200 / EPS 10 = P/E 20
  asOf: '2026-10-26',
  sectorPe: { median: 20, peers: 11 },
  profit5yCagrPct: 18,
  sales5yCagrPct: 15,
  cfo5y: 90,
  pat5y: 100,
  promoterDropPp: 0,
  governance: { status: 'CLEAR', events: [], checkedAt: '2026-10-20T00:00:00.000Z' },
  uploadAsOf: '2026-10-20',
});

const status = (i: StockCheckInput, check: CheckName) =>
  evaluateChecks(i).find((c) => c.check === check)!.status;

describe('evaluateChecks', () => {
  it('the clean input passes all five, in order', () => {
    const r = evaluateChecks(clean());
    expect(r.map((c) => c.check)).toEqual(['debt', 'pledge', 'valuation', 'growth', 'management']);
    expect(r.map((c) => c.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
    for (const c of r) expect(c.threshold).not.toBe('');
  });

  it('debt: D/E of 1 fails, 0.99 passes, unknown is UNKNOWN', () => {
    expect(status({ ...clean(), deRatio: 1 }, 'debt')).toBe('FAIL');
    expect(status({ ...clean(), deRatio: 0.99 }, 'debt')).toBe('PASS');
    expect(status({ ...clean(), deRatio: null }, 'debt')).toBe('UNKNOWN');
  });

  it('debt: a finance sector is waived, and says so', () => {
    const debt = evaluateChecks({ ...clean(), sector: 'Banking', deRatio: null })[0]!;
    expect(debt.status).toBe('PASS');
    expect(debt.value).toMatch(/waived/i);
  });

  it('pledge: any pledge fails, zero passes, unknown is UNKNOWN', () => {
    expect(status({ ...clean(), pledgedPct: 0.01 }, 'pledge')).toBe('FAIL');
    expect(status({ ...clean(), pledgedPct: 0 }, 'pledge')).toBe('PASS');
    expect(status({ ...clean(), pledgedPct: null }, 'pledge')).toBe('UNKNOWN');
  });

  describe('valuation', () => {
    const at150 = (median: number): StockCheckInput =>
      ({ ...clean(), eps: 1, close: { pricePaise: 15_000n, asOf: '2026-10-23' }, sectorPe: { median, peers: 11 } });

    it('exactly 1.5 × the sector median passes; above it fails', () => {
      expect(status(at150(100), 'valuation')).toBe('PASS');
      expect(status(at150(99), 'valuation')).toBe('FAIL');
    });

    it('fewer than 5 peers, or no sector, is UNKNOWN', () => {
      expect(status({ ...clean(), sectorPe: { median: 20, peers: 4 } }, 'valuation')).toBe('UNKNOWN');
      expect(status({ ...clean(), sector: null }, 'valuation')).toBe('UNKNOWN');
      expect(status({ ...clean(), sectorPe: null }, 'valuation')).toBe('UNKNOWN');
    });

    it('a close older than 5 days is UNKNOWN, never a P/E from an old price', () => {
      expect(status({ ...clean(), close: { pricePaise: 20_000n, asOf: '2026-10-21' } }, 'valuation')).toBe('PASS');
      expect(status({ ...clean(), close: { pricePaise: 20_000n, asOf: '2026-10-20' } }, 'valuation')).toBe('UNKNOWN');
      expect(status({ ...clean(), close: null }, 'valuation')).toBe('UNKNOWN');
    });

    it('loss-making (EPS ≤ 0) fails; missing EPS is UNKNOWN', () => {
      expect(status({ ...clean(), eps: -2 }, 'valuation')).toBe('FAIL');
      expect(status({ ...clean(), eps: 0 }, 'valuation')).toBe('FAIL');
      expect(status({ ...clean(), eps: null }, 'valuation')).toBe('UNKNOWN');
    });

    it('states the P/E, sector median and peers', () => {
      const v = evaluateChecks(clean())[2]!;
      expect(v.value).toBe('P/E 20.0 vs Chemicals median 20.0 (11 peers)');
      expect(v.asOf).toBe('2026-10-23');
    });
  });

  it('growth: either leg below 12% fails; a known failure beats an unknown', () => {
    expect(status({ ...clean(), profit5yCagrPct: 11.9 }, 'growth')).toBe('FAIL');
    expect(status({ ...clean(), sales5yCagrPct: 11.9 }, 'growth')).toBe('FAIL');
    expect(status({ ...clean(), profit5yCagrPct: 12, sales5yCagrPct: 12 }, 'growth')).toBe('PASS');
    expect(status({ ...clean(), profit5yCagrPct: null, sales5yCagrPct: 20 }, 'growth')).toBe('UNKNOWN');
    expect(status({ ...clean(), profit5yCagrPct: null, sales5yCagrPct: 5 }, 'growth')).toBe('FAIL');
  });

  describe('management', () => {
    it('cash from operations below 70% of profit fails; exactly 70% passes', () => {
      expect(status({ ...clean(), cfo5y: 69, pat5y: 100 }, 'management')).toBe('FAIL');
      expect(status({ ...clean(), cfo5y: 70, pat5y: 100 }, 'management')).toBe('PASS');
      expect(status({ ...clean(), cfo5y: null }, 'management')).toBe('UNKNOWN');
      // Screener's ₹ Cr figures carry two decimals; float arithmetic misjudges exact 70% here
      // (0.7 × 8.3 = 5.8100000000000005, 5.81 × 10 < 8.3 × 7).
      expect(status({ ...clean(), cfo5y: 5.81, pat5y: 8.3 }, 'management')).toBe('PASS');
      expect(status({ ...clean(), cfo5y: 0.77, pat5y: 1.1 }, 'management')).toBe('PASS');
      expect(status({ ...clean(), cfo5y: 5.8, pat5y: 8.3 }, 'management')).toBe('FAIL');
    });

    it('a loss over five years (PAT 5Y ≤ 0) fails the cash-flow leg, whatever CFO is', () => {
      const lossy = evaluateChecks({ ...clean(), cfo5y: -50, pat5y: -100 })[4]!;
      expect(lossy.status).toBe('FAIL');
      expect(lossy.value).toMatch(/loss-making over 5 years \(PAT 5y ≤ 0\)/);
      expect(status({ ...clean(), cfo5y: 10, pat5y: 0 }, 'management')).toBe('FAIL');
    });

    it('a promoter drop over 5 pp fails; 5 passes; unknown is UNKNOWN', () => {
      expect(status({ ...clean(), promoterDropPp: 5.1 }, 'management')).toBe('FAIL');
      expect(status({ ...clean(), promoterDropPp: 5 }, 'management')).toBe('PASS');
      expect(status({ ...clean(), promoterDropPp: null }, 'management')).toBe('UNKNOWN');
    });

    it('a governance event fails; an unchecked record is UNKNOWN', () => {
      const event = { on: '2025-01-02', kind: 'auditor_resignation' as const, headline: 'Resignation of statutory auditor' };
      expect(status({ ...clean(), governance: { status: 'EVENT', events: [event], checkedAt: '2026-10-20T00:00:00.000Z' } }, 'management')).toBe('FAIL');
      expect(status({ ...clean(), governance: { status: 'UNCHECKED', events: [], checkedAt: null } }, 'management')).toBe('UNKNOWN');
      // A stale backfill reports UNCHECKED, but an event already on file is still a failure.
      expect(status({ ...clean(), governance: { status: 'UNCHECKED', events: [event], checkedAt: null } }, 'management')).toBe('FAIL');
    });
  });
});

describe('rawNumber', () => {
  it('a blank cell is unknown, never 0 (a blank Pledged % must not pass)', () => {
    expect(rawNumber({ 'Pledged %': '' }, 'Pledged %')).toBeNull();
    expect(rawNumber({ 'Pledged %': '  ' }, 'Pledged %')).toBeNull();
    expect(rawNumber({ 'Pledged %': '0.00' }, 'Pledged %')).toBe(0);
    expect(rawNumber({ 'Mar Cap': '1,234.5' }, 'Mar Cap')).toBe(1234.5);
  });
});

describe('isPassed', () => {
  const all = evaluateChecks(clean());
  it('needs quality, composite ≥ 85 and five PASSes; one UNKNOWN is a no even at 90', () => {
    expect(isPassed(true, 90, all)).toBe(true);
    const oneUnknown: CheckResult[] = all.map((c) => (c.check === 'pledge' ? { ...c, status: 'UNKNOWN' } : c));
    expect(isPassed(true, 90, oneUnknown)).toBe(false);
    expect(isPassed(true, 84.99, all)).toBe(false);
    expect(isPassed(true, null, all)).toBe(false);
    expect(isPassed(false, 90, all)).toBe(false);
  });
});

describe('loaders (PGlite)', () => {
  let db: Db;
  const AS_OF = '2026-10-26';

  async function upload(asOf: string, rows: [string, Record<string, string>][]) {
    const [u] = await db.query<{ id: number }>(
      `insert into screener_uploads (as_of, filename, source) values ($1, $2, 'screener-screen') returning id`,
      [asOf, `t-${asOf}`],
    );
    for (const [id, data] of rows) {
      await db.query(`insert into fundamentals (upload_id, instrument_id, data, de_ratio) values ($1, $2, $3, 0.1)`,
        [u!.id, id, JSON.stringify(data)]);
    }
  }
  const close = (id: string, date: string, paise: number) => db.query(
    `insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of) values ($1, $2, $3, 'nse-bhavcopy', now())`,
    [id, date, paise]);

  beforeAll(async () => {
    db = await openDb();
    await runMigrations(db);
    // Six Chemicals stocks, P/E 10..60; a seventh with a stale close and an eighth loss-making — both skipped.
    for (let n = 1; n <= 8; n++) {
      await db.query(`insert into instruments (id, kind, name, currency, sector) values ($1, 'EQUITY', $2, 'INR', 'Chemicals')`,
        [`NSE:C${n}`, `Chem ${n}`]);
    }
    for (let n = 1; n <= 6; n++) await close(`NSE:C${n}`, '2026-10-23', n * 1000 * 100); // ₹1000n, EPS 100 → P/E 10n
    await close('NSE:C7', '2026-10-19', 500_000); // 7 days old
    await close('NSE:C8', '2026-10-23', 500_000);

    // OLD's only earlier reading is three years back: no year-ago reading, so its drop is unknown.
    await db.query(`insert into instruments (id, kind, name, currency) values ('NSE:OLD', 'EQUITY', 'Old Ltd', 'INR')`);
    await upload('2023-10-01', [['NSE:OLD', { 'Promoter Holding': '70.00' }]]);
    // 2025-10-05 is 380 days before the 2026-10-20 upload: inside the 365–400 day window.
    await upload('2025-10-05', [['NSE:C1', { 'Promoter Holding': '60.00' }], ['NSE:C2', { 'Promoter Holding': '50.00' }]]);
    await upload('2026-05-01', [['NSE:C1', { 'Promoter Holding': '54.50' }], ['NSE:C2', { 'Promoter Holding': '49.00' }]]);
    const rows: [string, Record<string, string>][] = [];
    for (let n = 1; n <= 7; n++) rows.push([`NSE:C${n}`, { EPS: '100', 'Promoter Holding': n === 1 ? '54.00' : '48.00' }]);
    rows[1]![1]['Promoter Chg 1Y'] = '-1.00'; // C2: Screener's own 1Y change wins over 50 → 48
    Object.assign(rows[1]![1], { 'Pledged %': '0', 'Profit 5Y CAGR': '20', 'Sales 5Y CAGR': '15' });
    rows.push(['NSE:C8', { EPS: '-3' }]);
    rows.push(['NSE:OLD', { 'Promoter Holding': '50.00' }]);
    await upload('2026-10-20', rows);

    // Only C1 and C2 are watched and scored.
    for (const id of ['NSE:C1', 'NSE:C2']) {
      await db.query(`insert into watchlist (instrument_id, added_on, source, reason) values ($1, '2026-01-01', 'advisor', 't')`, [id]);
      await db.query(`insert into signal_scores (instrument_id, score_date, composite, quality_passed) values ($1, '2026-10-25', $2, true)`,
        [id, id === 'NSE:C1' ? 80 : 90]);
    }
    await db.query(`insert into signal_scores (instrument_id, score_date, composite, quality_passed) values ('NSE:OLD', '2026-10-25', 70, true)`);
  });
  afterAll(async () => { await db.close(); });

  it('uploadSectorPe takes every fresh, profitable stock in the latest upload, not the watchlist', async () => {
    const m = await uploadSectorPe(db, AS_OF);
    expect(m.get('Chemicals')).toEqual({ median: 35, peers: 6 }); // median of 10..60
  });

  it('loadStockChecks: promoter drop over a year from the uploads, preferring Promoter Chg 1Y', async () => {
    const r = await loadStockChecks(db, AS_OF, new Date('2026-10-26T06:00:00Z'));
    expect(r.map((s) => s.instrumentId)).toEqual(['NSE:C2', 'NSE:C1', 'NSE:OLD']); // composite descending
    const mgmt = (id: string) => r.find((s) => s.instrumentId === id)!.checks[4]!;
    // OLD: 70 → 50 would be a 20 pp drop, but over three years, not one → UNKNOWN, and says why.
    expect(mgmt('NSE:OLD').status).toBe('UNKNOWN');
    expect(mgmt('NSE:OLD').value).toMatch(/no reading ~1 year earlier/);
    // C1: 60.00 (2025-10-05, 380 days before) → 54.00 = 6 pp drop → FAIL. The 2026-05-01 upload is too recent.
    expect(mgmt('NSE:C1').status).toBe('FAIL');
    expect(mgmt('NSE:C1').value).toMatch(/6\.0 pp/);
    // C2: Promoter Chg 1Y −1 beats 50 → 48; governance unchecked and CFO/PAT absent → UNKNOWN, not FAIL.
    expect(mgmt('NSE:C2').status).toBe('UNKNOWN');
    expect(mgmt('NSE:C2').value).toMatch(/1\.0 pp/);
    // Valuation: C2 P/E 20 vs median 35 over 6 peers.
    const c2 = r.find((s) => s.instrumentId === 'NSE:C2')!;
    expect(c2.checks[2]).toMatchObject({ status: 'PASS', value: 'P/E 20.0 vs Chemicals median 35.0 (6 peers)' });
    expect(c2.composite).toBe(90);
    expect(c2.checks.slice(0, 4).map((c) => c.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS']);
    expect(c2.passed).toBe(false); // management unknown
  });

  it('awaitingGovernance: HIGH band, four checks pass, governance unchecked', async () => {
    // C1 is below the HIGH band (80) and fails pledge (unknown); only C2 is worth a backfill.
    expect(await awaitingGovernance(db, AS_OF, new Date('2026-10-26T06:00:00Z'))).toEqual(['NSE:C2']);
  });
});
