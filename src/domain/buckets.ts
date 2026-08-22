import { rupees, type Paise } from '../money/paise.js';
import type { Db } from '../db/client.js';
import { ASSUMPTIONS } from '../config/assumptions.js';
import type { HoldingSeed } from '../seed/seed-data.js';
import type { LoanSeed } from '../seed/seed-data.js';
import type { RsuGrantSeed } from '../seed/seed-data.js';

/** Bucket status for the daily digest — computed from live bucket flows. */
export interface BucketStatus {
  id: BucketId;
  name: string;
  balancePaise: Paise;
  targetPaise: Paise | null;
  targetNote: string;
  fundedRatio: number | null;
}

/** Milestone status for the daily digest. */
export interface MilestoneStatus {
  id: 'M1' | 'M2';
  name: string;
  spec: string;
  completedOn: string | null;
  daysOutstanding: number;
}

/**
 * Bucket IDs as defined in SEED_BUCKETS.
 * B1: FI corpus (target NaN = undefined / not-yet-specified)
 * B2: House fund target ₹65L
 * B3: Emergency fund target ₹6L
 * B4: Education corpus target ₹1Cr
 */
export type BucketId = 'B1' | 'B2' | 'B3' | 'B4';

/**
 * Bucket record — mirrors the schema but keeps everything paise-powered.
 */
export interface Bucket {
  id: BucketId;
  name: string;
  mandate: string;
  targetPaise: Paise | null; // NULL means 'not specified'
  targetNote: string;
  active: boolean;
}

/**
 * Milestone record — mirrors the schema.
 */
export interface Milestone {
  id: 'M1' | 'M2';
  name: string;
  spec: string;
  rationale: string;
  completedOn: string | null; // ISO date string, or null
}

/**
 * Bucket balances are derived from the current portfolio:
 *  - B1 (FI corpus): funded status ratio based on take-home + SWR
 *  - B2 (House fund): progress toward ₹65L target from savings
 *  - B3 (Emergency fund): current liquid assets vs ₹6L target
 *  - B4 (Education corpus): progress toward ₹1Cr target from RSU vests + savings
 */

/**
 * Compute the FI corpus band (floor/stretch) from assumptions.
 * Floor: fiIncomeFloorMonthlyInr * 12 / swrFloor
 * Stretch: fiIncomeStretchMonthlyInr * 12 / swrOptimistic
 * Both expressed as integer paise.
 */
export function computeFICorpusBand(
  monthlyInr: number, // rupees (not paise) - caller provides monthly income in rupees
  swrFloor: number = ASSUMPTIONS.swrFloor,
  swrOptimistic: number = ASSUMPTIONS.swrOptimistic,
  targetAge: number = ASSUMPTIONS.fiTargetAge,
): { floorPaise: Paise; stretchPaise: Paise } {
  // Use rupees() then multiply by 12n to avoid float-before-money anti-pattern
  const monthlyRupees = rupees(monthlyInr);
  const annualRupees = monthlyRupees * 12n;
  // Exact integer micros division: annualRupees * 10_000 / swr_bps
  // swrFloor = 0.035 = 350 bps, swrOptimistic = 0.04 = 400 bps
  const floorBps = Math.round(swrFloor * 10_000); // 350
  const stretchBps = Math.round(swrOptimistic * 10_000); // 400
  const floorPaise = (annualRupees * 10_000n / BigInt(floorBps)) as Paise;
  const stretchPaise = (annualRupees * 10_000n / BigInt(stretchBps)) as Paise;
  return { floorPaise, stretchPaise };
}

/**
 * Derive the funded ratio for B1 (FI corpus) — reporting only.
 * fundedRatio = investablePaise / corpusTargetPaise,
 * where corpusTarget is the floor or stretch value derived from assumptions.
 * Returns { ratio, floorPaise, stretchPaise }.
 * The ratio is a plain number in [0, ∞) — callers must interpret it against the bands.
 */
export function fundedRatio(
  investablePaise: Paise,
  corpusPaise: Paise,
): { ratio: number } {
  const ratio = Number(investablePaise) / Number(corpusPaise);
  return { ratio };
}

/**
 * Buzzle: check whether a bucket is "in range" based on its target.
 * B1 (FI corpus): ratio against the corpus band (uses floor band from assumptions)
 * B2 (House fund): paise progress vs target
 * B3 (Emergency fund): paise progress vs target
 * B4 (Education corpus): paise progress vs target
 */
export function bucketStatus(
  bucket: Bucket,
  currentPaise: Paise,
): { met: boolean; progressPaise: Paise; targetPaise: Paise | null } {
  if (bucket.id === 'B1') {
    // B1 target is derived from assumptions (floor band)
    const band = computeFICorpusBand(ASSUMPTIONS.fiIncomeFloorMonthlyInr);
    const { ratio } = fundedRatio(currentPaise, band.floorPaise);
    // B1 is "met" if ratio >= 1.0 at the floor level
    const met = ratio >= 1.0;
    return {
      met,
      progressPaise: currentPaise,
      targetPaise: band.floorPaise,
    };
  }
  if (bucket.targetPaise === null) {
    return { met: false, progressPaise: currentPaise, targetPaise: null };
  }
  const met = currentPaise >= bucket.targetPaise;
  return {
    met,
    progressPaise: currentPaise,
    targetPaise: bucket.targetPaise,
  };
}

import { formatInr } from '../money/paise.js';

/**
 * Render a human-readable bucket summary.
 */
export function bucketSummary(b: Bucket, currentPaise: Paise): string {
  const { met, progressPaise, targetPaise } = bucketStatus(b, currentPaise);
  const targetStr = targetPaise === null ? 'unspecified' : formatInr(targetPaise);
  const progressStr = formatInr(progressPaise);
  return `${b.name}: ${progressStr} / ${targetStr} — ${met ? 'target met' : 'still growing'}`;
}

/** Default bucket states keyed by id, initialized from seed. */
export const BUCKETS: Record<BucketId, Bucket> = {
  B1: {
    id: 'B1',
    name: 'FI corpus',
    mandate: 'Max risk-adjusted return within a 30% max-drawdown constraint',
    targetPaise: null,
    targetNote: '10.3-17.1 Cr real at age 55 (2050)',
    active: true,
  },
  B2: {
    id: 'B2',
    name: 'House fund',
    mandate: 'Capital preservation; duration-matched debt/arbitrage; no equity risk inside 7 years of purchase',
    targetPaise: rupees(6_500_000),
    targetNote: 'Down payment + costs 55-75L for a 2-2.5 Cr Hyderabad home, 2033-35',
    active: true,
  },
  B3: {
    id: 'B3',
    name: 'Emergency fund',
    mandate: 'Liquid savings; AU SFB during build, IDFC First beyond 3L, split beyond 5L for DICGC cover',
    targetPaise: rupees(600_000),
    targetNote: 'Complete by Dec 2026 from Sammaan maturity + Nov 2026 vest',
    active: true,
  },
  B4: {
    id: 'B4',
    name: 'Education corpus',
    mandate: 'Long-horizon equity glide path, de-risking from ~2040',
    targetPaise: rupees(10_000_000),
    targetNote: '1 Cr in today money at child age 18 (~2046); activates ~2028',
    active: true,
  },
};

/** Default milestone states keyed by id, initialized from seed. */
export const MILESTONES: Record<'M1' | 'M2', Milestone> = {
  M1: {
    id: 'M1',
    name: 'Term life cover',
    spec: '2 Cr personal term cover, before the child arrives, funded from RSU vests',
    rationale: 'Employer group cover evaporates on exit; the maximum-dependency point is now',
    completedOn: null,
  },
  M2: {
    id: 'M2',
    name: 'Health super top-up',
    spec: '~50L family super top-up beyond employer cover',
    rationale: 'Single-income household with a 30L medical event as a defined SIP-stop trigger',
    completedOn: null,
  },
};

/**
 * Compute current bucket balances from bucket_flows and return status for each active bucket.
 * Balances are the sum of signed amount_paise per bucket.
 */
export async function bucketStatuses(db: Db): Promise<BucketStatus[]> {
  const flowRows = await db.query<{ bucket_id: BucketId; amount_paise: string }>(
    'select bucket_id, sum(amount_paise) as amount_paise from bucket_flows group by bucket_id',
  );
  const balanceMap = new Map<BucketId, Paise>();
  for (const row of flowRows) {
    balanceMap.set(row.bucket_id, BigInt(row.amount_paise) as Paise);
  }

  return Object.values(BUCKETS)
    .filter((b) => b.active)
    .map((bucket) => {
      const balance = balanceMap.get(bucket.id) ?? (0n as Paise);
      const { met: _met, targetPaise } = bucketStatus(bucket, balance);
      let fundedRatio: number | null = null;
      if (targetPaise !== null && targetPaise > 0n) {
        fundedRatio = Number(balance) / Number(targetPaise);
      }
      return {
        id: bucket.id,
        name: bucket.name,
        balancePaise: balance,
        targetPaise,
        targetNote: bucket.targetNote,
        fundedRatio,
      };
    });
}

/**
 * Compute milestone statuses with days outstanding.
 * Uses the database's completed_on column; falls back to the static MILESTONES for in-memory defaults.
 */
export async function milestoneStatuses(db: Db, businessDate: string): Promise<MilestoneStatus[]> {
  const milestoneRows = await db.query<{ id: 'M1' | 'M2'; name: string; spec: string; completed_on: string | null }>(
    'select id, name, spec, completed_on from milestones',
  );
  const base = new Date(businessDate + 'T00:00:00');
  return milestoneRows.map((row) => {
    const completedOn = row.completed_on ?? null;
    const daysOutstanding = completedOn
      ? Math.floor((base.getTime() - new Date(completedOn + 'T00:00:00').getTime()) / 86400000)
      : Math.floor((base.getTime() - new Date('2026-01-01T00:00:00').getTime()) / 86400000);
    return {
      id: row.id,
      name: row.name,
      spec: row.spec,
      completedOn,
      daysOutstanding,
    };
  });
}