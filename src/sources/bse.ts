/**
 * BSE corporate announcements — the one fetcher for every feed built on them (credit
 * ratings, material news). SEBI LODR Reg 30 obliges a listed company to file material
 * events here, so it is the official record for held and watched companies.
 */

const BSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'application/json, text/plain, */*',
  Referer: 'https://www.bseindia.com/',
  Origin: 'https://www.bseindia.com',
};

export type BseRow = Record<string, unknown>;

const ymd = (d: Date): string => d.toISOString().slice(0, 10).replace(/-/g, '');

/**
 * Every announcement for one scrip over a window, all categories.
 *
 * Queried a month at a time: the endpoint returned nothing at all for a twenty-month
 * range on 2026-09-25 while the same months one at a time returned 409 announcements.
 * An error response throws — it is never read as "no announcements".
 */
export async function fetchBseAnnouncements(
  scrip: string, from: Date, to: Date, fetchImpl: typeof fetch = fetch,
): Promise<BseRow[]> {
  const out: BseRow[] = [];
  for (let start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1)); start <= to;
    start = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))) {
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
    for (let page = 1; page <= 10; page++) {
      const url = 'https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w'
        + `?pageno=${page}&strCat=-1&strPrevDate=${ymd(start)}&strScrip=${scrip}`
        + `&strSearch=P&strToDate=${ymd(end < to ? end : to)}&strType=C&subcategory=-1`;
      const res = await fetchImpl(url, { headers: BSE_HEADERS });
      if (!res.ok) throw new Error(`BSE announcements ${scrip}: HTTP ${res.status}`);
      const rows = ((await res.json()) as { Table?: BseRow[] }).Table ?? [];
      out.push(...rows);
      if (rows.length < 50) break;
    }
  }
  return out;
}

export const attachmentUrl = (r: BseRow): string | null => {
  const a = String(r['ATTACHMENTNAME'] ?? '');
  return a ? `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${a}` : null;
};

export interface BseScrip { scrip: string; isin: string | null; symbol: string | null; names: string[] }

/** Every active BSE equity: scrip code, ISIN, trading symbol and names. */
export async function fetchBseScrips(fetchImpl: typeof fetch = fetch): Promise<BseScrip[]> {
  const res = await fetchImpl(
    'https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w?Group=&Scripcode=&industry=&segment=Equity&status=Active',
    { headers: BSE_HEADERS },
  );
  if (!res.ok) throw new Error(`BSE scrip list: HTTP ${res.status}`);
  const rows = (await res.json()) as Record<string, unknown>[];
  if (rows.length < 1000) throw new Error(`BSE scrip list looks truncated: ${rows.length} rows`);
  return rows.filter((r) => r['SCRIP_CD']).map((r) => ({
    scrip: String(r['SCRIP_CD']),
    isin: r['ISIN_NUMBER'] ? String(r['ISIN_NUMBER']) : null,
    symbol: r['scrip_id'] ? String(r['scrip_id']).toUpperCase() : null,
    names: [r['Scrip_Name'], r['Issuer_Name']].filter(Boolean).map(String),
  }));
}

const normName = (n: string): string =>
  n.toLowerCase().replace(/&/g, ' and ').replace(/\b(limited|ltd|the|india|co|company|corporation|corp)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Finds a company's BSE scrip: by ISIN, then by trading symbol (BSE's id usually equals
 * the NSE symbol), then by exact normalised name — and a name only when exactly one
 * company carries it. Anything else is unresolved; a guess would attach another
 * company's filings to a holding.
 */
export function bseResolver(scrips: BseScrip[]): (i: { isin: string | null; symbol: string | null; name: string }) => string | null {
  const byIsin = new Map<string, string>(); const bySymbol = new Map<string, string>(); const byName = new Map<string, string[]>();
  for (const s of scrips) {
    if (s.isin) byIsin.set(s.isin, s.scrip);
    if (s.symbol) bySymbol.set(s.symbol, s.scrip);
    for (const n of new Set(s.names.map(normName))) byName.set(n, [...(byName.get(n) ?? []), s.scrip]);
  }
  return ({ isin, symbol, name }) => {
    if (isin && byIsin.has(isin)) return byIsin.get(isin)!;
    if (symbol && bySymbol.has(symbol.toUpperCase())) return bySymbol.get(symbol.toUpperCase())!;
    const hits = [...new Set(byName.get(normName(name)) ?? [])];
    return hits.length === 1 ? hits[0]! : null;
  };
}
