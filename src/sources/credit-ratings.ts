import type { Db } from '../db/client.js';

/**
 * Credit-rating actions on the issuers of held bonds, from BSE (IPS §3.8).
 *
 * SEBI LODR Reg 30 obliges a listed issuer to disclose every rating action to the
 * exchange within 24 hours, so BSE's "Credit Rating" announcements are the official,
 * complete record. The rating agencies' own sites are JavaScript-rendered and give
 * nothing machine-readable; NSDL's bond portal has no public rating endpoint.
 *
 * What this does NOT do: say whether the action was a downgrade. That is in the attached
 * PDF, which is linked. See migration 0027.
 */

/**
 * The BSE scrip of each bond issuer the owner holds, keyed on the issuer part of an ISIN
 * (its first seven characters, shared by all of one issuer's securities).
 *
 * Explicit rather than looked up, and each entry verified against BSE on 2026-09-25:
 * 535789 returned Sammaan Capital's filings (including the Reg 57 principal-payment
 * certificate for the 2026 bond), and 532922 returned "Edelweiss Financial Services Ltd".
 * A held bond whose issuer is missing here is reported as UNWATCHED, never silently
 * skipped — see `watchedIssuers`.
 */
export const ISSUER_BSE_SCRIP: Record<string, { scrip: string; company: string }> = {
  INE148I: { scrip: '535789', company: 'Sammaan Capital' },
  INE532F: { scrip: '532922', company: 'Edelweiss Financial Services' },
};

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.bseindia.com/',
  Origin: 'https://www.bseindia.com',
};

export interface RatingFiling {
  newsId: string;
  bseScrip: string;
  company: string;
  filedAt: string;
  headline: string;
  attachmentUrl: string | null;
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, '');

/**
 * Rating filings for one scrip over a window.
 *
 * Queried a month at a time: the endpoint returned nothing at all for a twenty-month
 * range on 2026-09-25 while the same months one at a time returned 409 announcements.
 */
export async function fetchRatingFilings(
  scrip: string, from: Date, to: Date, fetchImpl: typeof fetch = fetch,
): Promise<RatingFiling[]> {
  const out: RatingFiling[] = [];
  for (let start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); start <= to;
    start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))) {
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    for (let page = 1; page <= 10; page++) {
      const url = 'https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w'
        + `?pageno=${page}&strCat=-1&strPrevDate=${ymd(start)}&strScrip=${scrip}`
        + `&strSearch=P&strToDate=${ymd(end < to ? end : to)}&strType=C&subcategory=-1`;
      const res = await fetchImpl(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`BSE announcements ${scrip}: HTTP ${res.status}`);
      const rows = ((await res.json()) as { Table?: Record<string, unknown>[] }).Table ?? [];
      for (const r of rows) {
        if (!/credit rating/i.test(String(r['SUBCATNAME'] ?? r['HEADLINE'] ?? ''))) continue;
        const attachment = String(r['ATTACHMENTNAME'] ?? '');
        out.push({
          newsId: String(r['NEWSID']),
          bseScrip: scrip,
          company: String(r['SLONGNAME'] ?? ''),
          filedAt: String(r['NEWS_DT']),
          headline: String(r['NEWSSUB'] ?? r['HEADLINE'] ?? ''),
          attachmentUrl: attachment
            ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${attachment}` : null,
        });
      }
      if (rows.length < 50) break;
    }
  }
  return out;
}

/** Issuer prefixes of the bonds currently held, split into watched and not. */
export async function watchedIssuers(db: Db): Promise<{ watched: string[]; unwatched: string[] }> {
  const rows = await db.query<{ isin: string | null; id: string }>(
    `select distinct coalesce(i.isin, case when i.id like 'ISIN:%' then substr(i.id, 6) end) as isin, i.id
       from holdings h
       join snapshots s on s.id = h.snapshot_id
       join instruments i on i.id = h.instrument_id
      where i.kind = 'BOND'
        and s.id in (select distinct on (source) id from snapshots order by source, business_date desc, id desc)`,
  );
  const prefixes = new Set(rows.map((r) => r.isin).filter((x): x is string => !!x).map((x) => x.slice(0, 7)));
  const watched = [...prefixes].filter((p) => p in ISSUER_BSE_SCRIP).sort();
  const unwatched = [...prefixes].filter((p) => !(p in ISSUER_BSE_SCRIP)).sort();
  return { watched, unwatched };
}

/** Fetches and stores new filings for every watched issuer. Idempotent on BSE's id. */
export async function recordRatingFilings(
  db: Db, opts: { months?: number; now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<{ written: number; unwatched: string[] }> {
  const now = opts.now ?? new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - ((opts.months ?? 2) - 1), 1));
  const { watched, unwatched } = await watchedIssuers(db);
  let written = 0;
  for (const prefix of watched) {
    const { scrip } = ISSUER_BSE_SCRIP[prefix]!;
    for (const f of await fetchRatingFilings(scrip, from, now, opts.fetchImpl)) {
      const rows = await db.query<{ id: string }>(
        `insert into credit_rating_filings
           (news_id, issuer_prefix, bse_scrip, company, filed_at, headline, attachment_url, as_of)
         values ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8)
         on conflict (news_id) do nothing returning id`,
        [f.newsId, prefix, scrip, f.company || ISSUER_BSE_SCRIP[prefix]!.company,
         f.filedAt, f.headline, f.attachmentUrl, now.toISOString()],
      );
      written += rows.length;
    }
  }
  return { written, unwatched };
}

export interface StoredFiling {
  company: string; filedAt: string; headline: string; attachmentUrl: string | null;
}

/** Filings on record since `since`, newest first. */
export async function loadRatingFilings(db: Db, since: string): Promise<StoredFiling[]> {
  const rows = await db.query<{ company: string; filed_at: string | Date; headline: string; attachment_url: string | null }>(
    `select company, filed_at, headline, attachment_url from credit_rating_filings
      where filed_at >= $1::timestamptz order by filed_at desc`,
    [since],
  );
  return rows.map((r) => ({
    company: r.company,
    filedAt: new Date(r.filed_at).toISOString(),
    headline: r.headline,
    attachmentUrl: r.attachment_url,
  }));
}
