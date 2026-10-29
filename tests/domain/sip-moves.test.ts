import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadActiveSipMoves, loadOwnerTimeline, logSipMove } from '../../src/domain/owner-log.js';
import { persistUniverse } from '../../src/domain/mf-universe.js';
import { reverseEntry } from '../../src/domain/reversals.js';

/** Fund switch spec §3: the owner logs a SIP moved from one fund to another in the same category. */
let db: Db;
const NOW = '2026-10-20T06:00:00Z'; // IST month 2026-10; the earliest first month is 2026-09
const MID = 'Equity Scheme - Mid Cap Fund';
const SMALL = 'Equity Scheme - Small Cap Fund';
const INVESCO = 'MFU:120505';

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
  // What stampHeldCategories writes on a held fund; MF:MOTILAL-MIDCAP is left unstamped.
  await db.query(`update instruments set metadata = metadata || jsonb_build_object('amfiCategory', $1::text) where id = 'MF:HDFC-MIDCAP'`, [MID]);
  await persistUniverse(db, [
    { instrumentId: INVESCO, schemeCode: '120505', isin: 'INF205K01MN9', name: 'Invesco India Mid Cap Direct Growth', category: MID },
    { instrumentId: 'MFU:125354', schemeCode: '125354', isin: 'INF769K01DM9', name: 'Mirae Midcap Direct Growth', category: MID },
    { instrumentId: 'MFU:125497', schemeCode: '125497', isin: 'INF204K01K15', name: 'SBI Small Cap Direct Growth', category: SMALL },
  ]);
});
afterEach(async () => { await db.close(); });

const move = (over: Partial<Parameters<typeof logSipMove>[1]> = {}) => logSipMove(db, {
  on: '2026-10-18', fromInstrumentId: 'MF:HDFC-MIDCAP', toInstrumentId: INVESCO, amountPaise: 300_100n, firstMonth: '2026-11', note: 'lower TER', ...over,
}, NOW);

describe('logSipMove', () => {
  // Fund switch §4.4: an index SIP moves only to a fund tracking the same index. AMFI files every
  // index under one category, so the category check alone would let Nifty 50 → Next 50 through.
  it('an index SIP moves to a same-index challenger; Nifty 50 → Nifty Next 50 is refused', async () => {
    const IDX = 'Other Scheme - Index Funds';
    await db.query(`update instruments set metadata = metadata || jsonb_build_object('amfiCategory', $1::text) where id = 'MF:ICICI-NIFTY50-IDX'`, [IDX]);
    const challenger = (id: string, name: string, indexType: string) => db.query(
      `insert into instruments (id, kind, name, currency, scheme_code, metadata) values ($1, 'MF', $2, 'INR', $3, $4::jsonb)`,
      [id, name, id.slice(4), JSON.stringify({ indexChallenger: true, category: IDX, indexType })]);
    await challenger('MFU:149999', 'Navi Nifty 50 Index Fund', 'NIFTY50');
    await challenger('MFU:150000', 'Edelweiss Nifty Next 50 Index Fund', 'NEXT50');
    const n50 = { fromInstrumentId: 'MF:ICICI-NIFTY50-IDX', amountPaise: 1_400_100n };
    await expect(move({ ...n50, toInstrumentId: 'MFU:150000' })).rejects.toThrow(
      'a SIP moves only between funds tracking the same index: ICICI Pru Nifty 50 Index Direct tracks the Nifty 50 index, '
      + 'Edelweiss Nifty Next 50 Index Fund tracks the Nifty Next 50 index');
    await expect(move({ ...n50, toInstrumentId: 'MFU:149999' })).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('logs HDFC Mid Cap → Invesco India Mid Cap, ₹3,001 from 2026-11', async () => {
    const { id } = await move();
    expect(await loadActiveSipMoves(db)).toEqual([{
      id, fromInstrumentId: 'MF:HDFC-MIDCAP', fromName: 'HDFC Mid Cap Opportunities Direct',
      toInstrumentId: INVESCO, toName: 'Invesco India Mid Cap Direct Growth',
      amountPaise: 300_100n, firstMonth: '2026-11', on: '2026-10-18', note: 'lower TER',
    }]);
    const [row] = await db.query<{ as_of: string | Date; source: string }>(`select as_of, source from sip_moves`);
    expect(row!.source).toBe('owner-web');
    expect(new Date(row!.as_of).toISOString()).toBe('2026-10-20T06:00:00.000Z');
    const [a] = await db.query<{ actor: string; entity_id: string; payload: Record<string, unknown> }>(
      `select actor, entity_id, payload from audit_log where entity = 'sip_move'`);
    expect(a!.actor).toBe('owner');
    expect(a!.entity_id).toBe(id);
    expect(a!.payload['rowId']).toBe(id);
    const [t] = (await loadOwnerTimeline(db)).filter((e) => e.kind === 'SIP move');
    expect(t!.summary).toBe('SIP moved: HDFC Mid Cap Opportunities Direct → Invesco India Mid Cap Direct Growth, ₹3,001/month from Nov 2026');
    expect(t!.reversible).toEqual({ entity: 'sip_move', entityId: id });
  });

  it('reads the category from a canonical sibling, as heldFunds does', async () => {
    await db.query(`insert into instruments (id, kind, name, currency, canonical_id) values ('IND:HDFC-MID', 'MF', 'HDFC Mid Cap (INDmoney)', 'INR', 'MF:3097')`);
    await move({ fromInstrumentId: 'IND:HDFC-MID' });
    expect((await loadActiveSipMoves(db)).map((m) => m.fromInstrumentId)).toEqual(['IND:HDFC-MID']);
  });

  it('refuses', async () => {
    await expect(move({ toInstrumentId: '' })).rejects.toThrow('pick the fund the SIP moved to');
    await expect(move({ toInstrumentId: '  ' })).rejects.toThrow('pick the fund the SIP moved to');
    await expect(move({ fromInstrumentId: '' })).rejects.toThrow('pick the fund the SIP moved from');
    await expect(move({ toInstrumentId: 'MF:HDFC-MIDCAP' })).rejects.toThrow('the new fund must differ from the old one');
    await expect(move({ toInstrumentId: 'MFU:125497' })).rejects.toThrow('the new fund must be in the same category');
    await expect(move({ toInstrumentId: 'MF:MOTILAL-MIDCAP' })).rejects.toThrow('category unknown for Motilal Oswal Midcap Direct');
    await expect(move({ fromInstrumentId: 'MF:MOTILAL-MIDCAP' })).rejects.toThrow('category unknown for Motilal Oswal Midcap Direct');
    await expect(move({ toInstrumentId: 'MFU:NOPE' })).rejects.toThrow('no fund MFU:NOPE');
    await expect(move({ amountPaise: 0n })).rejects.toThrow('the amount must be positive');
    await expect(move({ amountPaise: -1n })).rejects.toThrow('the amount must be positive');
    for (const firstMonth of ['2026-13', '2026-1', '2026-11-01', 'Nov 2026']) {
      await expect(move({ firstMonth })).rejects.toThrow(`not a month: ${firstMonth}`);
    }
    await expect(move({ firstMonth: '2026-08' })).rejects.toThrow('the first month cannot be before 2026-09');
    await expect(move({ on: '2026-10-21' })).rejects.toThrow('2026-10-21 is in the future');
    expect(await loadActiveSipMoves(db)).toEqual([]);

    await move({ firstMonth: '2026-09' }); // the IST month before now is allowed
    await expect(move({ toInstrumentId: 'MFU:125354' })).rejects.toThrow('a move from this fund is already logged; reverse it first');
    expect(await loadActiveSipMoves(db)).toHaveLength(1);
  });

  it('a reversal removes it, and a new move from the same fund is then accepted', async () => {
    const { id } = await move();
    await reverseEntry(db, { entity: 'sip_move', entityId: id, reason: 'typo' }, NOW);
    expect(await loadActiveSipMoves(db)).toEqual([]);
    const { id: again } = await move({ toInstrumentId: 'MFU:125354' });
    expect((await loadActiveSipMoves(db)).map((m) => m.id)).toEqual([again]);
  });

  it('sip_moves is append-only with RLS on', async () => {
    await move();
    await expect(db.query(`update sip_moves set source = source`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from sip_moves`)).rejects.toThrow(/append-only/);
    await expect(db.query(`truncate sip_moves cascade`)).rejects.toThrow(/append-only/);
    expect((await db.query<{ enabled: boolean }>(`select relrowsecurity enabled from pg_class where relname = 'sip_moves'`))[0]!.enabled).toBe(true);
  });
});
