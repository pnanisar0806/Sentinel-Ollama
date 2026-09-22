import type { Db } from '../db/client.js';
import { rankMfs, type MfCandidate, type MfRanking } from './engine.js';
import { loadMfMetadata } from './mf-metadata.js';
import { loadPositions, type Position } from './networth.js';

/**
 * Ranks the mutual funds actually held.
 *
 * `rankMfs` existed with **zero production callers**, so ~₹12L of MF — the second
 * largest asset class after EPF — had no engine output of any kind. This wires it to
 * real NAVs and real fund facts.
 *
 * It deliberately does NOT produce `mf_switch` recommendations. A switch needs somewhere
 * to switch TO, and the only funds in the system are the six held: five sit alone in
 * their category, so there is no peer to compare them against. Emitting a switch would
 * mean choosing a candidate universe, which is the owner's decision and not one the
 * engine may make for itself.
 */

/** NAV history is daily; consistency is measured over MONTHS. */
export const MONTHS_PER_WINDOW = 12;

/**
 * The last NAV of each month, oldest first.
 *
 * `rankMfs` defaults `rollingWindow` to 12 and its own comment reads "monthly NAV points
 * over a year". `navs` holds ~600 DAILY points per fund, so feeding them in raw would
 * measure a rolling twelve-DAY window and report it as twelve-month consistency —
 * momentum wearing the label of a long-horizon quality metric, on an advisor whose
 * standing instruction is not to trade on short-term price movement.
 */
export async function monthEndNavs(db: Db, instrumentIds: string[]): Promise<Map<string, bigint[]>> {
  if (instrumentIds.length === 0) return new Map();
  const rows = await db.query<{ instrument_id: string; nav_micros: string | number; month: string }>(
    `select distinct on (instrument_id, to_char(nav_date, 'YYYY-MM'))
            instrument_id, nav_micros, to_char(nav_date, 'YYYY-MM') as month
       from navs
      where instrument_id = any($1::text[])
      order by instrument_id, to_char(nav_date, 'YYYY-MM'), nav_date desc`,
    [instrumentIds],
  );
  // DISTINCT ON orders DESC within a month to pick its last day; the series itself must
  // run oldest to newest, which is what `rankMfs` expects. The sort key is the 'YYYY-MM'
  // string the query already produced — `nav_date` comes back as a Date under
  // postgres-js and a string under PGlite, and `String(Date)` is 'Wed Jan 30 2026',
  // which does not sort chronologically.
  const out = new Map<string, { month: string; nav: bigint }[]>();
  for (const r of rows) {
    const list = out.get(r.instrument_id) ?? [];
    list.push({ month: r.month, nav: BigInt(r.nav_micros) });
    out.set(r.instrument_id, list);
  }
  return new Map([...out].map(([id, list]) => [
    id,
    list.sort((a, b) => a.month.localeCompare(b.month)).map((x) => x.nav),
  ]));
}

export interface HeldFund {
  /** The instrument the POSITION is on — `IND:*` for a live INDmoney row. */
  instrumentId: string;
  name: string;
  /** Where the NAV series and fund facts live — `MF:*` for the AMFI-keyed row. */
  navInstrumentId: string;
  valuePaise: bigint;
  category: string | null;
}

/**
 * Held funds, paired with the instrument their NAVs are filed under.
 *
 * AMFI keys the seed `MF:*` rows (they carry the ISIN) while INDmoney keys the live
 * `IND:*` rows, and per-account supersession retires the seed rows from `positions`. The
 * two sides share a `canonical_id`, which is the only thing joining a holding to its
 * price history.
 */
export async function heldFunds(db: Db, positions?: Position[]): Promise<HeldFund[]> {
  const held = (positions ?? await loadPositions(db)).filter((p) => p.kind === 'MF');
  if (held.length === 0) return [];

  const links = await db.query<{
    id: string; canonical_id: string | null; sibling: string | null;
    amfi_category: string | null; sibling_category: string | null;
  }>(
    `select i.id, i.canonical_id,
            (select s.id from instruments s
              where s.canonical_id = i.canonical_id and s.id <> i.id
                and exists (select 1 from navs n where n.instrument_id = s.id)
              limit 1) as sibling,
            i.metadata->>'amfiCategory' as amfi_category,
            (select s.metadata->>'amfiCategory' from instruments s
              where s.canonical_id = i.canonical_id and s.id <> i.id
                and s.metadata->>'amfiCategory' is not null
              limit 1) as sibling_category
       from instruments i
      where i.id = any($1::text[])`,
    [held.map((p) => p.instrumentId)],
  );
  const siblingOf = new Map(links.map((l) => [l.id, l.sibling]));
  // AMFI classifies every scheme; INDmoney only the ones it has been asked about. The
  // category may be stamped on either side of the MF:*/IND:* pair.
  const amfiCategoryOf = new Map(
    links.map((l) => [l.id, l.amfi_category ?? l.sibling_category]),
  );
  const metadata = await loadMfMetadata(db);

  return held.map((p) => {
    // Prefer the instrument that actually has NAVs; fall back to the position's own id
    // so a fund whose history has not landed yet still appears, with an empty series.
    const navInstrumentId = siblingOf.get(p.instrumentId) ?? p.instrumentId;
    return {
      instrumentId: p.instrumentId,
      name: p.name,
      navInstrumentId,
      valuePaise: p.valuePaise,
      category: amfiCategoryOf.get(p.instrumentId)
        ?? metadata.get(p.instrumentId)?.category
        ?? metadata.get(navInstrumentId)?.category ?? null,
    };
  });
}

export interface RankedFund extends MfRanking {
  name: string;
  valuePaise: bigint;
  category: string | null;
  /** Month-end points behind the consistency score. Fewer than 13 means it scored 0. */
  monthsOfHistory: number;
  /** Components with no source at all, so the reader knows what the score omits. */
  withheld: string[];
}

/**
 * The maximum a fund can score.
 *
 * It was 75 while `tenure` and `style` carried 15 and 10 points with no source to fill
 * them. Those 25 points moved to `returns` on 2026-09-22, so the scale is whole again
 * and a 75 now means what it says rather than being full marks.
 */
export const MAX_ACHIEVABLE_COMPOSITE = 100;

export interface MfRankingResult {
  ranked: RankedFund[];
  /** Set when the ranking must not be read as a comparison — see `unevenHistory`. */
  caveats: string[];
}

export async function rankHeldFunds(db: Db, scoreDate: string): Promise<MfRankingResult> {
  const funds = await heldFunds(db);
  if (funds.length === 0) return { ranked: [], caveats: [] };

  const navs = await monthEndNavs(db, funds.map((f) => f.navInstrumentId));
  const metadata = await loadMfMetadata(db);

  const candidates: MfCandidate[] = funds.map((f) => {
    const meta = metadata.get(f.instrumentId) ?? metadata.get(f.navInstrumentId);
    return {
      instrumentId: f.instrumentId,
      navMicros: navs.get(f.navInstrumentId) ?? [],
      expenseRatioBps: meta?.expenseRatioBps ?? null,
      aumPaise: meta?.aumPaise ?? null,
      // No source for either. They are NULL for EVERY fund, which scores 0 for every
      // fund and so cannot change the ordering; a partial proxy for one of them WOULD.
      tenureMonths: null,
      styleDriftPct: null,
    };
  });

  const byId = new Map(funds.map((f) => [f.instrumentId, f]));
  const ranked: RankedFund[] = rankMfs(candidates, {
    scoreDate, blockedIds: [], rollingWindow: MONTHS_PER_WINDOW,
  }).map((r) => {
    const f = byId.get(r.instrumentId)!;
    const months = (navs.get(f.navInstrumentId) ?? []).length;
    // Still nameable, still sourceless — but they no longer cost the fund anything,
    // because their weight went to `returns`.
    const withheld = ['fund tenure', 'style drift'];
    if (months <= MONTHS_PER_WINDOW) withheld.push('consistency (too little NAV history)');
    return {
      ...r,
      name: f.name,
      valuePaise: f.valuePaise,
      category: f.category,
      monthsOfHistory: months,
      withheld,
    };
  });

  return { ranked, caveats: unevenHistory(ranked) };
}

/**
 * A ranking is only a comparison when every fund was measured the same way.
 *
 * `consistencyRatio` returns 0 outright below the window, and consistency is the largest
 * weight at 40. A fund short of history therefore ranks last on a data gap rather than
 * on merit — which is exactly the failure that a wrong ISIN produced for PPFC, giving it
 * 12 month-ends against the others' 31. Say so rather than presenting the order as a
 * verdict.
 */
export function unevenHistory(ranked: readonly RankedFund[]): string[] {
  if (ranked.length === 0) return [];
  const short = ranked.filter((r) => r.monthsOfHistory <= MONTHS_PER_WINDOW);
  if (short.length === 0 || short.length === ranked.length) return [];
  return [
    `${short.map((r) => r.name).join(', ')} ${short.length === 1 ? 'has' : 'have'} `
    + `${MONTHS_PER_WINDOW} or fewer month-end NAVs, so consistency — 40 of the 100 `
    + 'points — scored 0 for them and not for the rest. The order below is not a like-'
    + 'for-like comparison until the history evens out.',
  ];
}
