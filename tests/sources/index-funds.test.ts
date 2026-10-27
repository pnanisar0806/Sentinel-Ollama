import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { McpClient } from '../../src/sources/mcp-client.js';
import type { NavRow, UniverseRow } from '../../src/sources/amfi.js';
import {
  chooseIndexFund, loadIndexFundRows, recordIndexFundCandidates, type IndexFundRow,
} from '../../src/sources/index-funds.js';

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
const details = new Map(fx.get_mf_funds_details.flatMap((c) => c.result.data).map((d) => [String(d.fund_id), d]));

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
const all = [...NEXT50, ...US];
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
    expect(r.stored).toBe(NEXT50.length + US.length);
    const rows = await db.query<{ n: number; src: string; d: string }>(
      `select count(*)::int as n, min(source) as src, min(as_of)::text as d from index_fund_candidates`);
    expect(rows[0]).toEqual({ n: NEXT50.length + US.length, src: 'indmoney-mcp', d: '2026-10-26' });
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

  it('US: NASDAQ-100 counts, a FANG+ benchmark does not', () => {
    const c = chooseIndexFund([
      row({ fundType: 'US', indmoneyFundId: 'n', benchmarkName: 'NASDAQ-100 TR USD' }),
      row({ fundType: 'US', indmoneyFundId: 'f', benchmarkName: 'NYSE FANG+ TR USD', expenseRatioBps: 3 }),
    ], 'US');
    expect(c.top?.indmoneyFundId).toBe('n');
    expect(c.notProposed[0]).toMatchObject({ row: { indmoneyFundId: 'f' }, why: 'tracks NYSE FANG+ TR USD, not S&P 500 or NASDAQ-100' });
  });
});
