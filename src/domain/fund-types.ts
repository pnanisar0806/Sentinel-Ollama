/**
 * Pure fund-mix types and helpers (funds-first). A leaf: it imports nothing, so the sizer and
 * anything the advisor reaches can use these without reaching `fund-mix.ts`, which holds the
 * owner's signature (`approveMix`) and the DB loaders. The advisor firewall forbids fund-mix.ts.
 */

export type FundType = 'NIFTY50' | 'NEXT50' | 'FLEXI' | 'LARGE_ACTIVE' | 'MID' | 'SMALL' | 'US';

export const FUND_TYPE_LABEL: Record<FundType, string> = {
  NIFTY50: 'Nifty 50 index',
  NEXT50: 'Nifty Next 50 index',
  FLEXI: 'Flexi cap',
  LARGE_ACTIVE: 'Large cap (active)',
  MID: 'Mid cap',
  SMALL: 'Small cap',
  US: 'US index',
};

export interface RangeRow { type: FundType; minBps: number; maxBps: number; newMoney: boolean; reason: string }

/** Integer: every min + max in the table is even in bps. */
export const midBps = (r: RangeRow): number => (r.minBps + r.maxBps) / 2;

export interface FundBuy {
  instrumentId: string; name: string; kind: string; fundType: FundType;
  /** midpoint − actual share of the type, in bps; > 0 for every buy except an `upToMax` one. */
  gapBps: number;
  /** The type's actual share and its signed midpoint (raw, not normalised), in bps. */
  actualBps: number; midBps: number;
  /** The type's signed range, in bps. */
  minBps: number; maxBps: number;
  heldPaise: bigint;
  /** e.g. 'rank 2 of 11 in Equity Scheme - Mid Cap Fund' or 'index fund — exempt'. */
  quality: string;
}

export interface FundCandidates {
  approved: boolean;
  buys: FundBuy[];
  typesBelowMidpoint: FundType[];
  excluded: { instrumentId: string; name: string; reason: string }[];
}

/** Largest gap first, then the larger holding, then id (Decision 8). */
export const byGap = (a: FundBuy, b: FundBuy): number =>
  b.gapBps - a.gapBps || (a.heldPaise === b.heldPaise ? 0 : a.heldPaise > b.heldPaise ? -1 : 1) || a.instrumentId.localeCompare(b.instrumentId);
