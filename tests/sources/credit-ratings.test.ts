import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  fetchRatingFilings, ISSUER_BSE_SCRIP, loadRatingFilings, recordRatingFilings, watchedIssuers,
} from '../../src/sources/credit-ratings.js';

/**
 * IPS §3.8. Sell trigger 7 watched maturities only, so a downgrade of Sammaan or
 * Edelweiss could happen with nothing noticing. BSE's Reg 30 "Credit Rating" filings are
 * the official record of every rating action. The row shape below is BSE's real one,
 * trimmed from a live call on 2026-09-25.
 */
const bseRow = (over: Record<string, unknown> = {}) => ({
  NEWSID: 'e2a5aabf-aca7-425c-8ea6-cc933574aaa3',
  SCRIP_CD: 532922,
  NEWSSUB: 'Announcement under Regulation 30 (LODR)-Credit Rating',
  NEWS_DT: '2026-08-27T18:00:24.553',
  ATTACHMENTNAME: 'f8a7db96-76f7-4e06-8d2e-83616263b486.pdf',
  HEADLINE: 'Credit Rating',
  SLONGNAME: 'Edelweiss Financial Services Ltd',
  SUBCATNAME: 'Credit Rating',
  ...over,
});

const bse = (rows: Record<string, unknown>[]) =>
  (async () => ({ ok: true, json: async () => ({ Table: rows }) })) as unknown as typeof fetch;

describe('reading BSE filings', () => {
  it('keeps the rating filings and drops everything else an issuer files', async () => {
    const out = await fetchRatingFilings('532922', new Date('2026-08-01'), new Date('2026-08-31'), bse([
      bseRow(),
      bseRow({ NEWSID: 'x', SUBCATNAME: 'Interest Payment', HEADLINE: 'Interest Payment',
        NEWSSUB: 'Compliances-Reg. 57 (1) - Certificate of interest payment' }),
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]!.company).toBe('Edelweiss Financial Services Ltd');
    expect(out[0]!.attachmentUrl).toBe(
      'https://www.bseindia.com/xml-data/corpfiling/AttachLive/f8a7db96-76f7-4e06-8d2e-83616263b486.pdf');
  });

  it('queries a month at a time, because BSE returns nothing for a long range', async () => {
    const urls: string[] = [];
    const f = (async (u: string) => { urls.push(u); return { ok: true, json: async () => ({ Table: [] }) }; }) as unknown as typeof fetch;
    await fetchRatingFilings('532922', new Date('2026-07-15'), new Date('2026-09-25'), f);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('strPrevDate=20260701');
    expect(urls[2]).toContain('strToDate=20260925');
  });

  it('refuses an error response rather than reading it as no filings', async () => {
    const f = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    await expect(fetchRatingFilings('532922', new Date('2026-09-01'), new Date('2026-09-25'), f))
      .rejects.toThrow(/503/);
  });
});

describe('which issuers are watched', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await db.query(`insert into instruments (id, kind, name, currency, isin) values
      ('ISIN:INE532F07EK1', 'BOND', 'Edelweiss 2033', 'INR', null),
      ('BOND:OTHER', 'BOND', 'Unknown issuer bond', 'INR', 'INE999Z07AA1')`);
    const [s] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source) values (date '2026-09-24', 'indmoney') returning id`);
    for (const id of ['ISIN:INE532F07EK1', 'BOND:OTHER']) {
      await db.query(
        `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
         values ($1, $2, 'indmoney', 1, 100000, 'indmoney', timestamptz '2026-09-24T12:00:00Z')`, [s!.id, id]);
    }
  });

  it('watches a mapped issuer and reports an unmapped one instead of skipping it', async () => {
    expect(await watchedIssuers(db)).toEqual({ watched: ['INE532F'], unwatched: ['INE999Z'] });
    await db.close();
  });

  it('stores each filing once however often sync runs', async () => {
    const f = bse([bseRow()]);
    const now = new Date('2026-09-25T00:00:00Z');
    expect((await recordRatingFilings(db, { months: 1, now, fetchImpl: f })).written).toBe(1);
    expect((await recordRatingFilings(db, { months: 1, now, fetchImpl: f })).written).toBe(0);
    const stored = await loadRatingFilings(db, '2026-01-01T00:00:00Z');
    expect(stored.map((s) => s.company)).toEqual(['Edelweiss Financial Services Ltd']);
    await db.close();
  });
});

describe('the issuer map', () => {
  it('names the two issuers held, each verified against BSE', () => {
    expect(ISSUER_BSE_SCRIP['INE148I']!.scrip).toBe('535789');
    expect(ISSUER_BSE_SCRIP['INE532F']!.scrip).toBe('532922');
  });
});
