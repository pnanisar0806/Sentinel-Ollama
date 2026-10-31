import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { loadFundMoves } from '../../src/domain/fund-moves.js';
import { persistUniverse } from '../../src/domain/mf-universe.js';
import { persistMfMetadata } from '../../src/domain/mf-metadata.js';
import { persistSipSnapshot } from '../../src/domain/sips.js';
import { logSipMove } from '../../src/domain/owner-log.js';
import { LTCG_EXEMPTION_PER_FY } from '../../src/domain/cleanup.js';
import type { SipRow } from '../../src/sources/indmoney.js';

/**
 * Fund switch spec §4: every held fund gets a SIP answer and a units answer, from one
 * challenger and one bar. ICICI Nifty 50's value and invested are the 2026-10-28 live row
 * (₹6,88,432 against ₹6,40,013); the other amounts are illustrative.
 */
const NOW = '2026-10-28T12:00:00Z';
const MID = 'Equity Scheme - Mid Cap Fund';
const INVESCO = 'MFU:120505';
const NAVI = 'MFU:149999';
let db: Db;

async function navs(id: string, months: number, step: (m: number) => number): Promise<void> {
  let nav = 100_000_000;
  for (let m = 0; m < months; m++) {
    nav = Math.round(nav * step(m));
    await db.query(
      `insert into navs (instrument_id, nav_date, nav_micros, source, as_of) values ($1, $2::date, $3, 'amfi', $2::timestamptz)`,
      [id, new Date(Date.UTC(2024, m + 1, 0)).toISOString().slice(0, 10), nav]);
  }
}

async function snapshot(source: string, rows: { id: string; account: string; value: bigint; cost: bigint | null }[]): Promise<void> {
  const [s] = await db.query<{ id: string }>(
    `insert into snapshots (business_date, source) values ('2026-10-28', $1) returning id`, [source]);
  for (const r of rows) {
    await db.query(
      `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, avg_cost_paise, source, as_of)
       values ($1, $2, $3, 1, $4, $5, $6, $7)`,
      [s!.id, r.id, r.account, r.value.toString(), r.cost?.toString() ?? null, source, NOW]);
  }
}

const sip = (instrumentId: string, amountPaise: bigint): SipRow => ({
  sipId: `S-${instrumentId}`, instrumentId, isin: null, fundName: instrumentId, fundType: 'EQUITY', category: null,
  frequency: 'MONTHLY', amountPaise, stepUpRaw: null, stepUpFreq: null, startDate: '2025-01-05',
});

async function indexPeer(id: string, name: string, schemeCode: string, bps: number): Promise<void> {
  await db.query(
    `insert into index_fund_candidates (fund_type, indmoney_fund_id, name, benchmark_name, amfi_scheme_code,
       expense_ratio_bps, aum_paise, sip_allowed, as_of, source)
     values ('NIFTY50', $1, $2, 'Nifty 50 TR INR', $3, $4, 1000000000000, true, '2026-10-28', 'indmoney-mcp')`,
    [id, name, schemeCode, bps]);
}

const byId = async () => new Map((await loadFundMoves(db, NOW)).moves.map((m) => [m.instrumentId, m]));

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  // Seed MF:* rows carry the ISIN; live IND:* rows share their canonical_id.
  await db.query(
    `insert into instruments (id, kind, name, currency, isin, canonical_id, metadata) values
       ('MF:ICICI-N50', 'MF', 'ICICI Prudential Nifty 50 Index Direct', 'INR', 'INF109K012M7', 'MF:N50', '{}'),
       ('IND:5536', 'MF', 'ICICI Prudential Nifty 50 Index Fund', 'INR', null, 'MF:N50', '{}'),
       ('MF:HDFC-MIDCAP', 'MF', 'HDFC Mid Cap Opportunities Direct', 'INR', 'INF179K01XQ0', 'MF:3097', $1::jsonb),
       ('IND:HDFC-MID', 'MF', 'HDFC Mid Cap Fund', 'INR', null, 'MF:3097', '{}'),
       ('MF:PPFC', 'MF', 'Parag Parikh Flexi Cap Direct', 'INR', 'INF879O01027', 'MF:PPFC', '{}'),
       ('IND:PPFC', 'MF', 'Parag Parikh Flexi Cap Fund', 'INR', null, 'MF:PPFC', '{}')`,
    [JSON.stringify({ amfiCategory: MID })]);
  await persistUniverse(db, [
    { instrumentId: INVESCO, schemeCode: '120505', isin: 'INF205K01MN9', name: 'Invesco India Mid Cap Direct Growth', category: MID },
  ]);
  // HDFC loses as many windows as it wins; Invesco gains steadily: a challenger clears the margin.
  await navs('MF:HDFC-MIDCAP', 30, (m) => (m % 2 === 0 ? 0.94 : 1.03));
  await navs(INVESCO, 30, () => 1.01);
  // A known cost is needed for any active switch (an unknown withholds it). 190 bps scores 0 of
  // the cost points, so the edge stays the NAV record's alone. Illustrative, not HDFC's real TER.
  await persistMfMetadata(db, [{
    instrumentId: 'MF:HDFC-MIDCAP', asOf: '2026-10-28', expenseRatioBps: 190, aumPaise: null, category: MID, benchmarkName: null,
  }]);
  await indexPeer('5536', 'ICICI Prudential Nifty 50 Index Fund', '120620', 20);
  await persistSipSnapshot(db, [sip('IND:HDFC-MID', 300_100n), sip('MF:ICICI-N50', 1_000_000n)], '2026-10-28T01:00:00Z');
});
afterEach(async () => { await db.close(); });

const live = (over: { hdfcCost?: bigint | null } = {}) => snapshot('indmoney', [
  { id: 'IND:5536', account: 'indmoney', value: 68_843_200n, cost: 64_001_300n },
  { id: 'IND:HDFC-MID', account: 'indmoney', value: 1_900_000n, cost: over.hdfcCost === undefined ? 1_500_000n : over.hdfcCost },
  { id: 'IND:PPFC', account: 'indmoney', value: 24_100_000n, cost: 20_000_000n },
]);

describe('loadFundMoves', () => {
  it('an active fund with a challenger and a live SIP: move both, to the same fund; gain = value − invested', async () => {
    await live();
    const { moves, ltcgExemptionPaise } = await loadFundMoves(db, NOW);
    expect(ltcgExemptionPaise).toBe(LTCG_EXEMPTION_PER_FY);
    const hdfc = moves.find((m) => m.instrumentId === 'IND:HDFC-MID')!;
    expect(hdfc).toMatchObject({ isIndex: false, category: MID });
    expect(hdfc.sip).toMatchObject({ kind: 'move', amountPaise: 300_100n, toId: INVESCO, toName: 'Invesco India Mid Cap Direct Growth' });
    expect(hdfc.units).toMatchObject({
      kind: 'move', toId: INVESCO, toName: 'Invesco India Mid Cap Direct Growth',
      valuePaise: 1_900_000n, investedPaise: 1_500_000n, gainPaise: 400_000n,
    });
    expect(hdfc.sip.kind === 'move' && hdfc.units.kind === 'move' && hdfc.sip.why === hdfc.units.why).toBe(true);
  });

  it('HDFC Mid Cap with a logged move to Invesco: SIP moved, units still judged', async () => {
    await live();
    await logSipMove(db, {
      on: '2026-10-27', fromInstrumentId: 'MF:HDFC-MIDCAP', toInstrumentId: INVESCO, amountPaise: 300_100n, firstMonth: '2026-11', note: '',
    }, NOW);
    const hdfc = (await byId()).get('IND:HDFC-MID')!;
    const [row] = await db.query<{ id: string }>(`select id::text from sip_moves order by id desc limit 1`);
    expect(hdfc.sip).toEqual({
      kind: 'moved', moveId: row!.id, amountPaise: 300_100n, toId: INVESCO, toName: 'Invesco India Mid Cap Direct Growth', firstMonth: '2026-11', loggedOn: '2026-10-27',
    });
    expect(hdfc.units).toMatchObject({ kind: 'move', toName: 'Invesco India Mid Cap Direct Growth' });
    // The old SIP stopped and left the feed: still "moved", not "no SIP".
    await persistSipSnapshot(db, [sip('MF:ICICI-N50', 1_000_000n)], '2026-10-28T02:00:00Z');
    expect((await byId()).get('IND:HDFC-MID')!.sip.kind).toBe('moved');
  });

  it('a fund without a SIP or a move: no SIP', async () => {
    await live();
    expect((await byId()).get('IND:PPFC')!.sip).toEqual({ kind: 'none' });
  });

  it('ICICI Nifty 50 at 20 bps vs a 9 bps same-index peer: both answers move, to the peer', async () => {
    await indexPeer('1039539', 'Navi Nifty 50 Index Fund', '149999', 9);
    await live();
    const icici = (await byId()).get('IND:5536')!;
    expect(icici.isIndex).toBe(true);
    // The SIP is filed under the seed MF:* id; the alias joins it to the live IND:* holding.
    expect(icici.sip).toMatchObject({ kind: 'move', amountPaise: 1_000_000n, toId: NAVI, toName: 'Navi Nifty 50 Index Fund' });
    expect(icici.units).toMatchObject({
      kind: 'move', toId: NAVI, valuePaise: 68_843_200n, investedPaise: 64_001_300n, gainPaise: 4_841_900n,
      why: 'Navi Nifty 50 Index Fund costs 0.09% a year against 0.20%, 0.11 points cheaper',
    });
  });

  it('ICICI Nifty 50 at 18 bps (its own candidate row) vs 9 bps: keep running, keep', async () => {
    // A later listing supersedes the beforeEach one (latest as_of per fund type).
    await db.query(
      `insert into index_fund_candidates (fund_type, indmoney_fund_id, name, benchmark_name, amfi_scheme_code,
         expense_ratio_bps, aum_paise, sip_allowed, as_of, source)
       values ('NIFTY50', '5536', 'ICICI Prudential Nifty 50 Index Fund', 'Nifty 50 TR INR', '120620', 18, 1, true, '2026-10-29', 'indmoney-mcp')`);
    await db.query(
      `insert into index_fund_candidates (fund_type, indmoney_fund_id, name, benchmark_name, amfi_scheme_code,
         expense_ratio_bps, aum_paise, sip_allowed, as_of, source)
       values ('NIFTY50', '1039539', 'Navi Nifty 50 Index Fund', 'Nifty 50 TR INR', '149999', 9, 1000000000000, true, '2026-10-29', 'indmoney-mcp')`);
    await live();
    const icici = (await byId()).get('IND:5536')!;
    expect(icici.sip).toEqual({ kind: 'keep', amountPaise: 1_000_000n });
    expect(icici.units).toEqual({ kind: 'keep', why: 'cheapest same-index fund is 0.09 points cheaper, short of the 0.10-point bar' });
  });

  it('a held index fund not in the candidates takes its expense ratio from fund metadata', async () => {
    await indexPeer('1039539', 'Navi Nifty 50 Index Fund', '149999', 9);
    // Held under a seed id INDmoney's listing does not carry: its own row cannot match.
    await snapshot('indmoney', [{ id: 'MF:ICICI-N50', account: 'indmoney', value: 68_843_200n, cost: 64_001_300n }]);
    const keep = (await byId()).get('MF:ICICI-N50')!;
    expect(keep.units).toEqual({ kind: 'keep', why: 'expense ratio unknown' });
    await persistMfMetadata(db, [{
      instrumentId: 'MF:ICICI-N50', asOf: '2026-10-28', expenseRatioBps: 20, aumPaise: null, category: null, benchmarkName: null,
    }]);
    expect((await byId()).get('MF:ICICI-N50')!.units).toMatchObject({ kind: 'move', toId: NAVI });
  });

  it('invested unknown on any account: invested and gain are unknown, never 0', async () => {
    await live({ hdfcCost: null });
    const units = (await byId()).get('IND:HDFC-MID')!.units;
    expect(units).toMatchObject({ kind: 'move', valuePaise: 1_900_000n, investedPaise: null, gainPaise: null });
  });

  it('known on one account, unknown on the other: still unknown, not the known part', async () => {
    await snapshot('indmoney', [
      { id: 'IND:HDFC-MID', account: 'indmoney', value: 1_900_000n, cost: 1_500_000n },
      { id: 'IND:HDFC-MID', account: 'zerodha', value: 100_000n, cost: null },
    ]);
    expect((await byId()).get('IND:HDFC-MID')!.units)
      .toMatchObject({ kind: 'move', valuePaise: 2_000_000n, investedPaise: null, gainPaise: null });
  });

  it('a stale or unknown SIP feed: SIP answer unknown with the reason, never "no SIP" or "keep running"', async () => {
    await live();
    const later = new Map((await loadFundMoves(db, '2026-11-10T12:00:00Z')).moves.map((m) => [m.instrumentId, m]));
    const reason = 'SIP commitment unknown: last SIP sync 2026-10-28 is older than 7 days (indmoney-sips)';
    expect(later.get('IND:HDFC-MID')!.sip).toEqual({ kind: 'unknown', reason });
    expect(later.get('IND:PPFC')!.sip).toEqual({ kind: 'unknown', reason });
  });

  it("a feed SIP joined to its holding by ISIN alone (no canonical link) is that fund's SIP", async () => {
    await live();
    await db.query(`insert into instruments (id, kind, name, currency, metadata) values ('IND:FEED-PPFC', 'MF', 'PPFC (feed)', 'INR', '{}')`);
    await persistSipSnapshot(db, [sip('MF:ICICI-N50', 1_000_000n), { ...sip('IND:FEED-PPFC', 1_100_100n), isin: 'INF879O01027' }], '2026-10-28T03:00:00Z');
    expect((await byId()).get('IND:PPFC')!.sip).toEqual({ kind: 'keep', amountPaise: 1_100_100n });
  });

  it('invested carried over from a retired seed row is unknown, not a firm gain', async () => {
    await snapshot('manual-seed', [{ id: 'MF:HDFC-MIDCAP', account: 'indmoney', value: 1_000_000n, cost: 800_000n }]);
    await snapshot('indmoney', [{ id: 'IND:HDFC-MID', account: 'indmoney', value: 1_900_000n, cost: null }]);
    expect((await byId()).get('IND:HDFC-MID')!.units)
      .toMatchObject({ kind: 'move', valuePaise: 1_900_000n, investedPaise: null, gainPaise: null });
  });

  it('one row per fund: the seed MF:* sibling is superseded; two live accounts sum', async () => {
    await snapshot('manual-seed', [
      { id: 'MF:ICICI-N50', account: 'indmoney', value: 28_100_000n, cost: null },
      { id: 'MF:ICICI-N50', account: 'zerodha', value: 4_700_000n, cost: null },
    ]);
    await indexPeer('1039539', 'Navi Nifty 50 Index Fund', '149999', 9);
    await snapshot('indmoney', [
      { id: 'IND:5536', account: 'indmoney', value: 64_143_200n, cost: 59_701_300n },
      { id: 'IND:5536', account: 'zerodha', value: 4_700_000n, cost: 4_300_000n },
    ]);
    const { moves } = await loadFundMoves(db, NOW);
    expect(moves.map((m) => m.instrumentId)).toEqual(['IND:5536']);
    expect(moves[0]!.units).toMatchObject({ valuePaise: 68_843_200n, investedPaise: 64_001_300n, gainPaise: 4_841_900n });
  });
});
