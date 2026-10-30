import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { installIps } from '../../src/domain/ips.js';
import { monthlyReviewDone } from '../../src/domain/cadence.js';
import { persistSipSnapshot } from '../../src/domain/sips.js';
import { monthlyAdvice } from '../../src/jobs/report.js';
import { confirmBudget } from '../../src/domain/controls.js';
import { awaitingGovernance } from '../../src/domain/stock-checks.js';
import { GATE_AS_OF, GATE_NOW, seedGateStocks } from '../fixtures/stock-gate.js';

/**
 * Owner decision 2026-10-15: a purchase withheld because SIPs are unknown must not consume
 * the month. The rebalance holds (holdRebalance); the advisor must hold too — no model call,
 * no advice row, and the 'advice' month left open for the next weekly run.
 */
const AS_OF = '2026-10-18';
const NOW = '2026-10-18T05:00:00.000Z';

let db: Db;
let calls: number;
const fetchImpl = (async () => { calls++; return new Response('{}', { status: 500 }); }) as unknown as typeof fetch;
const advised = async () => (await db.query(`select 1 from advisor_proposals where kind = 'ADVISE'`)).length;
beforeEach(async () => { db = await openDb(); await runMigrations(db); await installIps(db); calls = 0; });

describe('monthlyAdvice', () => {
  it('a DB error reading whether the month is done fails soft: no line, the weekly report still sends', async () => {
    const broken = {
      query: async (sql: string, params?: unknown[]) => { if (sql.includes("'monthly_review'")) throw new Error('db down'); return db.query(sql, params); },
      exec: (sql: string) => db.exec(sql), withTransaction: db.withTransaction.bind(db), close: () => db.close(),
    } as Db;
    expect(await monthlyAdvice(broken, AS_OF, NOW, { apiKey: 'k', model: undefined, fetchImpl })).toBe('');
    await db.close();
  });

  it('no SIP snapshot: the advisor is held, not called, and the month stays open', async () => {
    const line = await monthlyAdvice(db, AS_OF, NOW, { apiKey: 'k', model: undefined, fetchImpl });
    expect(calls).toBe(0);
    expect(await advised()).toBe(0);
    expect(await monthlyReviewDone(db, 'advice', '2026-10')).toBe(false);
    expect(line).toMatch(/^\n\nAdvisor \(2026-10\): held — /);
    expect(line).toMatch(/never synced/);
    await db.close();
  });

  it('a fresh snapshot: the advisor runs and the month is recorded', async () => {
    await persistSipSnapshot(db, [], NOW);
    const line = await monthlyAdvice(db, AS_OF, NOW, { apiKey: 'k', model: undefined, fetchImpl });
    expect(await advised()).toBe(1);
    expect(await monthlyReviewDone(db, 'advice', '2026-10')).toBe(true);
    expect(line).toMatch(/^\n\nAdvisor \(2026-10\): NO_ACTION\./);
    await db.close();
  });

  it('a known ₹0 envelope is an answer: the advisor runs and the month is recorded', async () => {
    await persistSipSnapshot(db, [], NOW);
    await db.query(`insert into settings_rails (key, value) values ('monthly_budget_paise', '0'::jsonb)
                    on conflict (key) do update set value = excluded.value`);
    await monthlyAdvice(db, AS_OF, NOW, { apiKey: 'k', model: undefined, fetchImpl });
    expect(await advised()).toBe(1);
    expect(await monthlyReviewDone(db, 'advice', '2026-10')).toBe(true);
    await db.close();
  });

  describe('governance backfill before sizing (Piece 3 Task 3)', () => {
    const ids = ['NSE:GATEX', 'NSE:GATEY'];
    let urls: string[];
    /** BSE stub: a 1000-row scrip list carrying both stocks, and announcements answered with `annStatus`. */
    const bse = (annStatus: number) => (async (url: string) => {
      urls.push(url);
      if (url.includes('ListofScripData')) {
        const rows = [...Array.from({ length: 1000 }, (_, n) => ({ SCRIP_CD: String(100000 + n), scrip_id: `FILL${n}` })),
          ...ids.map((id, n) => ({ SCRIP_CD: String(900000 + n), scrip_id: id.slice(4) }))];
        return new Response(JSON.stringify(rows), { status: 200 });
      }
      return new Response(JSON.stringify({ Table: [] }), { status: annStatus });
    }) as unknown as typeof fetch;
    const snapshot = async () => JSON.stringify((await db.query<{ input_snapshot: unknown }>(
      `select input_snapshot from advisor_proposals where kind = 'ADVISE'`))[0]!.input_snapshot);
    const runs = (id: string) => db.query<{ state: string }>(`select state from news_fetch_runs where instrument_id = $1`, [id]);

    beforeEach(async () => {
      urls = [];
      await seedGateStocks(db, ids.map((id) => ({ id, composite: 90 })));
      await persistSipSnapshot(db, [], GATE_NOW.toISOString());
    });

    it('each awaiting stock gets exactly one backfill, the scrip list is fetched once, and it then reaches the advisor', async () => {
      expect(await awaitingGovernance(db, GATE_AS_OF, GATE_NOW)).toEqual(ids);
      await monthlyAdvice(db, GATE_AS_OF, GATE_NOW.toISOString(), { apiKey: undefined, model: undefined, fetchImpl: bse(200) });
      for (const id of ids) expect(await runs(id)).toEqual([{ state: 'success_empty' }]);
      expect(urls.filter((u) => u.includes('ListofScripData'))).toHaveLength(1);
      const snap = await snapshot();
      for (const id of ids) expect(snap).toContain(`${id.slice(4)} Ltd`);
      await db.close();
    });

    it('a failed backfill leaves the stock out of the advisor snapshot', async () => {
      await monthlyAdvice(db, GATE_AS_OF, GATE_NOW.toISOString(), { apiKey: undefined, model: undefined, fetchImpl: bse(500) });
      for (const id of ids) expect(await runs(id)).toEqual([{ state: 'failed' }]);
      const snap = await snapshot();
      for (const id of ids) expect(snap).not.toContain(id.slice(4));
      await db.close();
    });
  });

  it('IST days 1–7 without a budget confirmation: held before the SIP check, month open; it runs once settled', async () => {
    const early = '2026-11-03T05:00:00.000Z';
    const line = await monthlyAdvice(db, '2026-11-03', early, { apiKey: 'k', model: undefined, fetchImpl });
    expect(line).toBe("\n\nAdvisor (2026-11): held — waiting for this month's budget (until the 7th).");
    expect(calls).toBe(0);
    expect(await advised()).toBe(0);
    expect(await monthlyReviewDone(db, 'advice', '2026-11')).toBe(false);

    await confirmBudget(db, new Date(early));
    await persistSipSnapshot(db, [], early);
    const next = await monthlyAdvice(db, '2026-11-03', early, { apiKey: 'k', model: undefined, fetchImpl });
    expect(next).toMatch(/^\n\nAdvisor \(2026-11\): NO_ACTION\./);
    expect(await monthlyReviewDone(db, 'advice', '2026-11')).toBe(true);
    await db.close();
  });
});
