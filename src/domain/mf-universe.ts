import type { Db } from '../db/client.js';
import { isDirectGrowth, type UniverseRow } from '../sources/amfi.js';
import { heldFunds } from './mf-ranking.js';

/**
 * The candidate universe for `mf_switch`: every Direct-plan growth fund AMFI lists in a
 * category the owner already holds.
 *
 * The advisor does not browse the internet, and the LLM may not originate a rank
 * (PRD §6.7). It does not need to: AMFI publishes all 14,138 schemes daily, with the
 * SEBI category as a heading, and that is the whole Indian market — verifiable and
 * reproducible where a model's recollection is neither.
 */

/** Categories where a switch is a like-for-like comparison. */
export const SWITCHABLE_CATEGORIES = [
  'Equity Scheme - Flexi Cap Fund',
  'Equity Scheme - Large Cap Fund',
  'Equity Scheme - Mid Cap Fund',
  'Equity Scheme - Small Cap Fund',
] as const;

/**
 * Index funds are deliberately excluded, for now.
 *
 * AMFI files 290 Direct growth funds under `Other Scheme - Index Funds` and 64 more
 * under `Index Funds - Equity Funds`, but the category does not say WHICH index. A
 * Nifty 50 tracker and a Nifty Smallcap tracker are not alternatives to one another,
 * and ranking them together would recommend swapping one exposure for a different one
 * on the strength of a cost difference. The peer set for an index fund is the funds
 * tracking the same index, which needs index-level matching on the scheme name.
 */
export const INDEX_CATEGORIES_EXCLUDED =
  'Index funds need same-index matching before they can be compared; AMFI’s category '
  + 'says only that a fund is an index fund, not which index it tracks.';

export interface UniverseCandidate {
  instrumentId: string;
  schemeCode: string;
  isin: string;
  name: string;
  category: string;
}

/** `MFU:<schemeCode>` — a candidate is not a holding and must never look like one. */
export const universeInstrumentId = (schemeCode: string): string => `MFU:${schemeCode}`;

/**
 * Which categories to build a cohort for: the ones the owner actually holds.
 *
 * Held funds are matched into the universe by scheme code, and a held fund is always
 * part of its own cohort even when AMFI leaves its Plan and Option blank — the owner
 * owning it settles what it is. `MF:MOTILAL-MIDCAP` (scheme 127042) is exactly that
 * case: its row reads `Motilal Oswal Midcap Fund;;;119.7221`, so `isDirectGrowth`
 * cannot prove it, while the NAV matches INDmoney's for the holding to the paisa.
 */
export async function categoriesHeld(db: Db, rows: readonly UniverseRow[]): Promise<string[]> {
  const held = await heldFunds(db);
  const schemeCodes = await db.query<{ scheme_code: string | null }>(
    `select scheme_code from instruments
      where id = any($1::text[]) or canonical_id in (
        select canonical_id from instruments where id = any($1::text[]))`,
    [held.map((h) => h.instrumentId)],
  );
  const codes = new Set(schemeCodes.map((r) => r.scheme_code).filter((c): c is string => c !== null));
  const byCode = new Map(rows.map((r) => [r.schemeCode, r]));

  const found = new Set<string>();
  for (const code of codes) {
    const row = byCode.get(code);
    if (row) found.add(row.category);
  }
  return [...found].filter((c) => (SWITCHABLE_CATEGORIES as readonly string[]).includes(c)).sort();
}

/** Candidates in those categories, excluding anything not provably Direct + growth. */
export function candidatesIn(
  rows: readonly UniverseRow[],
  categories: readonly string[],
): UniverseCandidate[] {
  const wanted = new Set(categories);
  const out: UniverseCandidate[] = [];
  for (const r of rows) {
    if (!wanted.has(r.category) || !isDirectGrowth(r) || r.isin === null) continue;
    out.push({
      instrumentId: universeInstrumentId(r.schemeCode),
      schemeCode: r.schemeCode,
      isin: r.isin,
      name: r.schemeName,
      category: r.category,
    });
  }
  return out;
}

/**
 * Gives each candidate an `instruments` row so `ingestNavs` can file its NAVs.
 *
 * A candidate that is really a fund the owner already holds is skipped: the holding's
 * own instrument already carries that ISIN, and a second row would give one fund two
 * NAV series and let it appear twice in its own cohort.
 */
export async function persistUniverse(
  db: Db,
  candidates: readonly UniverseCandidate[],
): Promise<{ created: number; skippedHeld: number }> {
  let created = 0;
  let skippedHeld = 0;
  for (const c of candidates) {
    const owned = await db.query<{ id: string }>(
      `select id from instruments where isin = $1 and id not like 'MFU:%'`, [c.isin],
    );
    if (owned.length > 0) { skippedHeld += 1; continue; }

    const rows = await db.query<{ id: string }>(
      `insert into instruments (id, kind, name, currency, isin, scheme_code, metadata)
       values ($1, 'MF', $2, 'INR', $3, $4, $5::jsonb)
       on conflict (id) do update set name = excluded.name, metadata = excluded.metadata
       returning id`,
      [c.instrumentId, c.name, c.isin, c.schemeCode,
       JSON.stringify({ universe: true, category: c.category })],
    );
    created += rows.length;
  }
  return { created, skippedHeld };
}

/** Candidate instruments already on record, by category. */
export async function loadUniverse(db: Db): Promise<UniverseCandidate[]> {
  const rows = await db.query<{
    id: string; name: string; isin: string; scheme_code: string; metadata: unknown;
  }>(
    `select id, name, isin, scheme_code, metadata from instruments
      where id like 'MFU:%' order by id`,
  );
  return rows.map((r) => {
    const meta = (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) as
      { category?: string } | null;
    return {
      instrumentId: r.id,
      schemeCode: r.scheme_code,
      isin: r.isin,
      name: r.name,
      category: meta?.category ?? '',
    };
  });
}

/**
 * Records AMFI's category on the instruments the owner already holds.
 *
 * A holding's category came only from INDmoney's `get_mf_funds_details`, so a fund
 * INDmoney had not been asked about had no category and therefore no cohort — it fell
 * out of the switch evaluation entirely. AMFI classifies EVERY scheme, including the
 * ones whose Plan and Option it leaves blank, so it is the better source for this.
 *
 * Matching runs on ISIN and scheme code and ignores plan and option on purpose: the
 * owner owning the fund settles what it is, and `MF:MOTILAL-MIDCAP` (scheme 127042)
 * has an empty Plan and Option in AMFI's own file.
 */
export async function stampHeldCategories(
  db: Db,
  rows: readonly UniverseRow[],
): Promise<number> {
  let stamped = 0;
  for (const r of rows) {
    if (r.category === '') continue;
    const done = await db.query<{ id: string }>(
      `update instruments
          set metadata = metadata || jsonb_build_object('amfiCategory', $1::text)
        where kind = 'MF' and id not like 'MFU:%'
          and (($2 <> '' and isin = $2) or ($3 <> '' and scheme_code = $3))
          and coalesce(metadata->>'amfiCategory', '') <> $1
        returning id`,
      [r.category, r.isin ?? '', r.schemeCode],
    );
    stamped += done.length;
  }
  return stamped;
}
