import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { assessStaleness, lastCompletedTradingDay } from '../../src/sources/staleness.js';

/**
 * FR-31 blocked every equity, ETF and bond position every weekend, because freshness was
 * measured in wall-clock hours against sources that only publish on trading days. NSE
 * closes Friday; by Sunday its close is ~58h old against a 24h limit, so `bhavcopy` read
 * stale and 39 instruments were blocked — on the very morning `weekly.yml` runs the deep
 * report (04:30 UTC Sunday), which skips blocked instruments when building
 * recommendations.
 *
 * Dates below are real: 2026-09-18 is a Friday, 2026-09-19 a Saturday, 2026-09-20 a
 * Sunday, 2026-09-21 a Monday.
 */
describe('staleness against the trading calendar', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
  });

  const seedFridayClose = async () => {
    await db.query(
      `insert into instruments (id, kind, name, currency) values ('NSE:T', 'EQUITY', 'T', 'INR')
       on conflict (id) do nothing`,
    );
    await db.query(
      `insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of)
       values ('NSE:T', date '2026-09-18', 10000, 'nse-bhavcopy', timestamptz '2026-09-18T12:00:00Z')`,
    );
  };

  const bhavcopy = async (nowIso: string) =>
    (await assessStaleness(db, nowIso)).find((r) => r.source === 'bhavcopy');

  it('skips the weekend when finding the last completed session', async () => {
    // Sunday -> Friday, not Saturday.
    expect(await lastCompletedTradingDay(db, '2026-09-20T04:30:00Z')).toBe('2026-09-18');
    expect(await lastCompletedTradingDay(db, '2026-09-19T09:00:00Z')).toBe('2026-09-18');
    // Monday -> Friday, because Monday's own close has not happened yet.
    expect(await lastCompletedTradingDay(db, '2026-09-21T09:00:00Z')).toBe('2026-09-18');
    await db.close();
  });

  it('is FRESH on Sunday with only Friday data — the bug this fixes', async () => {
    await seedFridayClose();
    const row = await bhavcopy('2026-09-20T04:30:00Z');
    expect(row?.stale, 'Friday close on a Sunday must not be stale').toBe(false);
    // The age is genuinely past the wall-clock limit; that is precisely the point.
    expect(row!.ageHours).toBeGreaterThan(row!.limitHours);
    await db.close();
  });

  it('is fresh on Saturday and on Monday morning too', async () => {
    await seedFridayClose();
    expect((await bhavcopy('2026-09-19T09:00:00Z'))?.stale).toBe(false);
    expect((await bhavcopy('2026-09-21T09:00:00Z'))?.stale).toBe(false);
    await db.close();
  });

  it('still catches a genuine drought — Friday data read on Wednesday', async () => {
    await seedFridayClose();
    // By Wednesday, Monday and Tuesday both closed with no data. That is a real failure
    // and must still block, or the fix would have disabled the gate rather than fixed it.
    const row = await bhavcopy('2026-09-23T09:00:00Z');
    expect(row?.stale).toBe(true);
    await db.close();
  });

  it('treats a seeded market holiday as a non-session', async () => {
    await seedFridayClose();
    // Make Mon 21 and Tue 22 holidays: on Wednesday the last session is still Friday,
    // so Friday's close is current and must NOT be stale.
    await db.query(
      `insert into holidays (holiday_date, note)
       values (date '2026-09-21', 'test'), (date '2026-09-22', 'test')
       on conflict do nothing`,
    );
    expect(await lastCompletedTradingDay(db, '2026-09-23T09:00:00Z')).toBe('2026-09-18');
    expect((await bhavcopy('2026-09-23T09:00:00Z'))?.stale).toBe(false);
    await db.close();
  });

  it('leaves portfolio sources on the wall clock', async () => {
    // indmoney publishes every day, so a calendar rule would wrongly excuse a real gap.
    const rows = await assessStaleness(db, '2026-09-20T04:30:00Z');
    const indmoney = rows.find((r) => r.source === 'indmoney');
    expect(indmoney?.stale, 'no holdings at all must still read stale').toBe(true);
    await db.close();
  });

  it('no longer reports the phantom composite source', async () => {
    const rows = await assessStaleness(db, '2026-09-20T04:30:00Z');
    // Nothing ever wrote `composite`, so it held a permanently open incident.
    expect(rows.map((r) => r.source)).not.toContain('composite');
    await db.close();
  });
});
