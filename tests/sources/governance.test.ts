import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { backfillGovernance, bseEventFields, governanceStatus, isGovernanceEvent } from '../../src/sources/news.js';

/**
 * Piece 3 Task 1: the governance-event leg of the management check. Every row below is a
 * verbatim BSE capture (fetchBseAnnouncements per scrip, 2026-10-26); the scrip and month
 * are in each file name. No row is hand-written or edited.
 */
type Row = Record<string, unknown>;
const load = (f: string) => (JSON.parse(readFileSync(`tests/fixtures/bse/${f}`, 'utf8')) as { Table: Row[] }).Table;
const FILES = [
  'reliance-infra-500390-2026-01.json', 'rpp-infra-533284-2026-07.json', 'sammaan-535789-2023-10-2026-10.json',
  'siti-networks-532795-2026-10.json', 'sun-granite-531013-2026-08.json', '3i-infotech-532628-2026-08.json',
  'adani-green-541450-2026-09.json', 'indian-hotels-500850-2026-08.json', 'crisil-2026-07-08.json',
  'blb-532290-2026-10.json', 'broach-lifecare-544231-2026-08.json',
];
const all = FILES.flatMap(load);
const row = (idPrefix: string) => {
  const hits = all.filter((r) => String(r['NEWSID']).startsWith(idPrefix));
  expect(hits).toHaveLength(1);
  return hits[0]!;
};
const kind = (idPrefix: string) => isGovernanceEvent(bseEventFields(row(idPrefix)));

describe('isGovernanceEvent', () => {
  it('flags a statutory auditor resignation', () => {
    expect(kind('59cb7983')).toBe('auditor_resignation'); // Reliance Infrastructure, 2026-01-24
  });

  it('does not flag an internal or secretarial auditor leaving', () => {
    expect(kind('dd86f10d')).toBeNull(); // BLB: "resignation of Internal Auditors"
    expect(kind('08a6a544')).toBeNull(); // Broach Lifecare: "resignation of Secretarial Auditor"
  });

  it('flags a rating filing only when its text says downgrade', () => {
    expect(kind('3474b871')).toBe('rating_downgrade'); // RPP Infra: "...reason for downgrade..."
    expect(kind('aee6616e')).toBeNull(); // RPP Infra: "Revision in Credit Ratings" — direction is in the PDF
    expect(kind('99992c1d')).toBeNull(); // Sammaan: "revised by CARE to AA-" — direction not stated
  });

  it('flags a default, an insolvency admission, a fraud and a SEBI order', () => {
    expect(kind('6d10be3b')).toBe('default_insolvency'); // Siti Networks: default on bank loans
    expect(kind('8f9c68a0')).toBe('default_insolvency'); // Sun Granite: NCLT admission (CIRP)
    expect(kind('cdd58dc4')).toBe('fraud'); // 3i Infotech: "Frauds-Subsequent Disclosure"
    expect(kind('12a196f0')).toBe('sebi_order'); // Adani Green: "Settlement Order From SEBI"
  });

  it('never flags the periodic quarterly default-disclosure form by itself', () => {
    // SEBI's quarterly C1 return is often filed NIL; only the event-based (24-hour) disclosure is a default.
    expect(kind('94240b93')).toBeNull(); // Siti Networks: "Quarterly Disclosures ... of defaults"
    expect(kind('6d10be3b')).toBe('default_insolvency'); // Siti Networks: the event-based disclosure
  });

  it('never flags litigation, a non-SEBI penalty, a clarification or a SAST disclosure', () => {
    expect(kind('52d4556b')).toBeNull(); // Sammaan: High Court dismisses a PIL
    expect(kind('47036266')).toBeNull(); // Sammaan: interim order of the Delhi High Court
    expect(kind('b2196099')).toBeNull(); // 3i Infotech: order of the Commissioner of Income Tax (Appeals)
    expect(kind('4c75e196')).toBeNull(); // Indian Hotels: penalty on property tax
    expect(kind('3e56d275')).toBeNull(); // Sammaan: clarification sought by the exchange
    expect(kind('3458e2b4')).toBeNull(); // 3i Infotech: Reg 29(1) SAST disclosure
    expect(kind('d04dcce6')).toBeNull(); // Sammaan: appoints a head of the Fraud Control Unit
  });

  it('across every captured filing, flags exactly the known events', () => {
    const flagged = all.filter((r) => isGovernanceEvent(bseEventFields(r)) !== null).map((r) => String(r['NEWSID']).slice(0, 8));
    expect(all.length).toBeGreaterThan(500);
    expect(flagged.sort()).toEqual([
      '12a196f0', // Adani Green — SEBI settlement order
      '38816437', '6d10be3b', 'c9cd1bb1', // Siti Networks — event-based default, CIRP updates
      '3474b871', // RPP Infra — downgrade
      '48918e30', '5218fa38', '85a15efa', '8f9c68a0', '95073d95', '9bd7e497', 'f69a6652', // Sun Granite — CIRP
      '59cb7983', // Reliance Infrastructure — auditor resignation
      'cdd58dc4', 'ee3fbe3c', // 3i Infotech — fraud disclosures
    ].sort());
  });
});

describe('backfill and status', () => {
  let db: Db;
  const scrips = [{ scrip: '500390', isin: 'INE036A01016', symbol: 'RELINFRA', names: ['Reliance Infrastructure Ltd'] }];
  const relinfra = load('reliance-infra-500390-2026-01.json');
  /** Serves each month request only the captured rows dated inside that month. */
  const bse = (rows: Row[]) => (async (url: string) => {
    const q = new URL(url).searchParams;
    const ymd = (k: string) => q.get(k)!.replace(/(\d{4})(\d\d)(\d\d)/, '$1-$2-$3');
    const inWindow = rows.filter((r) => { const d = String(r['NEWS_DT']).slice(0, 10); return d >= ymd('strPrevDate') && d <= ymd('strToDate'); });
    return { ok: true, json: async () => ({ Table: inWindow }) };
  }) as unknown as typeof fetch;
  const down = (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
  const NOW = new Date('2028-01-20T10:00:00Z'); // the auditor resignation of 2026-01-24 is ~2 years old
  const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000);

  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await db.query(`insert into instruments (id, kind, name, currency, isin)
      values ('NSE:RELINFRA', 'EQUITY', 'Reliance Infrastructure Ltd', 'INR', 'INE036A01016')`);
  });

  it('is UNCHECKED with no backfill run', async () => {
    expect(await governanceStatus(db, 'NSE:RELINFRA', NOW)).toMatchObject({ status: 'UNCHECKED', checkedAt: null });
    await db.close();
  });

  it('is CLEAR after a successful empty backfill, and UNCHECKED once it is 36 days old', async () => {
    const r = await backfillGovernance(db, 'NSE:RELINFRA', NOW, { fetchImpl: bse([]), scrips });
    expect(r).toEqual({ state: 'success_empty', stored: 0 });
    expect(await governanceStatus(db, 'NSE:RELINFRA', days(35))).toMatchObject({ status: 'CLEAR', events: [] });
    expect(await governanceStatus(db, 'NSE:RELINFRA', days(36))).toMatchObject({ status: 'UNCHECKED' });
    await db.close();
  });

  it('is EVENT after a backfill that stored an auditor resignation two years ago', async () => {
    const r = await backfillGovernance(db, 'NSE:RELINFRA', NOW, { fetchImpl: bse(relinfra), scrips });
    expect(r.state).toBe('success');
    expect(r.stored).toBeGreaterThan(0);
    const s = await governanceStatus(db, 'NSE:RELINFRA', NOW);
    expect(s.status).toBe('EVENT');
    expect(s.events).toEqual([{ on: '2026-01-24', kind: 'auditor_resignation', headline: String(row('59cb7983')['HEADLINE']) }]);
    expect(s.checkedAt).toBe(NOW.toISOString());
    await db.close();
  });

  it('stores a governance event BSE filed under a category the news filter calls noise', async () => {
    // Adani Green's SEBI settlement order is filed as "General", which classifyBseEvent drops.
    const adani = load('adani-green-541450-2026-09.json');
    await db.query(`insert into instruments (id, kind, name, currency, isin)
      values ('NSE:ADANIGREEN', 'EQUITY', 'Adani Green Energy Ltd', 'INR', 'INE364U01010')`);
    const adaniScrips = [{ scrip: '541450', isin: 'INE364U01010', symbol: 'ADANIGREEN', names: ['Adani Green Energy Ltd'] }];
    await backfillGovernance(db, 'NSE:ADANIGREEN', NOW, { fetchImpl: bse(adani), scrips: adaniScrips });
    const s = await governanceStatus(db, 'NSE:ADANIGREEN', NOW);
    expect(s.status).toBe('EVENT');
    expect(s.events.map((e) => e.kind)).toEqual(['sebi_order']);
    await db.close();
  });

  it('writes one run covering three years', async () => {
    await backfillGovernance(db, 'NSE:RELINFRA', NOW, { fetchImpl: bse([]), scrips });
    const runs = await db.query<{ window_from: string; window_to: string; state: string }>(
      `select window_from::text, window_to::text, state from news_fetch_runs where instrument_id = 'NSE:RELINFRA'`);
    expect(runs).toEqual([{ window_from: '2025-01-20', window_to: '2028-01-20', state: 'success_empty' }]);
    await db.close();
  });

  it('a failed backfill (HTTP 500) writes a failed run and leaves the status UNCHECKED', async () => {
    expect(await backfillGovernance(db, 'NSE:RELINFRA', NOW, { fetchImpl: down, scrips })).toEqual({ state: 'failed', stored: 0 });
    const runs = await db.query<{ state: string }>(`select state from news_fetch_runs where instrument_id = 'NSE:RELINFRA'`);
    expect(runs).toEqual([{ state: 'failed' }]);
    expect(await governanceStatus(db, 'NSE:RELINFRA', NOW)).toMatchObject({ status: 'UNCHECKED' });
    await db.close();
  });

  it('a 14-day news run is not a governance check', async () => {
    const { recordNews } = await import('../../src/sources/news.js');
    await db.query(`insert into watchlist (instrument_id, added_on, source, reason) values ('NSE:RELINFRA', '2026-01-01', 'owner', 't')`);
    await recordNews(db, { now: NOW, fetchImpl: bse([]), scrips });
    expect(await governanceStatus(db, 'NSE:RELINFRA', NOW)).toMatchObject({ status: 'UNCHECKED' });
    await db.close();
  });
});
