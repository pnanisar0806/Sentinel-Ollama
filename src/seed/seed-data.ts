import { rupees, type Paise } from '../money/paise.js';

export type Account = 'zerodha' | 'indmoney' | 'fidelity' | 'epf' | 'bank' | 'groww';

export interface InstrumentSeed {
  id: string;
  kind: 'EQUITY' | 'ETF' | 'MF' | 'BOND' | 'CASH' | 'EPF' | 'RSU' | 'GOLD';
  name: string;
  currency: 'INR' | 'USD';
  sector?: string;
  issuer?: string;
  isEmployer?: boolean;
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
  { id: 'EPF:ANIRBAN', kind: 'EPF', name: 'Employees Provident Fund', currency: 'INR' },
  { id: 'MF:ICICI-NIFTY50-IDX', kind: 'MF', name: 'ICICI Pru Nifty 50 Index Direct', currency: 'INR' },
  { id: 'MF:PPFC', kind: 'MF', name: 'Parag Parikh Flexi Cap Direct', currency: 'INR' },
  { id: 'MF:ICICI-LARGECAP', kind: 'MF', name: 'ICICI Pru Large Cap Direct', currency: 'INR' },
  { id: 'MF:HDFC-MIDCAP', kind: 'MF', name: 'HDFC Mid Cap Opportunities Direct', currency: 'INR' },
  { id: 'MF:MOTILAL-MIDCAP', kind: 'MF', name: 'Motilal Oswal Midcap Direct', currency: 'INR' },
  { id: 'MF:BANDHAN-SMALLCAP', kind: 'MF', name: 'Bandhan Small Cap Direct', currency: 'INR' },
  { id: 'NSE:NIFTYBEES', kind: 'ETF', name: 'Nippon Nifty BeES', currency: 'INR' },
  { id: 'NSE:GOLDBEES', kind: 'GOLD', name: 'Gold ETF', currency: 'INR' },
  { id: 'NSE:LIQUIDBEES', kind: 'ETF', name: 'Liquid ETF', currency: 'INR' },
  { id: 'NSE:SMALLCASE-RESIDUE', kind: 'EQUITY', name: 'Smallcase residue (unallocated; cleanup queue)', currency: 'INR' },
  { id: 'NSE:RPOWER', kind: 'EQUITY', name: 'Reliance Power (Groww - manual closure)', currency: 'INR', sector: 'Power' },
  { id: 'BOND:SAMMAAN-2026', kind: 'BOND', name: 'Sammaan Capital 9% 26-Sep-2026', currency: 'INR', issuer: 'Sammaan Capital' },
  { id: 'BOND:SAMMAAN-2029', kind: 'BOND', name: 'Sammaan Capital 9.75% Jul-2029', currency: 'INR', issuer: 'Sammaan Capital' },
  { id: 'BOND:EDELWEISS-2033', kind: 'BOND', name: 'Edelweiss Financial 10.45% Oct-2033', currency: 'INR', issuer: 'Edelweiss Financial' },
  { id: 'CASH:SAVINGS', kind: 'CASH', name: 'Savings account', currency: 'INR' },
  { id: 'US:INDMONEY-BASKET', kind: 'EQUITY', name: 'US fractional basket (AAPL/GOOGL/AMZN/MSFT/TSLA/VOO)', currency: 'USD' },
  { id: 'US:NOW', kind: 'RSU', name: 'ServiceNow (NOW) - vested, Fidelity', currency: 'USD', sector: 'Technology', issuer: 'ServiceNow', isEmployer: true },
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

  // Corporate bonds - line items sum to 6.00L; source document states 6.33L for this bucket (difference likely accrued interest) - flagged for owner true-up
  { instrumentId: 'BOND:SAMMAAN-2026', account: 'indmoney', quantity: 1, valuePaise: rupees(284_000), avgCostPaise: null },
  { instrumentId: 'BOND:SAMMAAN-2029', account: 'indmoney', quantity: 1, valuePaise: rupees(96_000), avgCostPaise: null },
  { instrumentId: 'BOND:EDELWEISS-2033', account: 'indmoney', quantity: 1, valuePaise: rupees(220_000), avgCostPaise: null },

  { instrumentId: 'CASH:SAVINGS', account: 'bank', quantity: 1, valuePaise: rupees(163_000), avgCostPaise: null },
  { instrumentId: 'US:INDMONEY-BASKET', account: 'indmoney', quantity: 1, valuePaise: rupees(137_000), avgCostPaise: null },
  { instrumentId: 'US:NOW', account: 'fidelity', quantity: 1, valuePaise: rupees(500_000), avgCostPaise: null },
];

export const SEED_LOANS: LoanSeed[] = [
  {
    id: 'car1', name: 'Car loan 1', lender: 'HDFC',
    principalPaise: rupees(650_000), outstandingPaise: rupees(220_000),
    annualRateBps: 795, emiPaise: rupees(13_821),
    startedOn: '2023-02-01', naturalEndOn: '2028-01-01', cascadeOrder: 1,
  },
  {
    id: 'car2', name: 'Car loan 2', lender: 'Bank of Baroda',
    principalPaise: rupees(550_000), outstandingPaise: rupees(495_000),
    annualRateBps: 795, emiPaise: rupees(17_223),
    startedOn: '2026-04-01', naturalEndOn: '2029-04-01', cascadeOrder: 2,
  },
  {
    id: 'home', name: 'Home loan (Kolkata flat)', lender: 'SBI',
    principalPaise: rupees(3_200_000), outstandingPaise: rupees(3_024_000),
    annualRateBps: 795, emiPaise: rupees(24_482),
    startedOn: '2022-03-01', naturalEndOn: '2047-02-01', cascadeOrder: 3,
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
