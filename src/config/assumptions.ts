/**
 * PRD §15.2 standing assumptions. Owner-confirmed; revisit annually.
 * Nothing in this file may be duplicated inline anywhere else in the codebase.
 */
export const ASSUMPTIONS = {
  equityNominalCagr: 0.12,
  sensitivityBand: 0.03,
  inflation: 0.06,
  swrFloor: 0.035,
  swrOptimistic: 0.04,
  sipStepUp: 0.10,
  /**
   * Annual take-home growth, applied each April (fiscal-year start).
   * Deliberately SEPARATE from `sipStepUp` despite being equal today: one is the rate
   * at which the owner raises SIP contributions, the other is salary growth. Sharing a
   * constant would silently move modelled salary the day the SIP step-up is revised.
   */
  salaryStepUp: 0.10,
  rsuRefresherUsdPerYear: 20_000,
  rsuVestYears: 4,
  rsuNetOfWithholding: 0.70,
  seedUsdInr: 95.3,
  seedNowPriceUsd: 127.54,
  childArrivalYear: 2028,
  childMonthlyDentInr: 10_000,
  fiTargetAge: 55,
  ownerBirthYear: 1995,
  /** FI income target in today's purchasing power, monthly (PRD §2.5). */
  fiIncomeFloorMonthlyInr: 300_000,
  fiIncomeStretchMonthlyInr: 500_000,
} as const;

export type Assumptions = typeof ASSUMPTIONS;
