import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  aumCroreToPaise, expensePctToBps, loadMfMetadata, persistMfMetadata, CRORE_PAISE,
} from '../../src/domain/mf-metadata.js';
import { fetchMfDetails } from '../../src/sources/indmoney.js';
import type { McpClient } from '../../src/sources/mcp-client.js';

/**
 * `rankMfs` weights consistency 40 / expense 20 / tenure 15 / aum 15 / style 10, and
 * four of the five had no column anywhere. INDmoney's `get_mf_funds_details` supplies
 * expense ratio and AUM. Tenure and style drift it does not, and they stay absent
 * rather than being proxied: a component missing for EVERY fund cannot change the
 * ordering, while one present for some funds and guessed for others distorts it.
 *
 * The envelope below is the real shape, trimmed from a live call on 2026-09-21.
 */
const envelope = (funds: { id: number; aum?: number; er?: number; cat?: string }[]) => ({
  result: JSON.stringify({
    success: true,
    data: funds.map((f) => ({
      fund_id: f.id,
      data: {
        fund_detail: {
          aum: f.aum,
          expense_ratio: f.er,
          category: f.cat ?? 'flexi cap',
          benchmark_name: 'Nifty 500 TR INR',
          nav: 89.8569,
        },
      },
    })),
  }),
});

const clientReturning = (payload: unknown): McpClient =>
  ({ callTool: async () => payload } as unknown as McpClient);

describe('INDmoney fund detail units', () => {
  it('reads the expense ratio as a percent and stores basis points', () => {
    // 0.69% is PPFC's real figure; 0.25% ICICI's index fund.
    expect(expensePctToBps(0.69)).toBe(69);
    expect(expensePctToBps(0.25)).toBe(25);
    expect(expensePctToBps(1.02)).toBe(102);
  });

  it('reads AUM as rupees crore', () => {
    // Verified against known fund sizes, not the field name: ICICI Nifty 50 Index is
    // ~17,254 crore. A unit error here is invisible — every fund would still rank the
    // same relative to a wrong scale.
    expect(aumCroreToPaise(17_254)).toBe(17_254n * CRORE_PAISE);
    expect(aumCroreToPaise(1)).toBe(1_000_000_000n);
  });

  it('treats a missing or nonsense figure as unknown, never as zero', () => {
    expect(expensePctToBps(Number.NaN)).toBeNull();
    expect(aumCroreToPaise(0)).toBeNull();
    // A zero expense ratio would read as a free fund and rank it top.
    expect(expensePctToBps(-1)).toBeNull();
  });

  it('parses the real response shape', async () => {
    const rows = await fetchMfDetails(
      clientReturning(envelope([{ id: 3229, aum: 148429, er: 0.69 }])), ['3229'],
    );
    expect(rows).toEqual([{
      fundId: '3229', expenseRatioPct: 0.69, aumCrore: 148429,
      category: 'flexi cap', benchmarkName: 'Nifty 500 TR INR',
    }]);
  });

  it('leaves a fund with no figures as null rather than defaulting', async () => {
    const [row] = await fetchMfDetails(clientReturning(envelope([{ id: 1 }])), ['1']);
    expect(row!.expenseRatioPct).toBeNull();
    expect(row!.aumCrore).toBeNull();
  });

  it('refuses a changed contract instead of syncing nothing quietly', async () => {
    await expect(fetchMfDetails(clientReturning({ result: '{"success":true}' }), ['1']))
      .rejects.toThrow(/contract changed/);
    await expect(fetchMfDetails(clientReturning({ nope: 1 }), ['1']))
      .rejects.toThrow(/contract changed/);
  });

  it('surfaces a refusal by name', async () => {
    await expect(fetchMfDetails(
      clientReturning({ result: '{"error":"rate_limited","message":"slow down"}' }), ['1'],
    )).rejects.toThrow(/rate_limited/);
  });

  it('calls nothing when there are no funds to ask about', async () => {
    const client = { callTool: async () => { throw new Error('should not be called'); } };
    expect(await fetchMfDetails(client as unknown as McpClient, [])).toEqual([]);
  });
});

describe('mf_metadata storage', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await db.query(
      `insert into instruments (id, kind, name, currency, canonical_id) values
         ('MF:PPFC', 'MF', 'Parag Parikh Flexi Cap Direct', 'INR', 'MF:3229'),
         ('IND:3229', 'MF', 'Parag Parikh Flexi Cap Direct Growth', 'INR', 'MF:3229')
       on conflict (id) do nothing`,
    );
  });

  const row = (asOf: string, bps: number) => ({
    instrumentId: 'IND:3229', asOf, expenseRatioBps: bps,
    aumPaise: 148_429n * CRORE_PAISE, category: 'flexi cap',
    benchmarkName: 'Nifty 500 TR INR',
  });

  it('writes once per instrument per day', async () => {
    expect(await persistMfMetadata(db, [row('2026-09-21', 69)])).toBe(1);
    expect(await persistMfMetadata(db, [row('2026-09-21', 69)])).toBe(0);
    await db.close();
  });

  it('keeps the older figure when the expense ratio changes', async () => {
    await persistMfMetadata(db, [row('2026-01-01', 75)]);
    await persistMfMetadata(db, [row('2026-09-21', 69)]);
    const [count] = await db.query<{ n: string }>(`select count(*) as n from mf_metadata`);
    // Append-only and dated: last year's ranking was right on last year's number.
    expect(Number(count!.n)).toBe(2);
    // The loader takes the most recent.
    expect((await loadMfMetadata(db)).get('IND:3229')!.expenseRatioBps).toBe(69);
    await db.close();
  });

  it('is findable by the canonical id, not only the id it was stored under', async () => {
    await persistMfMetadata(db, [row('2026-09-21', 69)]);
    const byId = await loadMfMetadata(db);
    // AMFI keys the seed MF:* row, INDmoney the live IND:* row, and supersession retires
    // the seed one from `positions`. A caller holding either side must find this.
    expect(byId.get('IND:3229')!.expenseRatioBps).toBe(69);
    expect(byId.get('MF:3229')!.expenseRatioBps).toBe(69);
    await db.close();
  });

  it('round-trips AUM as a bigint without going through a float', async () => {
    await persistMfMetadata(db, [row('2026-09-21', 69)]);
    expect((await loadMfMetadata(db)).get('IND:3229')!.aumPaise).toBe(148_429n * CRORE_PAISE);
    await db.close();
  });
});
