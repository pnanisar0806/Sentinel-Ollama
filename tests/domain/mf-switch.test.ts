import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { evaluateSwitches, SWITCH_MARGIN } from '../../src/domain/mf-switch.js';
import { MAX_ACHIEVABLE_COMPOSITE } from '../../src/domain/mf-ranking.js';
import { persistMfMetadata, CRORE_PAISE } from '../../src/domain/mf-metadata.js';

/**
 * A switch has to be worth realising tax and paying an exit load for. IPS §3.7's
 * twelve-month hold is a floor and the standing instruction is that the default answer
 * is hold, so "no switch" is the expected output and a margin a month of NAV noise can
 * cross is not a thesis.
 */
const MID = 'Equity Scheme - Mid Cap Fund';

let db: Db;
let day = 0;

/** A monthly NAV series that compounds at `pctPerMonth`. */
async function navSeries(instrumentId: string, months: number, pctPerMonth: number) {
  let nav = 100_000_000;
  for (let m = 0; m < months; m++) {
    const d = new Date(Date.UTC(2024, m + 1, 0)).toISOString().slice(0, 10);
    nav = Math.round(nav * (1 + pctPerMonth / 100));
    await db.query(
      `insert into navs (instrument_id, nav_date, nav_micros, source, as_of)
       values ($1, $2::date, $3, 'amfi', $2::timestamptz)`,
      [instrumentId, d, nav],
    );
  }
}

/** A series that falls as often as it rises, so most rolling windows are negative. */
async function navSeriesAlternating(instrumentId: string, months: number) {
  let nav = 100_000_000;
  for (let m = 0; m < months; m++) {
    const d = new Date(Date.UTC(2024, m + 1, 0)).toISOString().slice(0, 10);
    nav = Math.round(nav * (m % 2 === 0 ? 0.94 : 1.03));
    await db.query(
      `insert into navs (instrument_id, nav_date, nav_micros, source, as_of)
       values ($1, $2::date, $3, 'amfi', $2::timestamptz)`,
      [instrumentId, d, nav],
    );
  }
}

async function heldFund(canon: string, name: string, category: string | null = MID) {
  await db.query(
    `insert into instruments (id, kind, name, currency, isin, scheme_code, canonical_id, metadata)
     values ($1::text, 'MF', $2::text, 'INR', $3::text, '999', $4::text, $6::jsonb),
            ($5::text, 'MF', $2::text, 'INR', null, null, $4::text, '{}'::jsonb)`,
    [`MF:${name}`, name, `INF${name}01019`, canon, `IND:${name}`,
     JSON.stringify(category === null ? {} : { amfiCategory: category })],
  );
  day += 1;
  const [snap] = await db.query<{ id: string }>(
    `insert into snapshots (business_date, source)
     values (date '2026-09-01' + $1::int, 'indmoney') returning id`, [day],
  );
  await db.query(
    `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
     values ($1, $2, 'indmoney', 1, 10000000, 'indmoney', timestamptz '2026-09-21T12:00:00Z')`,
    [snap!.id, `IND:${name}`],
  );
}

async function candidate(code: string, name: string, category = MID) {
  await db.query(
    `insert into instruments (id, kind, name, currency, isin, scheme_code, metadata)
     values ($1::text, 'MF', $2::text, 'INR', $3::text, $4::text, $5::jsonb)`,
    [`MFU:${code}`, name, `INF${code}01019`, code,
     JSON.stringify({ universe: true, category })],
  );
}

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  day = 0;
});

describe('evaluating a switch against the whole category', () => {
  it('holds when nothing clears the margin', async () => {
    await heldFund('MF:A', 'HELD');
    await navSeries('MF:HELD', 30, 1.0);
    await candidate('111', 'Barely Better');
    await navSeries('MFU:111', 30, 1.05);
    await persistMfMetadata(db, [{
      instrumentId: 'MF:HELD', asOf: '2026-09-21', expenseRatioBps: 60,
      aumPaise: 20_000n * CRORE_PAISE, category: MID, benchmarkName: null,
    }]);

    const [s] = await evaluateSwitches(db, '2026-09-21');
    // "No action" is a first-class answer, not a failure to decide.
    expect(s!.challengerId).toBeNull();
    expect(s!.reason).toMatch(new RegExp(`short of the ${SWITCH_MARGIN}-point margin|no candidate`));
    await db.close();
  });

  it('names a challenger that clears it', async () => {
    // `consistencyRatio` scores the SHARE of rolling windows that gained, not how much
    // they gained — a fund up 0.1% a month wins as many windows as one up 2%. So the
    // held fund here loses windows rather than merely growing slowly.
    await heldFund('MF:A', 'HELD');
    await navSeriesAlternating('MF:HELD', 30);
    await candidate('222', 'Much Better');
    await navSeries('MFU:222', 30, 1.0);

    const [s] = await evaluateSwitches(db, '2026-09-21');
    expect(s!.challengerId).toBe('MFU:222');
    expect(s!.edge!).toBeGreaterThanOrEqual(SWITCH_MARGIN);
    expect(s!.reason).toContain('Much Better');
    await db.close();
  });

  it('will not compare a candidate with less history than the holding', async () => {
    await heldFund('MF:A', 'HELD');
    await navSeries('MF:HELD', 30, 0.1);
    await candidate('333', 'Young Fund');
    // 14 months: past the window, but far short of the holding's 30.
    await navSeries('MFU:333', 14, 5.0);

    const [s] = await evaluateSwitches(db, '2026-09-21');
    // A young fund scores its short history as if it were the whole record, and a
    // spectacular fourteen months is exactly what a switch should not chase.
    expect(s!.challengerId).toBeNull();
    expect(s!.cohortSize).toBe(0);
    await db.close();
  });

  it('says so when the category has no candidates at all', async () => {
    await heldFund('MF:A', 'HELD');
    await navSeries('MF:HELD', 30, 1.0);
    await persistMfMetadata(db, [{
      instrumentId: 'MF:HELD', asOf: '2026-09-21', expenseRatioBps: 60,
      aumPaise: null, category: MID, benchmarkName: null,
    }]);

    const [s] = await evaluateSwitches(db, '2026-09-21');
    expect(s!.challengerId).toBeNull();
    expect(s!.reason).toContain('no candidates on record');
    await db.close();
  });

  it('says so when the holding has no category', async () => {
    await heldFund('MF:A', 'HELD', null);
    await navSeries('MF:HELD', 30, 1.0);
    const [s] = await evaluateSwitches(db, '2026-09-21');
    expect(s!.reason).toContain('no category on record');
    await db.close();
  });

  it('handicaps the challenger rather than the holding on missing metadata', async () => {
    // A candidate has no INDmoney cost or size, so it scores 0 on 35 of the points the
    // holding can score. That can only ever understate the case for switching, which is
    // the safe direction for a recommendation that realises tax.
    await heldFund('MF:A', 'HELD');
    await navSeries('MF:HELD', 30, 1.0);
    await candidate('444', 'Equal Returns');
    await navSeries('MFU:444', 30, 1.0);
    await persistMfMetadata(db, [{
      instrumentId: 'MF:HELD', asOf: '2026-09-21', expenseRatioBps: 25,
      aumPaise: 20_000n * CRORE_PAISE, category: MID, benchmarkName: null,
    }]);

    const [s] = await evaluateSwitches(db, '2026-09-21');
    expect(s!.challengerId).toBeNull();
    expect(s!.edge!).toBeLessThan(0);
    await db.close();
  });

  it('keeps the margin a fixed share of the scale', () => {
    // 10 points when the achievable maximum was 75. Adding `returns` moved the scale to
    // 100, and a margin left at 10 would have quietly become a looser bar.
    expect(SWITCH_MARGIN / MAX_ACHIEVABLE_COMPOSITE).toBeCloseTo(10 / 75, 4);
  });
});
