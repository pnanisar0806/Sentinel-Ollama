import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { McpClient } from '../../src/sources/mcp-client.js';
import type { NavRow, UniverseRow } from '../../src/sources/amfi.js';
import {
  chooseIndexFund, loadIndexFundRows, recordIndexFundCandidates, type IndexFundRow,
} from '../../src/sources/index-funds.js';
import { universeInstrumentId } from '../../src/domain/mf-universe.js';
import { logSipMove } from '../../src/domain/owner-log.js';

/**
 * Spec §8.1 / Decision 11: the new US and Nifty Next 50 index fund, read from INDmoney's
 * category listings (captured live 2026-10-26) and ranked on cost, then tracking error,
 * then size. Only Direct Growth plans open to SIPs are proposed.
 */
type Fund = { id: number; name: string; nav: number };
const fx = JSON.parse(readFileSync(new URL('../fixtures/indmoney-index-funds-2026-10-26.json', import.meta.url), 'utf8')) as {
  get_mf_by_category: Record<string, { result: { data: Fund[] } }>;
  get_mf_funds_details: { result: { data: { fund_id: number }[] } }[];
};
const NEXT50 = fx.get_mf_by_category['nifty-next-50-index-funds']!.result.data;
const US = fx.get_mf_by_category['global-index-funds']!.result.data;
/** Nifty 50: two funds as listed live 2026-10-28 (`nifty-50-index-funds`), benchmark per get_mf_funds_details. */
const NIFTY50: Fund[] = [
  { id: 5536, name: 'ICICI Prudential Nifty 50 Index Fund', nav: 240.3 },
  { id: 1039539, name: 'Navi Nifty 50 Index Fund', nav: 15 },
];
const listing = (f: Fund, expense_ratio: number) => ({ ...f, aum: '1000 Cr', expense_ratio, nav_date: '23 Oct 2026', sip_allowed: true });
fx.get_mf_by_category['nifty-50-index-funds'] = { result: { data: [listing(NIFTY50[0]!, 0.24), listing(NIFTY50[1]!, 0.1)] as Fund[] } };
const details = new Map(fx.get_mf_funds_details.flatMap((c) => c.result.data).map((d) => [String(d.fund_id), d]));
for (const f of NIFTY50) details.set(String(f.id), { fund_id: f.id, data: { fund_detail: { benchmark_name: 'Nifty 50 TR INR' } } } as never);

/** Answers from the captured payloads. A fund with no captured detail comes back without one. */
const client = {
  callTool: async (name: string, args: Record<string, unknown>) => {
    if (name === 'get_mf_by_category') {
      const slug = (args['categories'] as string[])[0]!;
      const page = fx.get_mf_by_category[slug]!.result;
      return { result: JSON.stringify(args['page'] === 1 ? page : { ...page, data: [] }) };
    }
    if (name === 'get_mf_funds_details') {
      const ids = String(args['fund_ids']).split(',');
      return { result: JSON.stringify({ success: true, data: ids.flatMap((id) => details.get(id) ?? []) }) };
    }
    throw new Error(`unexpected tool ${name}`);
  },
} as unknown as McpClient;

/** AMFI: a Direct Growth row for every listed fund at INDmoney's NAV, plus an IDCW twin at the same NAV. */
const all = [...NEXT50, ...US, ...NIFTY50];
const universe: UniverseRow[] = all.flatMap((f) => [
  { schemeCode: `DG${f.id}`, isin: null, schemeName: `${f.name} - Direct Plan - Growth`, plan: 'Direct Plan', option: 'Growth', nav: f.nav, category: '' },
  { schemeCode: `DI${f.id}`, isin: null, schemeName: `${f.name} - Direct Plan - IDCW`, plan: 'Direct Plan', option: 'IDCW', nav: f.nav, category: '' },
]);
const navOn = (except: number[] = []) => async (): Promise<NavRow[]> => universe
  .filter((u) => !except.some((id) => u.schemeCode.endsWith(String(id))))
  .map((u) => ({ schemeCode: u.schemeCode, isinDivPayout: `INF${u.schemeCode}`, isinDivReinvestment: null,
    schemeName: u.schemeName, nav: u.nav, repurchasePrice: null, salePrice: null, date: '23-Oct-2026' }));

describe('loadIndexFundRows', () => {
  it('takes the latest as_of per fund type, so a missed US listing keeps its last rows', async () => {
    const db = await openDb(); await runMigrations(db);
    const ins = (t: string, id: string, d: string) => db.query(
      `insert into index_fund_candidates (fund_type, indmoney_fund_id, name, as_of, source) values ($1,$2,'f',$3,'indmoney-mcp')`, [t, id, d]);
    await ins('US', 'u1', '2026-10-25');
    await ins('NEXT50', 'n1', '2026-10-25');
    await ins('NEXT50', 'n1', '2026-10-26');
    const { asOf, rows } = await loadIndexFundRows(db);
    expect(asOf).toBe('2026-10-26');
    expect(rows.map((r) => `${r.fundType}:${r.asOf}`).sort()).toEqual(['NEXT50:2026-10-26', 'US:2026-10-25']);
  });
});

describe('recordIndexFundCandidates', () => {
  let db: Db;
  beforeEach(async () => { db = await openDb(); await runMigrations(db); });

  it('stores every listed fund with as_of and source indmoney-mcp, once per day', async () => {
    const r = await recordIndexFundCandidates(db, client, '2026-10-26', { amfiUniverse: async () => universe, amfiNavOn: navOn() });
    expect(r.stored).toBe(NEXT50.length + US.length + NIFTY50.length);
    const rows = await db.query<{ n: number; src: string; d: string }>(
      `select count(*)::int as n, min(source) as src, min(as_of)::text as d from index_fund_candidates`);
    expect(rows[0]).toEqual({ n: NEXT50.length + US.length + NIFTY50.length, src: 'indmoney-mcp', d: '2026-10-26' });
    const again = await recordIndexFundCandidates(db, client, '2026-10-26', { amfiUniverse: async () => universe, amfiNavOn: navOn() });
    expect(again.stored).toBe(0);
  });

  it('US: every fund closed to SIPs, so nothing is proposed and the reason names the closure', async () => {
    await recordIndexFundCandidates(db, client, '2026-10-26', { amfiUniverse: async () => universe, amfiNavOn: navOn() });
    const { rows } = await loadIndexFundRows(db);
    const c = chooseIndexFund(rows, 'US');
    expect(c.top).toBeNull();
    expect(c.alternatives).toEqual([]);
    expect(c.reason).toBe('no eligible fund is open to SIPs (RBI overseas limit)');
    // The S&P 500 fund resolved to its Direct Growth scheme and tracks the right index — only the SIP closure keeps it out.
    expect(c.notProposed.find((n) => n.row.indmoneyFundId === '1005898')?.why).toBe('closed to new SIPs on INDmoney');
  });

  it('Next 50: the lowest-cost eligible fund is top, two alternatives follow in rank order', async () => {
    await recordIndexFundCandidates(db, client, '2026-10-26', { amfiUniverse: async () => universe, amfiNavOn: navOn() });
    const { rows, asOf } = await loadIndexFundRows(db);
    expect(asOf).toBe('2026-10-26');
    const c = chooseIndexFund(rows, 'NEXT50');
    // Benchmarks captured for Edelweiss 0.20%, Axis 0.21%, Kotak 0.24%, Navi 0.25%.
    expect(c.top?.name).toBe('Edelweiss Nifty Next 50 Index Fund');
    expect(c.alternatives.map((a) => a.name)).toEqual(['Axis Nifty Next 50 Index Fund', 'Kotak Nifty Next 50 Index Fund']);
    expect(c.top?.amfiSchemeCode).toBe('DG1042502'); // the Direct Growth row, never its IDCW twin
    expect(c.trackingErrorAvailable).toBe(false);
    expect(c.reason).toBeNull();
    expect(c.notProposed.find((n) => n.row.indmoneyFundId === '5540')?.why).toBe('benchmark unknown');
  });

  it('Nifty 50: stored as NIFTY50 rows, the cheapest eligible fund is top', async () => {
    await recordIndexFundCandidates(db, client, '2026-10-26', { amfiUniverse: async () => universe, amfiNavOn: navOn() });
    const stored = await db.query<{ id: string }>(
      `select indmoney_fund_id as id from index_fund_candidates where fund_type = 'NIFTY50' order by 1`);
    expect(stored.map((r) => r.id)).toEqual(['1039539', '5536']);
    const c = chooseIndexFund((await loadIndexFundRows(db)).rows, 'NIFTY50');
    expect(c.top).toMatchObject({ name: 'Navi Nifty 50 Index Fund', expenseRatioBps: 10, amfiSchemeCode: 'DG1039539' });
    expect(c.alternatives.map((a) => a.indmoneyFundId)).toEqual(['5536']);
  });

  // Fund switch §4.4: a ranked same-index challenger becomes an MFU:<scheme> instrument — the id
  // loadFundMoves names — so the SIP move it suggests can be logged on /log.
  it('registers each ranked Nifty 50 challenger as an instrument a SIP move can be logged to; idempotent; a held fund is not re-registered', async () => {
    const IDX = 'Other Scheme - Index Funds';
    await db.query(`insert into instruments (id, kind, name, currency, isin, scheme_code, metadata)
      values ('MF:ICICI-N50', 'MF', 'ICICI Pru Nifty 50 Index Direct', 'INR', 'INF109K012M7', 'DG5536', jsonb_build_object('amfiCategory', $1::text))`, [IDX]);
    const deps = { amfiUniverse: async () => universe.map((u) => ({ ...u, isin: `INF${u.schemeCode}` })), amfiNavOn: navOn() };
    await recordIndexFundCandidates(db, client, '2026-10-26', deps);
    await recordIndexFundCandidates(db, client, '2026-10-27', deps);
    const rows = await db.query<{ id: string; name: string; isin: string | null; scheme_code: string; metadata: Record<string, unknown> }>(
      `select id, name, isin, scheme_code, metadata from instruments where id like 'MFU:%' and metadata->>'indexType' = 'NIFTY50' order by id`);
    expect(rows).toEqual([{
      id: universeInstrumentId('DG1039539'), name: 'Navi Nifty 50 Index Fund', isin: 'INFDG1039539', scheme_code: 'DG1039539',
      metadata: { indexChallenger: true, category: IDX, indexType: 'NIFTY50', benchmark: 'Nifty 50 TR INR', asOf: '2026-10-27', source: 'indmoney-mcp' },
    }]);
    await expect(logSipMove(db, {
      on: '2026-10-27', fromInstrumentId: 'MF:ICICI-N50', toInstrumentId: 'MFU:DG1039539', amountPaise: 1_400_100n, firstMonth: '2026-11', note: '',
    }, '2026-10-27T12:00:00Z')).resolves.toMatchObject({ id: expect.any(String) });
  });

  // Batch B §3: a lump sum may go to an index fund of a type no held fund tracks, so the
  // chooser's picks are instruments even then, filed under their own AMFI category.
  it('registers the Next 50 top and alternatives when no Next 50 fund is held, with the AMFI category of the ranked row', async () => {
    const IDX = 'Other Scheme - Index Funds';
    const deps = { amfiUniverse: async () => universe.map((u) => ({ ...u, isin: `INF${u.schemeCode}`, category: IDX })), amfiNavOn: navOn() };
    await recordIndexFundCandidates(db, client, '2026-10-26', deps);
    const rows = await db.query<{ id: string; name: string; metadata: Record<string, unknown> }>(
      `select id, name, metadata from instruments where id like 'MFU:%' and metadata->>'indexType' = 'NEXT50' order by id`);
    const c = chooseIndexFund((await loadIndexFundRows(db)).rows, 'NEXT50');
    expect(rows.map((r) => r.name).sort()).toEqual([c.top!, ...c.alternatives].map((r) => r.name).sort());
    expect(rows.map((r) => r.metadata['category'])).toEqual([IDX, IDX, IDX]);
    expect(rows[0]!.metadata).toMatchObject({ indexChallenger: true, indexType: 'NEXT50', source: 'indmoney-mcp' });
  });

  it('a fund with no AMFI Direct Growth match is stored with a null scheme code and not proposed', async () => {
    await recordIndexFundCandidates(db, client, '2026-10-26', { amfiUniverse: async () => universe, amfiNavOn: navOn([1042502]) });
    const c = chooseIndexFund((await loadIndexFundRows(db)).rows, 'NEXT50');
    expect(c.top?.name).toBe('Axis Nifty Next 50 Index Fund');
    expect(c.notProposed.find((n) => n.row.indmoneyFundId === '1042502')?.why).toBe('plan not verified as Direct Growth');
  });
});

const row = (over: Partial<IndexFundRow>): IndexFundRow => ({
  fundType: 'NEXT50', indmoneyFundId: '1', name: 'A Nifty Next 50 Index Fund', benchmarkName: 'Nifty Next 50 TR INR',
  amfiSchemeCode: '100', expenseRatioBps: 20, aumPaise: 1_000_000_000_000n, trackingErrorBps: null, sipAllowed: true,
  asOf: '2026-10-26', source: 'indmoney-mcp', ...over,
});

describe('chooseIndexFund', () => {
  it('a row without AUM is not proposed', () => {
    const c = chooseIndexFund([row({ indmoneyFundId: '1' }), row({ indmoneyFundId: '2', expenseRatioBps: 10, aumPaise: null })], 'NEXT50');
    expect(c.top?.indmoneyFundId).toBe('1');
    expect(c.notProposed).toEqual([{ row: expect.objectContaining({ indmoneyFundId: '2' }), why: 'no AUM on record' }]);
  });

  it('a row with no AMFI scheme code is not proposed', () => {
    const c = chooseIndexFund([row({ amfiSchemeCode: null })], 'NEXT50');
    expect(c.top).toBeNull();
    expect(c.notProposed[0]!.why).toBe('plan not verified as Direct Growth');
    expect(c.reason).toBe('no eligible fund — see Not proposed');
  });

  it('the SIP wording only when every in-benchmark fund is closed to SIPs', () => {
    const closed = row({ indmoneyFundId: 'c', sipAllowed: false });
    const offIndex = row({ indmoneyFundId: 'x', benchmarkName: 'Nifty 50 TR INR' });
    expect(chooseIndexFund([closed, offIndex], 'NEXT50').reason).toBe('no eligible fund is open to SIPs');
    expect(chooseIndexFund([row({ ...closed, fundType: 'US', benchmarkName: 'S&P 500 TR USD' })], 'US').reason)
      .toBe('no eligible fund is open to SIPs (RBI overseas limit)');
    // One closed, one open but unverified: the closure is not the whole story.
    expect(chooseIndexFund([closed, row({ indmoneyFundId: 'u', amfiSchemeCode: null })], 'NEXT50').reason)
      .toBe('no eligible fund — see Not proposed');
    // Nothing tracks the index at all.
    expect(chooseIndexFund([offIndex], 'NEXT50').reason).toBe('no eligible fund — see Not proposed');
  });

  it('SIP status unknown is shown but not proposed', () => {
    const c = chooseIndexFund([row({ sipAllowed: null })], 'NEXT50');
    expect(c.top).toBeNull();
    expect(c.notProposed[0]!.why).toBe('INDmoney does not say whether SIPs are open');
  });

  it('ties on cost break on tracking error when any eligible row has one, then on AUM', () => {
    const c = chooseIndexFund([
      row({ indmoneyFundId: 'big', aumPaise: 9n, trackingErrorBps: 9 }),
      row({ indmoneyFundId: 'tight', aumPaise: 1n, trackingErrorBps: 3 }),
      row({ indmoneyFundId: 'none', aumPaise: 5n, trackingErrorBps: null }),
    ], 'NEXT50');
    expect(c.trackingErrorAvailable).toBe(true);
    expect([c.top!, ...c.alternatives].map((r) => r.indmoneyFundId)).toEqual(['tight', 'big']);
    expect(c.notProposed[0]).toMatchObject({ row: { indmoneyFundId: 'none' }, why: 'no tracking error on record' });
    const noTe = chooseIndexFund([row({ indmoneyFundId: 'small', aumPaise: 1n }), row({ indmoneyFundId: 'large', aumPaise: 2n })], 'NEXT50');
    expect(noTe.top?.indmoneyFundId).toBe('large');
  });

  it('Nifty 50: the benchmark matches Nifty 50, never Next 50 or Nifty 500', () => {
    const n = (id: string, benchmarkName: string) => row({ fundType: 'NIFTY50', indmoneyFundId: id, benchmarkName });
    const c = chooseIndexFund([n('a', 'NIFTY 50 TRI'), n('b', 'Nifty Next 50 TRI'), n('c', 'Nifty 500 TRI')], 'NIFTY50');
    expect(c.top?.indmoneyFundId).toBe('a');
    expect(c.notProposed.map((x) => x.why)).toEqual(['tracks Nifty Next 50 TRI, not Nifty 50', 'tracks Nifty 500 TRI, not Nifty 50']);
  });

  it('Nifty 50: plain Nifty 50 total return only — Equal Weight, Value 20 and Shariah are other indices', () => {
    const n = (id: string, benchmarkName: string) => row({ fundType: 'NIFTY50', indmoneyFundId: id, benchmarkName });
    // 'Nifty 50 TR INR' is what every nifty-50-index-funds fund reported live 2026-10-28.
    const plain = ['Nifty 50 TR INR', 'NIFTY 50 TRI', 'Nifty 50 Total Return Index'];
    const other = ['Nifty 50 Equal Weight TRI', 'Nifty50 Value 20 TRI', 'Nifty 50 Value 20 TRI', 'Nifty 50 Shariah TRI'];
    const c = chooseIndexFund([...plain, ...other].map((b, i) => n(String(i), b)), 'NIFTY50');
    expect([c.top!, ...c.alternatives].map((r) => r.benchmarkName)).toEqual(plain);
    expect(c.notProposed.map((x) => x.why)).toEqual(other.map((b) => `tracks ${b}, not Nifty 50`));
  });

  it('US: NASDAQ-100 counts, a FANG+ benchmark does not', () => {
    const c = chooseIndexFund([
      row({ fundType: 'US', indmoneyFundId: 'n', benchmarkName: 'NASDAQ-100 TR USD' }),
      row({ fundType: 'US', indmoneyFundId: 'f', benchmarkName: 'NYSE FANG+ TR USD', expenseRatioBps: 3 }),
    ], 'US');
    expect(c.top?.indmoneyFundId).toBe('n');
    expect(c.notProposed[0]).toMatchObject({ row: { indmoneyFundId: 'f' }, why: 'tracks NYSE FANG+ TR USD, not S&P 500 or NASDAQ-100' });
  });
});
