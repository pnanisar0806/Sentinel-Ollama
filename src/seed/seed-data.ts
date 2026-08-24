import { rupees, type Paise } from '../money/paise.js';

export type Account = 'zerodha' | 'indmoney' | 'fidelity' | 'epf' | 'bank' | 'groww';

export interface InstrumentSeed {
  id: string;
  kind: 'EQUITY' | 'ETF' | 'MF' | 'BOND' | 'CASH' | 'EPF' | 'RSU' | 'GOLD';
  name: string;
  currency: 'INR' | 'USD';
  isin?: string | undefined;
  sector?: string | undefined;
  issuer?: string | undefined;
  isEmployer?: boolean | undefined;
  /** Canonical instrument ID for cross-source reconciliation (C-A).
   *  Live source wins per (canonical_id, account); seed fills gaps;
   *  fallback to seed when live stops reporting.
   *  Bonds: ISIN. MFs/ETFs/Stocks: stable code the owner defines. */
  canonicalId?: string | undefined;
}

export interface HoldingSeed {
  instrumentId: string;
  account: Account;
  quantity: number;
  valuePaise: Paise;
  /** null = unknown cost (FR-02). Never 0. */
  avgCostPaise: Paise | null;
}

export interface LoanSeed {
  id: string;
  name: string;
  lender: string;
  principalPaise: Paise;
  outstandingPaise: Paise;
  annualRateBps: number;
  emiPaise: Paise;
  startedOn: string;
  naturalEndOn: string;
  cascadeOrder: 1 | 2 | 3;
}

export interface RsuGrantSeed {
  id: string;
  grantedOn: string;
  units: number;
  note: string;
}

export const SEED_INSTRUMENTS: InstrumentSeed[] = [
  { id: 'EPF:ANIRBAN', kind: 'EPF', name: 'Employees Provident Fund', currency: 'INR', canonicalId: 'EPF:SERVICE_NOW' },
  { id: 'MF:ICICI-NIFTY50-IDX', kind: 'MF', name: 'ICICI Pru Nifty 50 Index Direct', currency: 'INR', canonicalId: 'MF:5536' },
  { id: 'MF:PPFC', kind: 'MF', name: 'Parag Parikh Flexi Cap Direct', currency: 'INR', canonicalId: 'MF:3229' },
  { id: 'MF:ICICI-LARGECAP', kind: 'MF', name: 'ICICI Pru Large Cap Direct', currency: 'INR', canonicalId: 'MF:2995' },
  { id: 'MF:HDFC-MIDCAP', kind: 'MF', name: 'HDFC Mid Cap Opportunities Direct', currency: 'INR', canonicalId: 'MF:3097' },
  { id: 'MF:MOTILAL-MIDCAP', kind: 'MF', name: 'Motilal Oswal Midcap Direct', currency: 'INR', canonicalId: 'MF:3113' },
  { id: 'MF:BANDHAN-SMALLCAP', kind: 'MF', name: 'Bandhan Small Cap Direct', currency: 'INR', canonicalId: 'MF:1005544' },
  { id: 'NSE:NIFTYBEES', kind: 'ETF', name: 'Nippon Nifty BeES', currency: 'INR', canonicalId: 'NSE:INDS19182' },
  { id: 'NSE:GOLDBEES', kind: 'GOLD', name: 'Gold ETF', currency: 'INR', canonicalId: 'NSE:INDS29570' },
  { id: 'NSE:LIQUIDBEES', kind: 'ETF', name: 'Liquid ETF', currency: 'INR', canonicalId: 'NSE:INDS28892' },
  { id: 'NSE:SMALLCASE-RESIDUE', kind: 'EQUITY', name: 'Smallcase residue (unallocated; cleanup queue)', currency: 'INR', canonicalId: 'NSE:SMALLCASE-RESIDUE' },
  { id: 'NSE:RPOWER', kind: 'EQUITY', name: 'Reliance Power (Groww - manual closure)', currency: 'INR', sector: 'Power', canonicalId: 'NSE:INDS01338' },
  { id: 'BOND:SAMMAAN-2026', kind: 'BOND', name: 'Sammaan Capital 9% 26-Sep-2026', currency: 'INR', issuer: 'Sammaan Capital', isin: 'INE148I07GL3', canonicalId: 'ISIN:INE148I07GL3' },
  { id: 'BOND:SAMMAAN-2029', kind: 'BOND', name: 'Sammaan Capital 9.75% 23-Jul-2029', currency: 'INR', issuer: 'Sammaan Capital', isin: 'INE148I07TX1', canonicalId: 'ISIN:INE148I07TX1' },
  { id: 'BOND:EDELWEISS-2033', kind: 'BOND', name: 'Edelweiss Financial 10.45% 26-Oct-2033', currency: 'INR', issuer: 'Edelweiss Financial', isin: 'INE532F07EK1', canonicalId: 'ISIN:INE532F07EK1' },
  { id: 'CASH:SAVINGS', kind: 'CASH', name: 'Savings account', currency: 'INR', canonicalId: 'CASH:SAVINGS_HDFC_FEDERAL' },
  { id: 'US:INDMONEY-BASKET', kind: 'EQUITY', name: 'US fractional basket (AAPL/GOOGL/AMZN/MSFT/TSLA/VOO)', currency: 'USD', canonicalId: 'US:INDMONEY-BASKET' },
  { id: 'US:NOW', kind: 'RSU', name: 'ServiceNow (NOW) - vested, Fidelity', currency: 'USD', sector: 'Technology', issuer: 'ServiceNow', isEmployer: true, canonicalId: 'US:NOW' },
];

export const SEED_HOLDINGS: HoldingSeed[] = [
  { instrumentId: 'EPF:ANIRBAN', account: 'epf', quantity: 1, valuePaise: rupees(1_354_000), avgCostPaise: null },

  // Mutual funds - 11.83L (source states 11.84L, rounding)
  { instrumentId: 'MF:ICICI-NIFTY50-IDX', account: 'zerodha', quantity: 1, valuePaise: rupees(47_000), avgCostPaise: null },
  { instrumentId: 'MF:ICICI-NIFTY50-IDX', account: 'indmoney', quantity: 1, valuePaise: rupees(281_000), avgCostPaise: null },
  { instrumentId: 'MF:ICICI-NIFTY50-IDX', account: 'indmoney', quantity: 1, valuePaise: rupees(368_000), avgCostPaise: null },
  { instrumentId: 'MF:PPFC', account: 'indmoney', quantity: 1, valuePaise: rupees(241_000), avgCostPaise: null },
  { instrumentId: 'MF:ICICI-LARGECAP', account: 'indmoney', quantity: 1, valuePaise: rupees(203_000), avgCostPaise: null },
  { instrumentId: 'MF:HDFC-MIDCAP', account: 'indmoney', quantity: 1, valuePaise: rupees(19_000), avgCostPaise: null },
  { instrumentId: 'MF:MOTILAL-MIDCAP', account: 'indmoney', quantity: 1, valuePaise: rupees(6_000), avgCostPaise: null },
  { instrumentId: 'MF:BANDHAN-SMALLCAP', account: 'indmoney', quantity: 1, valuePaise: rupees(18_000), avgCostPaise: null },

  // Indian stocks / ETFs - 8.32L total
  { instrumentId: 'NSE:NIFTYBEES', account: 'zerodha', quantity: 1, valuePaise: rupees(95_000), avgCostPaise: null },
  { instrumentId: 'NSE:GOLDBEES', account: 'zerodha', quantity: 2616, valuePaise: rupees(63_000), avgCostPaise: null },
  { instrumentId: 'NSE:LIQUIDBEES', account: 'zerodha', quantity: 1, valuePaise: rupees(16_000), avgCostPaise: null },
  { instrumentId: 'NSE:SMALLCASE-RESIDUE', account: 'zerodha', quantity: 1, valuePaise: rupees(655_400), avgCostPaise: null },
  { instrumentId: 'NSE:RPOWER', account: 'groww', quantity: 1, valuePaise: rupees(2_600), avgCostPaise: null },

  // Corporate bonds - owner-verified 2026-08-14 from the INDmoney bonds screen. The three
  // line items sum to exactly 5,99,999.61, which is the portal's own stated Total
  // Investment, so the PRD's 6.33L for this bucket is superseded. Portfolio YTM 10.86%.
  //
  //   ISIN           units  coupon   YTM     invested      matures      next coupon
  //   INE148I07GL3     300   9.00%  11.29%  2,84,057.70   26-Sep-2026   26-Sep-2026
  //   INE148I07TX1       1   9.75%  11.70%    95,941.91   23-Jul-2029   23-Jul-2027
  //   INE532F07EK1     220  10.45%  10.44%  2,20,000.00   26-Oct-2033   26-Oct-2026
  //
  // These are INVESTED amounts, not marks - the screen reports cost, not market value, so
  // value == cost here and unrealised P&L reads as zero until the Task 11B sync supplies
  // real marks. Coupons are paid out annually rather than accrued into the bond, so the
  // portal's 1,19,480 "Returns Till Date" (exactly 2 years of coupon on each line) is cash
  // already received and must NOT be added to these values.
  //
  // quantity stays 1 with the total in valuePaise, matching every other line in this file;
  // avg_cost_paise is therefore the total cost, not a per-unit cost. Real unit counts live
  // in the table above. Per-unit cost would not be a whole number of paise anyway
  // (2,84,057.70 / 300).
  { instrumentId: 'BOND:SAMMAAN-2026', account: 'indmoney', quantity: 1, valuePaise: rupees('284057.70'), avgCostPaise: rupees('284057.70') },
  { instrumentId: 'BOND:SAMMAAN-2029', account: 'indmoney', quantity: 1, valuePaise: rupees('95941.91'), avgCostPaise: rupees('95941.91') },
  { instrumentId: 'BOND:EDELWEISS-2033', account: 'indmoney', quantity: 1, valuePaise: rupees('220000.00'), avgCostPaise: rupees('220000.00') },

  { instrumentId: 'CASH:SAVINGS', account: 'bank', quantity: 1, valuePaise: rupees(163_000), avgCostPaise: null },
  { instrumentId: 'US:INDMONEY-BASKET', account: 'indmoney', quantity: 1, valuePaise: rupees(137_000), avgCostPaise: null },
  { instrumentId: 'US:NOW', account: 'fidelity', quantity: 1, valuePaise: rupees(500_000), avgCostPaise: null },
];

export const SEED_LOANS: LoanSeed[] = [
  {
    // Owner-verified 2026-08-14 from the HDFC portal (a/c ...7670). Every field
    // reconciles: principal paid 6,74,755 + outstanding 2,22,006 = 8,96,761 sanctioned;
    // 8,96,761 over 84 months at 7.65% gives exactly the 13,821 EMI; 2,22,006 at 13,821
    // runs 17.0 more months, matching the portal's 17 pending instalments and its
    // 07 Jan 2028 maturity. NOTE the rate is 7.65%, not the 7.95% previously assumed.
    id: 'car1', name: 'Car loan 1', lender: 'HDFC',
    principalPaise: rupees(896_761), outstandingPaise: rupees(222_006),
    annualRateBps: 765, emiPaise: rupees(13_821),
    startedOn: '2021-02-01', naturalEndOn: '2028-01-01', cascadeOrder: 1,
  },
  {
    // Owner-verified 2026-08-14 from the Bank of Baroda portal (a/c ...8366). Sanctioned
    // and disbursed 5,50,000; outstanding 4,68,205; EMI 17,223 at 7.95%. 5,50,000 over
    // 36 months at 7.95% gives exactly 17,223, confirming a 3-year term from Apr 2026,
    // so the natural end is Mar 2029 (was recorded as Apr 2029).
    id: 'car2', name: 'Car loan 2', lender: 'Bank of Baroda',
    principalPaise: rupees(550_000), outstandingPaise: rupees(468_205),
    annualRateBps: 795, emiPaise: rupees(17_223),
    startedOn: '2026-04-01', naturalEndOn: '2029-03-01', cascadeOrder: 2,
  },
  {
    // Owner-verified 2026-08-14 from the SBI portal. The loan is split across two
    // accounts at the same rate and origination; modelled here as one line because
    // amortization at a shared rate is linear, so the sum behaves identically:
    //   a/c ...7807  sanctioned 30,00,000  outstanding 29,09,463  EMI 23,988
    //   a/c ...8245  sanctioned    56,924  outstanding    53,680  EMI    494
    // The portal's "Remaining Tenure" (379 / 246 months) does NOT reconcile with the
    // balance, EMI and rate on either account and is treated as a stale field: 379
    // months at 23,988 would require a 33.24L balance. Balance + EMI + rate give a
    // natural payoff of ~Dec 2046, which is what naturalEndOn records.
    id: 'home', name: 'Home loan (Kolkata flat)', lender: 'SBI',
    principalPaise: rupees(3_056_924), outstandingPaise: rupees(2_963_143),
    annualRateBps: 795, emiPaise: rupees(24_482),
    startedOn: '2022-03-01', naturalEndOn: '2046-12-01', cascadeOrder: 3,
  },
];

export const SEED_BUCKETS = [
  { id: 'B1', name: 'FI corpus', targetPaise: null,
    mandate: 'Max risk-adjusted return within a 30% max-drawdown constraint',
    targetNote: '10.3-17.1 Cr real at age 55 (2050)' },
  { id: 'B2', name: 'House fund', targetPaise: rupees(6_500_000),
    mandate: 'Capital preservation; duration-matched debt/arbitrage; no equity risk inside 7 years of purchase',
    targetNote: 'Down payment + costs 55-75L for a 2-2.5 Cr Hyderabad home, 2033-35' },
  { id: 'B3', name: 'Emergency fund', targetPaise: rupees(600_000),
    mandate: 'Liquid savings; AU SFB during build, IDFC First beyond 3L, split beyond 5L for DICGC cover',
    targetNote: 'Complete by Dec 2026 from Sammaan maturity + Nov 2026 vest' },
  { id: 'B4', name: 'Education corpus', targetPaise: rupees(10_000_000),
    mandate: 'Long-horizon equity glide path, de-risking from ~2040',
    targetNote: '1 Cr in today money at child age 18 (~2046); activates ~2028' },
] as const;

export const SEED_MILESTONES = [
  { id: 'M1', name: 'Term life cover',
    spec: '2 Cr personal term cover, before the child arrives, funded from RSU vests',
    rationale: 'Employer group cover evaporates on exit; the maximum-dependency point is now',
    completedOn: null },
  { id: 'M2', name: 'Health super top-up',
    spec: '~50L family super top-up beyond employer cover',
    rationale: 'Single-income household with a 30L medical event as a defined SIP-stop trigger',
    completedOn: null },
] as const;

/** PRD 2.4: 6 grants, 1,105 units total, quarterly vests over 4 years. */
export const SEED_RSU_GRANTS: RsuGrantSeed[] = [
  { id: 'G2021', grantedOn: '2021-11-15', units: 120, note: 'Joining grant' },
  { id: 'G2022', grantedOn: '2022-02-15', units: 140, note: 'Annual refresher' },
  { id: 'G2023', grantedOn: '2023-02-15', units: 165, note: 'Annual refresher' },
  { id: 'G2024', grantedOn: '2024-02-15', units: 190, note: 'Annual refresher' },
  { id: 'G2025', grantedOn: '2025-02-15', units: 205, note: 'Annual refresher' },
  { id: 'G2026', grantedOn: '2026-02-15', units: 285, note: 'Largest grant to date' },
];
