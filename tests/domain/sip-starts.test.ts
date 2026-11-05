import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { SipRow } from '../../src/sources/indmoney.js';
import { loadSipCommitment, persistSipSnapshot } from '../../src/domain/sips.js';
import { loadActiveSipStarts, loadOwnerTimeline, logSipMove, logSipStart } from '../../src/domain/owner-log.js';
import { reverseEntry } from '../../src/domain/reversals.js';
import { approveMix, proposeMix } from '../../src/domain/fund-mix.js';
import { loadSipSuggestions } from '../../src/domain/sip-advice.js';

/** Spec 2026-11-03 Part B: a logged SIP start (and a logged move) counts in the SIP commitment until the feed lists it. */
let db: Db;
const NOV = '2026-11-05T06:00:00.000Z'; // IST month 2026-11; the earliest first month is 2026-10
const DEC = '2026-12-03T06:00:00.000Z';
const R = (rupees: number) => BigInt(rupees) * 100n;
const MID = 'Equity Scheme - Mid Cap Fund';
const EDEL = 'MFU:150000';
const EDEL_ISIN = 'INF754K01SZ5';
const INVESCO = 'MFU:120403';

const sip = (sipId: string, instrumentId: string, isin: string | null, fundName: string, rupees: number): SipRow => ({
  sipId, instrumentId, isin, fundName, fundType: 'Equity', category: null, frequency: 'MONTHLY',
  amountPaise: R(rupees), stepUpRaw: null, stepUpFreq: null, startDate: '2025-11-05',
});
// The feed's own ids (IND:*) are not instruments here: the funds are matched by the ISIN on the feed row.
const FEED = [
  sip('ICICI-1', 'IND:5536', 'INF109K012M7', 'ICICI Prudential Nifty 50 Index Plan Direct Growth', 14_001),
  sip('HDFC-1', 'IND:3097', 'INF179K01XQ0', 'HDFC Mid Cap Opportunities Direct Growth', 3_001),
  sip('BANDHAN-1', 'IND:1005544', 'INF194KB1AL4', 'Bandhan Small Cap Fund Direct Growth', 2_251),
];
const FEED_TOTAL = R(14_001 + 3_001 + 2_251);
const EDEL_FEED = sip('EDEL-1', 'IND:ED', EDEL_ISIN, 'Edelweiss Nifty Next 50 Index Fund Direct Growth', 2_000);

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await db.query(`insert into instruments (id, kind, name, currency, isin, metadata) values
    ('MF:ICICI-N50', 'MF', 'ICICI Pru Nifty 50 Index Direct', 'INR', 'INF109K012M7', '{}'),
    ('MF:HDFC-MIDCAP', 'MF', 'HDFC Mid Cap Opportunities Direct', 'INR', 'INF179K01XQ0', jsonb_build_object('amfiCategory', $1::text)),
    ($2, 'MF', 'Invesco India Mid Cap Direct Growth', 'INR', 'INF205K01MV6', jsonb_build_object('category', $1::text)),
    ($3, 'MF', 'Edelweiss Nifty Next 50 Index Fund', 'INR', $4, '{"indexChallenger": true, "indexType": "NEXT50"}'),
    ('NSE:RELIANCE', 'EQUITY', 'Reliance Industries', 'INR', 'INE002A01018', '{}')`, [MID, INVESCO, EDEL, EDEL_ISIN]);
  await persistSipSnapshot(db, FEED, NOV);
});
afterEach(async () => { await db.close(); });

const start = (over: Partial<Parameters<typeof logSipStart>[1]> = {}, now = NOV) => logSipStart(db, {
  on: '2026-11-05', instrumentId: EDEL, amountPaise: R(2_000), firstMonth: '2026-12', note: 'from the SIP card', ...over,
}, now);
const total = async (now = NOV) => (await loadSipCommitment(db, now)).totalPaise;

describe('logSipStart', () => {
  it('records the start, its audit row and a reversible timeline entry', async () => {
    const { id } = await start();
    expect(await loadActiveSipStarts(db)).toEqual([{
      id, instrumentId: EDEL, fundName: 'Edelweiss Nifty Next 50 Index Fund', amountPaise: R(2_000), firstMonth: '2026-12', on: '2026-11-05', note: 'from the SIP card',
    }]);
    const [row] = await db.query<{ source: string; as_of: string | Date }>(`select source, as_of from sip_starts`);
    expect(row!.source).toBe('owner-web');
    expect(new Date(row!.as_of).toISOString()).toBe(NOV);
    const [t] = (await loadOwnerTimeline(db)).filter((e) => e.kind === 'SIP');
    expect(t!.summary).toBe('Started a SIP: Edelweiss Nifty Next 50 Index Fund, ₹2,000/month from Dec 2026');
    expect(t!.reversible).toEqual({ entity: 'sip_start', entityId: id });
  });

  it('refuses', async () => {
    await expect(start({ instrumentId: 'NSE:RELIANCE' })).rejects.toThrow('a SIP can only be started on a mutual fund');
    await expect(start({ instrumentId: 'MFU:NOPE' })).rejects.toThrow('no fund MFU:NOPE');
    await expect(start({ amountPaise: 0n })).rejects.toThrow('the amount must be positive');
    await expect(start({ amountPaise: -1n })).rejects.toThrow('the amount must be positive');
    await expect(start({ firstMonth: '2026-09' })).rejects.toThrow('the first month cannot be before 2026-10');
    await expect(start({ firstMonth: 'Dec 2026' })).rejects.toThrow('not a month: Dec 2026');
    // The feed lists ICICI under IND:5536, which is no instrument: the feed row's ISIN is the alias.
    await expect(start({ instrumentId: 'MF:ICICI-N50' })).rejects.toThrow('an active SIP on this fund is already in the feed');
    expect(await loadActiveSipStarts(db)).toEqual([]);

    await start({ firstMonth: '2026-10' }); // the IST month before now is allowed
    await expect(start()).rejects.toThrow('a logged SIP start on this fund already exists; reverse it first');

    await logSipMove(db, { on: '2026-11-05', fromInstrumentId: 'MF:HDFC-MIDCAP', toInstrumentId: INVESCO, amountPaise: R(3_001), firstMonth: '2026-11', note: '' }, NOV);
    await expect(start({ instrumentId: INVESCO })).rejects.toThrow('a logged SIP move into this fund already exists; reverse it first');
    expect(await loadActiveSipStarts(db)).toHaveLength(1);
  });

  it('sip_starts is append-only', async () => {
    await start();
    await expect(db.query(`update sip_starts set note = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from sip_starts`)).rejects.toThrow(/append-only/);
  });
});

describe('loadSipCommitment with logged SIPs', () => {
  it('counts a logged start from its first month, and not before', async () => {
    expect(await total()).toBe(FEED_TOTAL);
    await start({ firstMonth: '2026-12' });
    const nov = await loadSipCommitment(db, NOV);
    expect(nov.totalPaise).toBe(FEED_TOTAL);
    expect(nov.sips.some((s) => s.logged)).toBe(false);

    await persistSipSnapshot(db, FEED, DEC);
    const dec = await loadSipCommitment(db, DEC);
    expect(dec.totalPaise).toBe(FEED_TOTAL + R(2_000));
    expect(dec.sips.filter((s) => s.logged).map((s) => [s.instrumentId, s.amountPaise])).toEqual([[EDEL, R(2_000)]]);
  });

  it('a start this month counts this month', async () => {
    await start({ firstMonth: '2026-11' });
    expect(await total()).toBe(FEED_TOTAL + R(2_000));
  });

  it('once the feed lists the fund (by ISIN), the feed amount replaces the stand-in — no double count', async () => {
    await start({ firstMonth: '2026-11', amountPaise: R(2_500) });
    await persistSipSnapshot(db, [...FEED, EDEL_FEED], '2026-11-05T07:00:00.000Z');
    const c = await loadSipCommitment(db, NOV);
    expect(c.totalPaise).toBe(FEED_TOTAL + R(2_000));
    expect(c.sips.some((s) => s.logged)).toBe(false);
  });

  it('a move: the "to" fund counts and the "from" stops from the move\'s first month, though the feed still lists it', async () => {
    await logSipMove(db, { on: '2026-11-05', fromInstrumentId: 'MF:HDFC-MIDCAP', toInstrumentId: INVESCO, amountPaise: R(3_500), firstMonth: '2026-12', note: '' }, NOV);
    // Before the first month the old SIP runs and the new one does not.
    const nov = await loadSipCommitment(db, NOV);
    expect(nov.totalPaise).toBe(FEED_TOTAL);
    expect(nov.sips.map((s) => s.instrumentId)).toContain('IND:3097');

    await persistSipSnapshot(db, FEED, DEC);
    const dec = await loadSipCommitment(db, DEC);
    expect(dec.totalPaise).toBe(FEED_TOTAL - R(3_001) + R(3_500));
    expect(dec.sips.map((s) => s.instrumentId)).not.toContain('IND:3097');
    expect(dec.sips.filter((s) => s.logged).map((s) => [s.instrumentId, s.amountPaise])).toEqual([[INVESCO, R(3_500)]]);
  });

  it('a started fund moved on again counts once: the move\'s "to" replaces the start', async () => {
    const IDX = 'Other Scheme - Index Funds';
    await db.query(`update instruments set metadata = metadata || jsonb_build_object('category', $1::text) where id = $2`, [IDX, EDEL]);
    await db.query(`insert into instruments (id, kind, name, currency, scheme_code, metadata) values ('MFU:150001', 'MF', 'UTI Nifty Next 50 Index Fund', 'INR', '150001', $1::jsonb)`,
      [JSON.stringify({ indexChallenger: true, category: IDX, indexType: 'NEXT50' })]);
    await start({ firstMonth: '2026-11' });
    await logSipMove(db, { on: '2026-11-05', fromInstrumentId: EDEL, toInstrumentId: 'MFU:150001', amountPaise: R(2_000), firstMonth: '2026-11', note: '' }, NOV);
    const c = await loadSipCommitment(db, NOV);
    expect(c.totalPaise).toBe(FEED_TOTAL + R(2_000));
    expect(c.sips.filter((s) => s.logged).map((s) => s.instrumentId)).toEqual(['MFU:150001']);
  });

  describe('a fund moved away earlier and restarted later', () => {
    const SEP = '2026-09-10T06:00:00.000Z';
    const LATER = '2026-11-05T07:00:00.000Z';
    const NO_HDFC = FEED.filter((s) => s.sipId !== 'HDFC-1');
    const moveAway = async () => {
      await persistSipSnapshot(db, FEED, '2026-09-01T06:00:00.000Z'); // HDFC-1 was running before the move
      await logSipMove(db, { on: '2026-09-10', fromInstrumentId: 'MF:HDFC-MIDCAP', toInstrumentId: INVESCO, amountPaise: R(3_001), firstMonth: '2026-09', note: '' }, SEP);
    };

    it('a start logged after the move counts the restarted fund', async () => {
      await moveAway();
      await persistSipSnapshot(db, NO_HDFC, '2026-11-05T06:30:00.000Z');
      await start({ instrumentId: 'MF:HDFC-MIDCAP', amountPaise: R(3_500), firstMonth: '2026-11' }, LATER);
      const c = await loadSipCommitment(db, LATER);
      expect(c.totalPaise).toBe(FEED_TOTAL - R(3_001) + R(3_001) + R(3_500)); // Invesco ₹3,001 + restarted HDFC ₹3,500
      expect(c.sips.filter((s) => s.logged).map((s) => s.instrumentId).sort()).toEqual([INVESCO, 'MF:HDFC-MIDCAP'].sort());
    });

    it('a round trip A → B → A counts A once, and B not at all', async () => {
      await moveAway();
      await logSipMove(db, { on: '2026-11-05', fromInstrumentId: INVESCO, toInstrumentId: 'MF:HDFC-MIDCAP', amountPaise: R(3_001), firstMonth: '2026-11', note: '' }, LATER);
      const c = await loadSipCommitment(db, LATER);
      expect(c.totalPaise).toBe(FEED_TOTAL); // the stale HDFC-1 row is dropped; the logged HDFC ₹3,001 stands in
      expect(c.sips.filter((s) => s.logged).map((s) => s.instrumentId)).toEqual(['MF:HDFC-MIDCAP']);
    });

    it('restarted directly in INDmoney: a new SIP id listed after the move counts', async () => {
      await moveAway();
      await persistSipSnapshot(db, [...NO_HDFC, { ...FEED[1]!, sipId: 'HDFC-2', amountPaise: R(4_000) }], LATER);
      expect(await total(LATER)).toBe(FEED_TOTAL - R(3_001) + R(3_001) + R(4_000));
    });
  });

  it('a stand-in retires once a later snapshot listed the fund, even after the SIP leaves the feed', async () => {
    await start({ firstMonth: '2026-11' });
    await persistSipSnapshot(db, [...FEED, EDEL_FEED], '2026-11-05T07:00:00.000Z');
    // Stopped in INDmoney: gone from the active-only feed next month (this month it still counts as departed).
    await persistSipSnapshot(db, FEED, DEC);
    const c = await loadSipCommitment(db, DEC);
    expect(c.totalPaise).toBe(FEED_TOTAL);
    expect(c.sips.some((s) => s.logged)).toBe(false);
  });

  it('a listing from before the start was logged does not retire it', async () => {
    // An earlier log on another fund: the listing below is after it, but before the Edelweiss start.
    await start({ instrumentId: INVESCO, on: '2026-11-01', firstMonth: '2026-11', amountPaise: R(1_000) }, '2026-11-01T00:00:00.000Z');
    await persistSipSnapshot(db, [...FEED, EDEL_FEED], '2026-11-01T07:00:00.000Z');
    await persistSipSnapshot(db, FEED, '2026-11-05T05:00:00.000Z');
    await start({ firstMonth: '2026-11' });
    expect(await total()).toBe(FEED_TOTAL + R(1_000) + R(2_000));
  });

  it('a reversal removes the start from the commitment', async () => {
    const { id } = await start({ firstMonth: '2026-11' });
    expect(await total()).toBe(FEED_TOTAL + R(2_000));
    await reverseEntry(db, { entity: 'sip_start', entityId: id, reason: 'typo' }, NOV);
    expect(await total()).toBe(FEED_TOTAL);
    expect(await loadActiveSipStarts(db)).toEqual([]);
    await expect(start()).resolves.toMatchObject({ id: expect.any(String) }); // freed for a new start
  });
});

describe('Suggested SIPs with a logged start', () => {
  it('a logged index-fund start is typed by its index and fills its type — no second new-fund row', async () => {
    await approveMix(db, { band: proposeMix(NOV).band! }, NOV);
    await start({ firstMonth: '2026-11' });
    const s = await loadSipSuggestions(db, NOV);
    if (s.rows === null) throw new Error(s.reason);
    const next50 = s.rows.filter((r) => r.fundType === 'NEXT50');
    expect(next50.map((r) => [r.instrumentId, r.currentPaise, r.logged])).toEqual([[EDEL, R(2_000), true]]);
    expect(s.currentPaise).toBe(FEED_TOTAL + R(2_000));
  });

  it('the Next 50 new-fund row names the chooser pick\'s instrument, so the card can log it as started', async () => {
    await approveMix(db, { band: proposeMix(NOV).band! }, NOV);
    await db.query(
      `insert into index_fund_candidates (fund_type, indmoney_fund_id, name, benchmark_name, amfi_scheme_code,
         expense_ratio_bps, aum_paise, sip_allowed, as_of, source)
       values ('NEXT50', '9001', 'Edelweiss Nifty Next 50 Index Fund', 'Nifty Next 50 TR INR', '150000', 10, 100000000000, true, '2026-11-04', 'indmoney-mcp')`);
    const s = await loadSipSuggestions(db, NOV);
    if (s.rows === null) throw new Error(s.reason);
    const [row] = s.rows.filter((r) => r.fundType === 'NEXT50');
    expect(row).toMatchObject({ instrumentId: EDEL, fundName: 'Edelweiss Nifty Next 50 Index Fund', currentPaise: 0n, logged: false });
    expect(row!.suggestedPaise > 0n).toBe(true);
  });
});
