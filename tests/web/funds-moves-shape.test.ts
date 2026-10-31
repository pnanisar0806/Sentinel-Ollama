import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { persistUniverse } from '../../src/domain/mf-universe.js';
import { logSipMove } from '../../src/domain/owner-log.js';
import { persistSipSnapshot } from '../../src/domain/sips.js';
import { LTCG_EXEMPTION_PER_FY } from '../../src/domain/cleanup.js';
import { db, getFundMoves } from '../../web/lib/data.js';
import { moveStarted, sipText, unitsText } from '../../web/lib/funds.js';

/** Fund switch Task 6: /funds "Switch check" gives a SIP answer and a units answer per held fund. */
const NOW = new Date().toISOString();
const MID = 'Equity Scheme - Mid Cap Fund';
const INVESCO = 'MFU:120505';

describe('getFundMoves', () => {
  beforeAll(async () => {
    const d = await db();
    await runMigrations(d);
    await d.query(
      `insert into instruments (id, kind, name, currency, isin, metadata) values
         ('MF:HDFC-MIDCAP', 'MF', 'HDFC Mid Cap Opportunities Direct', 'INR', 'INF179K01XQ0', $1::jsonb),
         ('MF:PPFC', 'MF', 'Parag Parikh Flexi Cap Direct', 'INR', 'INF879O01027', '{}')`,
      [JSON.stringify({ amfiCategory: MID })]);
    await persistUniverse(d, [
      { instrumentId: INVESCO, schemeCode: '120505', isin: 'INF205K01MN9', name: 'Invesco India Mid Cap Direct Growth', category: MID },
    ]);
    const [s] = await d.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ($1::date, 'indmoney') returning id`, [NOW.slice(0, 10)]);
    await d.query(
      `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, avg_cost_paise, source, as_of)
       values ($1, 'MF:HDFC-MIDCAP', 'indmoney', 1, 1900000, 1500000, 'indmoney', $2),
              ($1, 'MF:PPFC', 'indmoney', 1, 24100000, null, 'indmoney', $2)`, [s!.id, NOW]);
    // A fresh feed that lists no PPFC SIP: "no SIP" is a fact only when the feed is known.
    await persistSipSnapshot(d, [{ sipId: 'S-HDFC', instrumentId: 'MF:HDFC-MIDCAP', isin: null, fundName: 'HDFC Mid Cap', fundType: 'EQUITY',
      category: null, frequency: 'MONTHLY', amountPaise: 300_100n, stepUpRaw: null, stepUpFreq: null, startDate: '2025-01-05' }], NOW);
    await logSipMove(d, {
      on: NOW.slice(0, 10), fromInstrumentId: 'MF:HDFC-MIDCAP', toInstrumentId: INVESCO, amountPaise: 300_100n, firstMonth: '2026-11', note: '',
    }, NOW);
  });

  it('one row per held fund, each with a SIP and a units answer; the exemption rides along', async () => {
    const r = await getFundMoves();
    expect(r.ltcgExemptionPaise).toBe(LTCG_EXEMPTION_PER_FY);
    expect(r.moves.map((m) => m.instrumentId).sort()).toEqual(['MF:HDFC-MIDCAP', 'MF:PPFC']);
    for (const m of r.moves) {
      expect(m.sip.kind).toBeTruthy();
      expect(m.units.kind).toBeTruthy();
    }
  });

  it('a logged move renders "moved to <B> from <Mon YYYY>"; no SIP renders "no SIP"', async () => {
    const byId = new Map((await getFundMoves()).moves.map((m) => [m.instrumentId, m]));
    const hdfc = byId.get('MF:HDFC-MIDCAP')!;
    expect(hdfc.sip.kind).toBe('moved');
    expect(sipText(hdfc.sip, '2026-11')).toBe('moved to Invesco India Mid Cap Direct Growth from Nov 2026');
    expect(sipText(byId.get('MF:PPFC')!.sip, '2026-11')).toBe('no SIP');
  });

  it('a logged move carries its row id (for undo) and amount; before its first month the old SIP still runs', async () => {
    const hdfc = (await getFundMoves()).moves.find((m) => m.instrumentId === 'MF:HDFC-MIDCAP')!;
    if (hdfc.sip.kind !== 'moved') throw new Error('expected moved');
    const [row] = await (await db()).query<{ id: string }>(`select id::text from sip_moves where from_instrument_id = 'MF:HDFC-MIDCAP'`);
    expect(hdfc.sip.moveId).toBe(row!.id);
    expect(hdfc.sip.amountPaise).toBe(300_100n);
    expect(sipText(hdfc.sip, '2026-10')).toBe('running ₹3,001, moves to Invesco India Mid Cap Direct Growth from Nov 2026');
    expect(moveStarted(hdfc.sip, '2026-10')).toBe(false);
    expect(moveStarted(hdfc.sip, '2026-11')).toBe(true);
    expect(moveStarted(hdfc.sip, '2026-12')).toBe(true);
    expect(moveStarted({ kind: 'keep', amountPaise: 1n }, '2026-12')).toBe(false);
  });

  it('SIP and units texts for keep and move', () => {
    expect(sipText({ kind: 'keep', amountPaise: 300_100n }, '2026-11')).toBe('keep running ₹3,001');
    expect(sipText({ kind: 'move', amountPaise: 300_100n, toId: INVESCO, toName: 'Invesco', why: '' }, '2026-11')).toBe('move SIP to Invesco');
    expect(sipText({ kind: 'unknown', reason: 'SIP commitment unknown' }, '2026-11')).toBe('unknown');
    expect(unitsText({ kind: 'keep', why: '' })).toBe('keep');
    expect(unitsText({ kind: 'move', toId: INVESCO, toName: 'Invesco', why: '', valuePaise: 1n, investedPaise: null, gainPaise: null }))
      .toBe('move to Invesco');
  });
});
