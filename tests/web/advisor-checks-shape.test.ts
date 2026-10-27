import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { db, getStockChecks } from '../../web/lib/data.js';
import { seedGateStocks } from '../fixtures/stock-gate.js';

/** Piece 3 Task 3: what /advisor's "Stock checks" card renders. An unknown stays null, never 0. */
describe('getStockChecks', () => {
  it('five checks per row, each with a threshold; a blank Screener cell stays a null value', async () => {
    const d = await db();
    await runMigrations(d);
    expect(await getStockChecks()).toEqual({ asOf: null, rows: [], missingColumns: [] });

    const blank = { 'Pledged %': '', 'CFO 5Y': '' };
    await seedGateStocks(d, [{ id: 'NSE:BLANK', composite: 88, data: blank }], blank);
    const r = await getStockChecks();
    expect(r.asOf).toBe('2026-10-25');
    expect(r.rows.map((s) => s.instrumentId)).toEqual(['NSE:BLANK']);
    const [row] = r.rows;
    expect(row!.checks).toHaveLength(5);
    for (const c of row!.checks) expect(c.threshold).not.toBe('');
    expect(row!.checks.find((c) => c.check === 'pledge')).toMatchObject({ status: 'UNKNOWN', value: null });
    // Every row of the latest upload has these blank: the page names them as the cause.
    expect(r.missingColumns).toEqual(['Pledged %', 'CFO 5Y']);
    await d.close();
  });
});
