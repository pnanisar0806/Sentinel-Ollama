import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { installIps } from '../../src/domain/ips.js';
import { monthlyReviewDone } from '../../src/domain/cadence.js';
import { persistSipSnapshot } from '../../src/domain/sips.js';
import { monthlyAdvice } from '../../src/jobs/report.js';

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
});
