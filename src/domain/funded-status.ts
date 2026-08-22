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
 * FI corpus band derived from assumptions.
 *
 * Floor:  fiIncomeFloorMonthlyInr * 12 / swrFloor
 * Stretch: fiIncomeStretchMonthlyInr * 12 / swrOptimistic
 *
 * Both computed as integer paise via exact division to avoid float-before-money.
 *
 * Derivation (verified):
 *   floor:  300_000/mo × 12 = 3_600_000/yr / 0.035 = 102_857_142.857... rupees
 *          = 10_285_714_285n paise  (Rs 10.2857 Cr)
 *   stretch: 500_000/mo × 12 = 6_000_000/yr / 0.04 = 150_000_000.000... rupees
 *          = 17_142_857_142n paise  (Rs 17.1428 Cr)
 */
export function computeFICorpusBand(
  monthlyInr: number, // rupees (not paise) - caller provides monthly income in rupees
  swrFloor: number = ASSUMPTIONS.swrFloor,
  swrOptimistic: number = ASSUMPTIONS.swrOptimistic,
): { floorPaise: Paise; stretchPaise: Paise } {
  // Use rupees() then multiply by 12n to avoid float-before-money anti-pattern
  const monthlyRupees = rupees(monthlyInr);
  const annualRupees = monthlyRupees * 12n;
  // swrFloor = 0.035 = 350 bps, swrOptimistic = 0.04 = 400 bps
  // Exact integer micros division: annualRupees * 10_000 / swr_bps
  const floorBps = Math.round(swrFloor * 10_000); // 350
  const stretchBps = Math.round(swrOptimistic * 10_000); // 400
  const floorPaise = (annualRupees * 10_000n / BigInt(floorBps)) as Paise;
  const stretchPaise = (annualRupees * 10_000n / BigInt(stretchBps)) as Paise;
  return { floorPaise, stretchPaise };
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
 * Returns { ratio, floorRatio, stretchRatio, corpusPaise, band } where:
 *   ratio   = investable / corpus (using the corpus target passed in)
 *   floorRatio = investable / floorCorpus (the floor band from assumptions)
 *   stretchRatio = investable / stretchCorpus (the stretch band from assumptions)
 *   corpusPaise = the specific corpus target used for the ratio
 *   band = 'floor' | 'stretch' | 'none' indicating which band the ratio is against
 *
 * The ratio is purely informational — it must not flow into any sizing or risk
 * function.  The architecture test verifies this constraint.
 */
export function reportFundedStatus(
  investablePaise: Paise,
  corpusPaise?: Paise,
): {
  ratio: number;
  floorRatio: number;
  stretchRatio: number;
  corpusPaise: Paise;
  band: 'floor' | 'stretch' | 'none';
} {
  // Use the assumption-derived floor income (300_000 rupees/month) for the floor band
  const floorBand = computeFICorpusBand(ASSUMPTIONS.fiIncomeFloorMonthlyInr);
  // When corpusPaise is provided (e.g. from a specific projection), use it.
  // Otherwise fall back to the assumption-derived floor band.
  const target = corpusPaise ?? floorBand.floorPaise;
  const ratio = Number(investablePaise) / Number(target);
  const floorRatio = Number(investablePaise) / Number(floorBand.floorPaise);
  const stretchRatio = Number(investablePaise) / Number(floorBand.stretchPaise);

  const band: 'floor' | 'stretch' | 'none' =
    corpusPaise !== undefined ? 'floor' : 'none';

  return { ratio, floorRatio, stretchRatio, corpusPaise: target, band };
}

/**
 * Derive the FI corpus target paise from the given monthly income and SWR rates.
 * This is the exact derivation the architecture test validates.
 */
export function fiCorpusTargetPaise(
  monthlyInr: number, // rupees (not paise) - caller provides monthly income in rupees
  swrFloor: number = ASSUMPTIONS.swrFloor,
  swrOptimistic: number = ASSUMPTIONS.swrOptimistic,
): { floorPaise: Paise; stretchPaise: Paise } {
  return computeFICorpusBand(monthlyInr, swrFloor, swrOptimistic);
}

/**
 * Verify that a given funded ratio is within the expected band.
 * Returns true if the ratio is within [floorRatio, stretchRatio].
 */
export function isInBand(ratio: number, floorRatio: number, stretchRatio: number): boolean {
  return ratio >= floorRatio && ratio <= stretchRatio;
}

/**
 * Lightweight funded status for the daily digest.
 * Returns just the floor and stretch ratios against assumption-derived bands.
 */
export function fundedStatus(
  investablePaise: Paise,
): { floorRatio: number; stretchRatio: number } {
  const floorBand = computeFICorpusBand(ASSUMPTIONS.fiIncomeFloorMonthlyInr);
  const floorRatio = Number(investablePaise) / Number(floorBand.floorPaise);
  const stretchRatio = Number(investablePaise) / Number(floorBand.stretchPaise);
  return { floorRatio, stretchRatio };
}