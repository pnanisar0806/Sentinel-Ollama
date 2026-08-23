/**
 * funded-status.ts — reporting-only funded status.
 *
 * The `funded_ratio` is a plain number (no type brand) that reports the ratio of
 * investable corpus to the FI corpus target derived from assumptions.  The type
 * system does NOT prevent it from being passed as a bare `number` to sizing/risk
 * functions — that is enforced by the architecture test (Task 10), not the type
 * system.  See the architecture test for the exact enforcement mechanism.
 *
 * Working rule: `funded_status` is unreadable by any sizing or risk function.
 * No catch-up behavior.  See MEMORY.md § Owner decisions.
 */

import { rupees, type Paise } from '../money/paise.js';
import { ASSUMPTIONS } from '../config/assumptions.js';

/**
 * FI corpus band derived from assumptions, at one safe withdrawal rate.
 *
 * PRD: "At a 3.5% safe withdrawal rate (appropriate for Indian inflation; 4% carried
 * as optimistic sensitivity), this implies a corpus of Rs 10.3 Cr (floor) to Rs 17.1 Cr
 * (stretch) in today's money (Rs 9-15 Cr at 4% SWR)."
 *
 * So the band varies the INCOME and the SWR is a separate sensitivity axis:
 *   floor   = fiIncomeFloorMonthlyInr   x 12 / swr
 *   stretch = fiIncomeStretchMonthlyInr x 12 / swr
 *
 * All four PRD figures reproduce exactly:
 *   swr 3.5% -> 10_285_714_285n (Rs 10.2857 Cr) .. 17_142_857_142n (Rs 17.1428 Cr)
 *   swr 4.0% ->  9_000_000_000n (Rs  9.00   Cr) .. 15_000_000_000n (Rs 15.00   Cr)
 *
 * This function previously took ONE income and varied only the SWR, so `stretch` came
 * back as the floor income at the optimistic rate — Rs 9.00 Cr, which is Rs 1.29 Cr BELOW
 * the floor target. Every ratio against it read better than the ratio against the floor,
 * telling the owner he was better funded against the harder goal.
 *
 * Integer paise throughout: exact division through basis points, never a float.
 */
export function computeFICorpusBand(
  swr: number = ASSUMPTIONS.swrFloor,
): { floorPaise: Paise; stretchPaise: Paise } {
  const bps = BigInt(Math.round(swr * 10_000)); // 0.035 -> 350
  const corpus = (monthlyInr: number): Paise =>
    ((rupees(monthlyInr) * 12n * 10_000n) / bps) as Paise;
  return {
    floorPaise: corpus(ASSUMPTIONS.fiIncomeFloorMonthlyInr),
    stretchPaise: corpus(ASSUMPTIONS.fiIncomeStretchMonthlyInr),
  };
}

/**
 * Funded ratio = investablePaise / corpusTargetPaise.
 *
 * Returns a plain number ratio.  The type system does NOT brand this as a
 * distinct type — the architecture test (Task 10) enforces that no sizing or
 * risk function may accept a bare `number` as funded ratio; enforcement is
 * via the import graph + allowlist, not the type system.
 */
export function fundedRatio(
  investablePaise: Paise,
  corpusPaise: Paise,
): { ratio: number; isExact: boolean } {
  const ratio = Number(investablePaise) / Number(corpusPaise);
  const isExact = Number(investablePaise) % Number(corpusPaise) === 0;
  return { ratio, isExact };
}

/**
 * Report the funded status for B1 (FI corpus).
 *
 *   ratio        = investable / the target actually used
 *   floorRatio   = investable / floor corpus   (3L/mo income at the floor SWR)
 *   stretchRatio = investable / stretch corpus (5L/mo income at the floor SWR)
 *   corpusPaise  = the target actually used
 *   band         = which target that was
 *
 * `band` used to be `corpusPaise !== undefined ? 'floor' : 'none'` — inverted (an
 * explicit caller-supplied target was labelled 'floor' while the assumption-derived
 * floor was labelled 'none') and 'stretch' was unreachable.
 *
 * The ratio is purely informational. It must not flow into any sizing or risk
 * function — see tests/architecture/no-catch-up.test.ts.
 */
export function reportFundedStatus(
  investablePaise: Paise,
  corpusPaise?: Paise,
): {
  ratio: number;
  floorRatio: number;
  stretchRatio: number;
  corpusPaise: Paise;
  band: 'floor' | 'stretch' | 'explicit';
} {
  const { floorPaise, stretchPaise } = computeFICorpusBand();
  const target = corpusPaise ?? floorPaise;

  const band: 'floor' | 'stretch' | 'explicit' =
    corpusPaise === undefined ? 'floor'
    : corpusPaise === stretchPaise ? 'stretch'
    : 'explicit';

  return {
    ratio: Number(investablePaise) / Number(target),
    floorRatio: Number(investablePaise) / Number(floorPaise),
    stretchRatio: Number(investablePaise) / Number(stretchPaise),
    corpusPaise: target,
    band,
  };
}

/**
 * Lightweight funded status for the daily digest.
 * Returns just the floor and stretch ratios against assumption-derived bands.
 */
export function fundedStatus(
  investablePaise: Paise,
): { floorRatio: number; stretchRatio: number } {
  const { floorPaise, stretchPaise } = computeFICorpusBand();
  return {
    floorRatio: Number(investablePaise) / Number(floorPaise),
    stretchRatio: Number(investablePaise) / Number(stretchPaise),
  };
}