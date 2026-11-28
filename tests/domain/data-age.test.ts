import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { persistSipSnapshot } from '../../src/domain/sips.js';
import { BANK_STALE_DAYS, EPF_STALE_DAYS, SIP_UNITS_GRACE_DAYS, loadDataAge } from '../../src/domain/data-age.js';
import { rupees } from '../../src/money/paise.js';
import type { SipRow } from '../../src/sources/indmoney.js';

/**
 * Open list #29 (owner, 2026-11-20): INDmoney gives no per-row refresh time, so staleness is
 * inferred from values that stop changing. Banks 2 days, EPF 45 days, SIP units 5 days after
 * the instalment. Warn only.
 */
const L = (n: number) => BigInt(rupees(n));
let db: Db;
beforeEach(async () => {
  db = await openDb(); await runMigrations(db);
  await db.query(`insert into instruments (id, kind, name) values
    ('IND:EPF-A', 'EPF', 'Employer EPF'), ('IND:EPF-B', 'EPF', 'Employer EPF'), ('IND:3229', 'MF', 'Parag Parikh Flexi Cap'),
    ('IND:1042502', 'MF', 'Edelweiss Nifty Next 50')`);
});
afterEach(async () => { await db.close(); });

const bank = (asOf: string, label: string, r: number) => db.query(
  `insert into balance_snapshots (as_of, source, kind, label, amount_paise) values ($1, 'indmoney', 'savings', $2, $3)`, [asOf, label, L(r).toString()]);
/** One INDmoney holdings snapshot with the given rows: [instrument, quantity, rupees]. */
async function holdings(takenAt: string, rows: [string, number, number][]) {
  const [s] = await db.query<{ id: string }>(
    `insert into snapshots (taken_at, business_date, source) values ($1, $2, 'indmoney') returning id`, [takenAt, takenAt.slice(0, 10)]);
  for (const [id, q, r] of rows) {
    await db.query(`insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
      values ($1, $2, $3, $4, 'indmoney', $5, 'indmoney')`, [s!.id, id, q, L(r).toString(), takenAt]);
  }
}
const sip = (instrumentId: string, startDate: string, sipId = instrumentId): SipRow => ({
  sipId, instrumentId, isin: null, fundName: instrumentId === 'IND:3229' ? 'Parag Parikh Flexi Cap' : 'Edelweiss Nifty Next 50',
  fundType: 'Equity', category: null, frequency: 'MONTHLY', amountPaise: L(3_000), stepUpRaw: null, stepUpFreq: null, startDate,
});

describe('the owner thresholds', () => {
  it('banks 2 days, EPF 45 days, SIP units 5 days', () => {
    expect([BANK_STALE_DAYS, EPF_STALE_DAYS, SIP_UNITS_GRACE_DAYS]).toEqual([2, 45, 5]);
  });
});

describe('banks', () => {
  it('every savings account, each dated by its last change; stale from 2 days unchanged', async () => {
    await bank('2026-11-10T14:00:00Z', 'HDFC Bank', 100); await bank('2026-11-18T14:00:00Z', 'HDFC Bank', 200);
    await bank('2026-11-19T14:00:00Z', 'HDFC Bank', 200);
    await bank('2026-11-01T14:00:00Z', 'State Bank Of India', 50); await bank('2026-11-19T14:00:00Z', 'State Bank Of India', 50);
    const { banks } = await loadDataAge(db, '2026-11-20T06:00:00Z');
    expect(banks).toEqual([
      { label: 'HDFC Bank', age: { amountPaise: L(200), lastChangedOn: '2026-11-18', fetchedOn: '2026-11-19', daysUnchanged: 2, stale: true } },
      { label: 'State Bank Of India', age: { amountPaise: L(50), lastChangedOn: '2026-11-01', fetchedOn: '2026-11-19', daysUnchanged: 19, stale: true } },
    ]);
    expect((await loadDataAge(db, '2026-11-19T06:00:00Z')).banks[0]!.age.stale).toBe(false); // 1 day
  });
});

describe('EPF', () => {
  it('sums every EPF row per snapshot, so a changed INDmoney id is not a change', async () => {
    await holdings('2026-08-24T14:00:00Z', [['IND:EPF-A', 0, 13_53_592]]);
    await holdings('2026-11-14T14:00:00Z', [['IND:EPF-B', 0, 13_53_592]]);
    expect((await loadDataAge(db, '2026-11-20T06:00:00Z')).epf)
      .toEqual({ amountPaise: L(13_53_592), lastChangedOn: '2026-08-24', fetchedOn: '2026-11-14', daysUnchanged: 88, stale: true });
  });

  it('two EPF rows in one snapshot are one total', async () => {
    await holdings('2026-10-01T14:00:00Z', [['IND:EPF-A', 0, 10_00_000], ['IND:EPF-B', 0, 3_53_592]]);
    await holdings('2026-11-14T14:00:00Z', [['IND:EPF-A', 0, 10_00_000], ['IND:EPF-B', 0, 3_53_592]]);
    expect((await loadDataAge(db, '2026-11-20T06:00:00Z')).epf).toMatchObject({ amountPaise: L(13_53_592), lastChangedOn: '2026-10-01' });
  });

  it('fresh within 45 days of a change; null with no EPF', async () => {
    expect((await loadDataAge(db, '2026-11-20T06:00:00Z')).epf).toBeNull();
    await holdings('2026-10-01T14:00:00Z', [['IND:EPF-A', 0, 13_00_000]]);
    await holdings('2026-10-16T14:00:00Z', [['IND:EPF-A', 0, 13_53_592]]);
    expect((await loadDataAge(db, '2026-11-29T06:00:00Z')).epf).toMatchObject({ daysUnchanged: 44, stale: false });
    expect((await loadDataAge(db, '2026-11-30T06:00:00Z')).epf).toMatchObject({ daysUnchanged: 45, stale: true });
  });
});

describe('SIP units', () => {
  it('units that rose after the instalment are fresh', async () => {
    await persistSipSnapshot(db, [sip('IND:3229', '2026-10-12')], '2026-10-20T00:00:00Z');
    await holdings('2026-11-10T14:00:00Z', [['IND:3229', 3000, 2_80_000]]);
    await holdings('2026-11-14T14:00:00Z', [['IND:3229', 3096.27, 2_93_000]]);
    expect((await loadDataAge(db, '2026-11-20T06:00:00Z')).sipUnits).toEqual([
      { instrumentId: 'IND:3229', fundName: 'Parag Parikh Flexi Cap', instalmentOn: '2026-11-12', unitsBefore: '3000', unitsNow: '3096.27', stale: false },
    ]);
  });

  it('units unchanged 5 days after the instalment are stale; before that, last month is checked', async () => {
    await persistSipSnapshot(db, [sip('IND:3229', '2026-10-12')], '2026-10-20T00:00:00Z');
    await holdings('2026-10-08T14:00:00Z', [['IND:3229', 2900, 2_70_000]]);
    await holdings('2026-10-14T14:00:00Z', [['IND:3229', 3000, 2_80_000]]);
    await holdings('2026-11-16T14:00:00Z', [['IND:3229', 3000, 2_85_000]]);
    expect((await loadDataAge(db, '2026-11-17T06:00:00Z')).sipUnits[0]).toMatchObject({ instalmentOn: '2026-11-12', stale: true });
    expect((await loadDataAge(db, '2026-11-16T06:00:00Z')).sipUnits[0]).toMatchObject({ instalmentOn: '2026-10-12', unitsBefore: '2900', unitsNow: '3000', stale: false });
  });

  it("a SIP's first instalment counts from no units; an instalment before the SIP's first known date is not checked", async () => {
    await persistSipSnapshot(db, [sip('IND:1042502', '2026-11-12')], '2026-11-13T00:00:00Z');
    expect((await loadDataAge(db, '2026-11-16T06:00:00Z')).sipUnits).toEqual([]); // 12-Oct predates the SIP
    expect((await loadDataAge(db, '2026-11-17T06:00:00Z')).sipUnits[0]).toMatchObject({ unitsBefore: '0', unitsNow: '0', stale: true });
    await holdings('2026-11-14T14:00:00Z', [['IND:1042502', 180.11, 3_099]]);
    expect((await loadDataAge(db, '2026-11-17T06:00:00Z')).sipUnits[0]).toMatchObject({ unitsBefore: '0', unitsNow: '180.11', stale: false });
  });

  it('a snapshot on the instalment day counts as after it', async () => {
    await persistSipSnapshot(db, [sip('IND:3229', '2026-10-12')], '2026-10-20T00:00:00Z');
    await holdings('2026-11-10T14:00:00Z', [['IND:3229', 3000, 2_80_000]]);
    await holdings('2026-11-12T14:00:00Z', [['IND:3229', 3096.27, 2_93_000]]); // 12-Nov 19:30 IST, units already in
    expect((await loadDataAge(db, '2026-11-20T06:00:00Z')).sipUnits[0]).toMatchObject({ unitsBefore: '3000', stale: false });
  });

  it('a day of the month the month lacks falls on its last day', async () => {
    await persistSipSnapshot(db, [sip('IND:3229', '2026-10-31')], '2026-10-20T00:00:00Z');
    expect((await loadDataAge(db, '2026-12-06T06:00:00Z')).sipUnits[0]).toMatchObject({ instalmentOn: '2026-11-30' });
  });
});
