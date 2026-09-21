import type { Db } from '../db/client.js';

/**
 * Sector, from NSE's own index constituent list.
 *
 * `instruments.sector` was set for 34 of 73 watchlist names, with ad-hoc values like
 * 'Beauty E-commerce' and 'Ceramics' that had one member each — so a "sector median
 * P/E" compared a stock against itself, and the valuation relative leg (15 of the
 * satellite composite's 100) scored 0 almost everywhere.
 *
 * The screener's Industry column needs a paid subscription. Kite's instrument master
 * carries no sector at all (checked: id, tradingsymbol, isin, name, series, segment and
 * price fields only), and INDmoney reports `market_cap: "LARGE CAP"` — a size bucket,
 * not a sector — while its own `networth_snapshot` documentation states the portfolio
 * backend has no sector analytics.
 *
 * NSE publishes the classification free, in the constituent list for its Total Market
 * index: `Company Name,Industry,Symbol,Series,ISIN Code`, 755 stocks across 22
 * industries. Verified 2026-09-21 to cover 65 of the 67 equities on the watchlist.
 */
const NSE_TOTAL_MARKET_URL =
  'https://nsearchives.nseindia.com/content/indices/ind_niftytotalmarket_list.csv';

export interface IndustryRow {
  symbol: string;
  isin: string;
  industry: string;
}

/**
 * Columns are read from the END of the row, not the start: a company name can contain a
 * comma ("Sun TV Network Ltd.", and others do), which shifts every field after it. The
 * last four are always Industry, Symbol, Series, ISIN.
 */
export function parseIndustryCsv(text: string): IndustryRow[] {
  const lines = text.trim().split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.length < 2) return [];
  if (!/industry/i.test(lines[0] ?? '')) return [];

  const rows: IndustryRow[] = [];
  for (const line of lines.slice(1)) {
    const p = line.split(',');
    if (p.length < 5) continue;
    const industry = (p[p.length - 4] ?? '').trim();
    const symbol = (p[p.length - 3] ?? '').trim();
    const isin = (p[p.length - 1] ?? '').trim();
    if (!industry || !symbol) continue;
    rows.push({ symbol, isin, industry });
  }
  return rows;
}

export async function downloadIndustries(
  fetchImpl: typeof fetch = fetch,
): Promise<IndustryRow[]> {
  const res = await fetchImpl(NSE_TOTAL_MARKET_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  if (!res.ok) throw new Error(`NSE industry list: HTTP ${res.status}`);
  return parseIndustryCsv(await res.text());
}

/**
 * Writes the industry onto matching instruments.
 *
 * Matches on ISIN first and the `NSE:<symbol>` id second, the same two routes
 * `ingestPrices` uses. An instrument NSE does not list keeps whatever it had:
 * overwriting a known sector with NULL because one source is silent would lose
 * information, and a mutual fund has no equity sector to begin with.
 */
export async function applyIndustries(
  db: Db,
  rows: readonly IndustryRow[],
): Promise<{ updated: number; unmatched: number }> {
  let updated = 0;
  let unmatched = 0;
  for (const r of rows) {
    const done = await db.query<{ id: string }>(
      `update instruments set sector = $1
        where (isin = $2 and $2 <> '') or id = $3
        returning id`,
      [r.industry, r.isin, `NSE:${r.symbol}`],
    );
    if (done.length > 0) updated += done.length; else unmatched += 1;
  }
  return { updated, unmatched };
}
