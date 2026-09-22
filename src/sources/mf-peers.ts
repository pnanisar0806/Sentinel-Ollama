import type { McpClient } from './mcp-client.js';
import { parseNavText, type NavRow } from './amfi.js';

/**
 * Same-category peer funds, from INDmoney.
 *
 * `mf_switch` needs somewhere to switch TO. The only funds on record are the six held,
 * five of them alone in their category, so until now the engine had nothing to compare
 * against. Owner decision 2026-09-21: use INDmoney's category listing as the universe.
 */
export interface PeerFund {
  /** INDmoney's own fund id. NOT an AMFI scheme code — see `resolvePeerToAmfi`. */
  fundId: string;
  name: string;
  category: string;
  expenseRatioPct: number | null;
  aumCrore: number | null;
  nav: number | null;
  /** The day that NAV is for, as INDmoney reports it ('18 Sep 2026'). The fingerprint
   *  is only valid against AMFI's file for the SAME day. */
  navDate: string | null;
  /** Whether INDmoney will actually let the owner buy it. */
  purchaseAllowed: boolean;
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** `"108325 Cr"` -> 108325. INDmoney returns AUM as a formatted string here, unlike
 *  `get_mf_funds_details`, which returns a bare number. */
export function parseAumCrore(v: unknown): number | null {
  if (typeof v === 'number') return num(v);
  if (typeof v !== 'string') return null;
  const m = v.replace(/,/g, '').match(/([0-9]+(?:\.[0-9]+)?)/);
  return m ? Number(m[1]) : null;
}

export async function fetchCategoryPeers(
  client: McpClient,
  categories: readonly string[],
  size = 12,
): Promise<PeerFund[]> {
  if (categories.length === 0) return [];
  const envelope = await client.callTool<{ result?: string }>(
    'get_mf_by_category', { categories, size, sort_key: 'category_ind_rank', sort_asc: true },
  );
  if (typeof envelope?.result !== 'string') {
    throw new Error(
      'could not parse INDmoney get_mf_by_category payload — the tool contract changed; '
      + 'recapture the fixture before trusting this',
    );
  }
  const payload = JSON.parse(envelope.result) as {
    error?: string; data?: Record<string, unknown>[];
  };
  if (payload.error) throw new Error(`INDmoney refused get_mf_by_category: ${payload.error}`);
  if (!Array.isArray(payload.data)) {
    throw new Error('could not parse INDmoney get_mf_by_category payload — no data array');
  }

  return payload.data.map((d) => ({
    fundId: String(d['id']),
    name: String(d['name'] ?? '').trim(),
    category: String(d['category'] ?? '').trim(),
    expenseRatioPct: num(d['expense_ratio']),
    aumCrore: parseAumCrore(d['aum']),
    nav: num(d['nav']),
    navDate: typeof d['nav_date'] === 'string' ? d['nav_date'] : null,
    // A fund INDmoney will not sell is not an alternative, however well it scores.
    purchaseAllowed: d['purchase_allowed'] !== false,
  }));
}

export interface ResolvedPeer extends PeerFund {
  schemeCode: string;
  isin: string;
}

/**
 * Joins a peer to its AMFI scheme, so its NAV history can be scored by our own engine.
 *
 * INDmoney's fund id is not an AMFI scheme code and its payload carries no ISIN, so the
 * only bridge is the fund itself. Name alone is not enough — that is precisely how four
 * seeded funds ended up pointing at their IDCW variants, and a name match would pick the
 * wrong plan again. So a peer resolves only when the AMFI row is BOTH:
 *
 *   - a Direct plan whose scheme name contains the peer's name, and
 *   - carrying the same NAV, to the paisa, on the same day.
 *
 * The NAV is a fingerprint: two plans of one fund have visibly different NAVs (HDFC Mid
 * Cap's four AMFI rows read 230.669, 207.974, 81.906 and 52.178 on the same day), and
 * two different funds agreeing to the paisa is vanishingly unlikely. A peer that fails
 * either test is dropped and counted, never guessed at.
 *
 * **The comparison is only valid on a shared date.** AMFI's daily file rolls forward
 * while INDmoney still reports the previous session, so `amfiRows` must be the file for
 * the peer's own `navDate`, not whatever is current. Matching across dates silently
 * fails for every fund, which is what it did the first time this ran.
 */
export function resolvePeerToAmfi(
  peer: PeerFund,
  amfiRows: readonly NavRow[],
  tolerance = 0.01,
): ResolvedPeer | null {
  if (peer.nav === null) return null;
  const needle = peer.name.toLowerCase().replace(/\s+/g, ' ').trim();

  const match = amfiRows.find((r) => {
    const name = r.schemeName.toLowerCase();
    if (!name.includes(needle)) return false;
    return Math.abs(r.nav - peer.nav!) <= tolerance;
  });
  if (!match) return null;

  const isin = match.isinDivPayout ?? match.isinDivReinvestment;
  if (isin === null) return null;
  return { ...peer, schemeCode: match.schemeCode, isin };
}

/** Resolves a whole set, reporting what could not be joined rather than dropping it quietly. */
export function resolvePeers(
  peers: readonly PeerFund[],
  /** AMFI rows for the SAME session the peers' NAVs are quoted for. */
  amfiRows: readonly NavRow[] | string,
): { resolved: ResolvedPeer[]; unresolved: string[] } {
  const rows = typeof amfiRows === 'string' ? parseNavText(amfiRows) : amfiRows;
  const resolved: ResolvedPeer[] = [];
  const unresolved: string[] = [];
  for (const p of peers) {
    const hit = resolvePeerToAmfi(p, rows);
    if (hit) resolved.push(hit); else unresolved.push(p.name);
  }
  return { resolved, unresolved };
}

/** AMFI's category heading mapped to INDmoney's category slug. */
export const INDMONEY_CATEGORY_SLUG: Record<string, string> = {
  'Equity Scheme - Flexi Cap Fund': 'flexi-cap',
  'Equity Scheme - Large Cap Fund': 'large-cap',
  'Equity Scheme - Mid Cap Fund': 'mid-cap',
  'Equity Scheme - Small Cap Fund': 'small-cap',
};

/**
 * Every fund INDmoney lists in a category, paged out.
 *
 * `get_mf_by_category` returns 6 per page by default and reports `count`. Without this
 * the candidate universe has AMFI's NAV history but no cost or size, and a cohort where
 * only the holding has those two scores the holding 35 points ahead by construction —
 * a comparison that always says hold, for a reason that is not about the funds.
 */
export async function fetchAllInCategory(
  client: McpClient,
  category: string,
  pageSize = 50,
  maxPages = 6,
): Promise<PeerFund[]> {
  const out: PeerFund[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const envelope = await client.callTool<{ result?: string }>(
      'get_mf_by_category',
      { categories: [category], size: pageSize, page, sort_key: 'aum', sort_asc: false },
    );
    if (typeof envelope?.result !== 'string') break;
    const payload = JSON.parse(envelope.result) as {
      data?: Record<string, unknown>[]; next_page?: boolean;
    };
    if (!Array.isArray(payload.data) || payload.data.length === 0) break;
    for (const d of payload.data) {
      out.push({
        fundId: String(d['id']),
        name: String(d['name'] ?? '').trim(),
        category: String(d['category'] ?? category).trim(),
        expenseRatioPct: typeof d['expense_ratio'] === 'number' ? d['expense_ratio'] : null,
        aumCrore: parseAumCrore(d['aum']),
        nav: typeof d['nav'] === 'number' ? d['nav'] : null,
        navDate: typeof d['nav_date'] === 'string' ? d['nav_date'] : null,
        purchaseAllowed: d['purchase_allowed'] !== false,
      });
    }
    if (payload.next_page !== true) break;
  }
  return out;
}

/**
 * `'18 Sep 2026'` -> `'2026-09-18'`.
 *
 * `new Date('18 Sep 2026').toISOString()` parses as LOCAL midnight and then converts to
 * UTC, which in IST hands back the PREVIOUS day. Downloading that day's AMFI file made
 * every NAV fingerprint miss: 2 of 153 candidates matched instead of nearly all.
 */
export function isoFromIndmoneyDate(v: string): string | null {
  const m = v.trim().match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})$/);
  if (!m) return null;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun',
                  'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const mi = months.indexOf(m[2]!.toLowerCase());
  if (mi === -1) return null;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
}
