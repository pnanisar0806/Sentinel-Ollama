import type { Db } from '../db/client.js';
import { rankMfs, type MfCandidate } from './engine.js';
import { loadMfMetadata } from './mf-metadata.js';
import {
  MAX_ACHIEVABLE_COMPOSITE, MONTHS_PER_WINDOW, heldFunds, monthEndNavs,
} from './mf-ranking.js';
import { loadUniverse } from './mf-universe.js';

/**
 * Ranks each held fund against its whole AMFI category, and says whether a switch
 * clears the bar.
 *
 * The bar is deliberately high. IPS §3.7's twelve-month hold is a floor and the
 * standing instruction is that the default answer is hold, so a switch has to be worth
 * realising tax and paying an exit load for — not merely worth a rounding difference in
 * a composite. A margin that a month of NAV noise can cross is not a thesis.
 */

/**
 * Share of the scale a challenger must beat the held fund by.
 *
 * `BETTER_ALTERNATIVE_MARGIN` in `sell-triggers.ts` sets the same idea for equities: 10
 * points when the achievable maximum here was 75, so 13.3% of the scale.
 *
 * It is a SHARE and not a fixed number of points because the scale moved once already.
 * Adding `returns` took the achievable maximum from 75 to 100, and a margin left at 10
 * would have quietly become a looser bar — the sort of drift that shows up as "the
 * advisor started recommending more switches" with no decision behind it.
 */
export const SWITCH_MARGIN_SHARE = 10 / 75;

/** The margin in points, on the current scale. */
export const SWITCH_MARGIN = Math.round(MAX_ACHIEVABLE_COMPOSITE * SWITCH_MARGIN_SHARE * 100) / 100;

export interface SwitchCandidate {
  heldInstrumentId: string;
  heldName: string;
  heldComposite: number;
  heldRank: number;
  category: string;
  cohortSize: number;
  /** NULL when nothing in the cohort clears the margin — the common, correct answer. */
  challengerId: string | null;
  challengerName: string | null;
  challengerComposite: number | null;
  edge: number | null;
  /** Why no switch is proposed, when none is. */
  reason: string;
}

interface Scored {
  instrumentId: string;
  name: string;
  composite: number;
  rank: number;
  months: number;
}

/**
 * A candidate must have at least this share of the holding's NAV history to be compared.
 *
 * A young fund is not a like-for-like alternative: `consistencyRatio` would score its
 * short record as if it were the whole one, and a spectacular fourteen months is
 * precisely what a switch should not chase. The bar is a SHARE rather than "at least as
 * much", because held funds carry a daily series and candidates a month-end one built
 * by a separate job — a one-month difference between the two backfills is an artefact,
 * and requiring equality emptied every cohort.
 */
export const MIN_HISTORY_SHARE = 0.9;

/** The trailing `n` points of a series. */
const tail = (xs: readonly bigint[], n: number): bigint[] => xs.slice(Math.max(0, xs.length - n));

/**
 * Scores one category: the held fund plus every candidate AMFI lists in it.
 *
 * Every series is trimmed to the same number of month-ends before scoring. Consistency
 * is the share of rolling windows that gained, so a fund measured over more windows is
 * not measured on the same thing — comparing 31 windows against 30 is not a comparison.
 */
export async function evaluateSwitches(
  db: Db,
  scoreDate: string,
): Promise<SwitchCandidate[]> {
  const held = await heldFunds(db);
  if (held.length === 0) return [];

  const universe = await loadUniverse(db);
  const metadata = await loadMfMetadata(db);
  const navIds = [...held.map((h) => h.navInstrumentId), ...universe.map((u) => u.instrumentId)];
  const navs = await monthEndNavs(db, navIds);

  const byCategory = new Map<string, typeof universe>();
  for (const u of universe) {
    const list = byCategory.get(u.category) ?? [];
    list.push(u);
    byCategory.set(u.category, list);
  }

  const out: SwitchCandidate[] = [];
  for (const h of held) {
    const heldMonths = (navs.get(h.navInstrumentId) ?? []).length;
    const cohort = h.category === null ? [] : byCategory.get(h.category) ?? [];

    const usable = cohort.filter((c) => {
      const n = (navs.get(c.instrumentId) ?? []).length;
      return n > MONTHS_PER_WINDOW && n >= heldMonths * MIN_HISTORY_SHARE;
    });
    // The common span: what every fund in this cohort, including the holding, can be
    // scored over.
    const span = usable.reduce(
      (min, c) => Math.min(min, (navs.get(c.instrumentId) ?? []).length),
      heldMonths,
    );

    const candidates: MfCandidate[] = [
      {
        instrumentId: h.instrumentId,
        navMicros: tail(navs.get(h.navInstrumentId) ?? [], span),
        expenseRatioBps: metadata.get(h.instrumentId)?.expenseRatioBps
          ?? metadata.get(h.navInstrumentId)?.expenseRatioBps ?? null,
        aumPaise: metadata.get(h.instrumentId)?.aumPaise
          ?? metadata.get(h.navInstrumentId)?.aumPaise ?? null,
        tenureMonths: null,
        styleDriftPct: null,
      },
      ...usable
        .map((c) => ({
          instrumentId: c.instrumentId,
          navMicros: tail(navs.get(c.instrumentId) ?? [], span),
          // A candidate has no INDmoney metadata unless it happens to be held, so cost
          // and size score 0 for it. That is a HANDICAP against the challenger, which
          // is the safe direction: it can only ever understate the case for switching.
          expenseRatioBps: metadata.get(c.instrumentId)?.expenseRatioBps ?? null,
          aumPaise: metadata.get(c.instrumentId)?.aumPaise ?? null,
          tenureMonths: null,
          styleDriftPct: null,
        })),
    ];

    const ranked = rankMfs(candidates, {
      scoreDate, blockedIds: [], rollingWindow: MONTHS_PER_WINDOW,
    });
    const nameOf = new Map<string, string>([
      [h.instrumentId, h.name], ...cohort.map((c) => [c.instrumentId, c.name] as const),
    ]);
    const scored: Scored[] = ranked.map((r) => ({
      instrumentId: r.instrumentId,
      name: nameOf.get(r.instrumentId) ?? r.instrumentId,
      composite: r.composite,
      rank: r.rank,
      months: (navs.get(r.instrumentId === h.instrumentId ? h.navInstrumentId : r.instrumentId) ?? []).length,
    }));

    const self = scored.find((s) => s.instrumentId === h.instrumentId)!;
    const best = scored.find((s) => s.instrumentId !== h.instrumentId) ?? null;
    const edge = best === null ? null : Math.round((best.composite - self.composite) * 100) / 100;

    const base = {
      heldInstrumentId: h.instrumentId,
      heldName: h.name,
      heldComposite: self.composite,
      heldRank: self.rank,
      category: h.category ?? 'uncategorised',
      cohortSize: scored.length - 1,
    };

    if (h.category === null) {
      out.push({ ...base, challengerId: null, challengerName: null, challengerComposite: null,
        edge: null, reason: 'no category on record, so there is no cohort to compare against' });
    } else if (cohort.length === 0) {
      out.push({ ...base, challengerId: null, challengerName: null, challengerComposite: null,
        edge: null, reason: `no candidates on record for ${h.category}` });
    } else if (best === null || edge === null || edge < SWITCH_MARGIN) {
      out.push({ ...base, challengerId: null, challengerName: null, challengerComposite: null,
        edge,
        reason: best === null
          ? 'no candidate had enough NAV history to be scored like for like'
          : `best alternative is ${edge} points ahead, short of the ${SWITCH_MARGIN}-point `
            + `margin on a ${MAX_ACHIEVABLE_COMPOSITE}-point scale`,
      });
    } else {
      out.push({ ...base,
        challengerId: best.instrumentId, challengerName: best.name,
        challengerComposite: best.composite, edge,
        reason: `${best.name} scores ${best.composite} against ${self.composite}, `
          + `${edge} points clear of the ${SWITCH_MARGIN}-point margin`,
      });
    }
  }
  return out;
}
