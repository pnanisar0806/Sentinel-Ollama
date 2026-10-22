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
  // Goal plan (spec 2026-10-21-goal-plan-design). FI year = ownerBirthYear + fiTargetAge;
  // education starts at childArrivalYear — no duplicate constants for either.
  /** Spec §4: debt real 1% = 7% nominal − 6% inflation; band ±2. */
  debtNominalCagr: 0.07,
  debtSensitivityBand: 0.02,
  /** Spec §4: gold real 2% = 8% nominal − 6% inflation; band ±2. */
  goldNominalCagr: 0.08,
  goldSensitivityBand: 0.02,
  /** SBI and HDFC savings rate, flat 2.5% since June 2025; checked 2026-10-21. No band. */
  cashNominalCagr: 0.025,
  /** Spec §2 (2026-10-21) and §6: 2008-grade crash, equity −50%, landing within 3 years. */
  crashEquityDrop: 0.50,
  crashHorizonMonths: 36,
  /** Spec §12 Q2: passbook, Sep-2026 wage month: employee ₹13,135 + employer EPF ₹11,497; EPS excluded. */
  epfMonthlyContributionInr: 24_632,
  /** Spec §4: house ₹65L real by 2033; emergency ₹6L by Dec 2026; education ₹1Cr real by 2046. */
  houseTargetYear: 2033,
  emergencyTargetMonth: '2026-12',
  educationEndYear: 2046,
  /** Spec §11.3: new FI money's gold share, the middle of the IPS 5–10% band. */
  goalGoldMixPct: 7.5,
} as const;

type Assumptions = typeof ASSUMPTIONS;
