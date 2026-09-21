/**
 * The product map — one row per area of the product, its current state, and what
 * exists / is missing. This is the honest answer to "what is there and what is not,
 * what works and what does not". Kept in one file so the map and the shells never
 * drift apart from each other.
 */

export type Stage = 'live' | 'p1' | 'p2';

export interface Area {
  slug: string;
  name: string;
  stage: Stage;
  task?: string;
  what: string;
  works: string[];
  missing: string[];
}

export const AREAS: Area[] = [
  {
    slug: 'overview',
    name: 'Net worth & day-over-day',
    stage: 'live',
    what: 'Assets, liabilities, net worth, and the previous-day change.',
    works: ['Real balances from snapshots', 'Day change', 'FI floor / stretch reporting band'],
    missing: ['Nothing material — Phase 0 data is complete'],
  },
  {
    slug: 'holdings',
    name: 'Holdings & accounts',
    stage: 'live',
    what: 'Every position with cost basis, value, freshness and source.',
    works: ['Positions by account', 'Cost basis (unknown rendered as unknown, never ₹0)', 'Per-instrument staleness'],
    missing: ['Order of booked gains (Phase 2)', 'Decomposed baskets (smallcase residue, INDMONEY basket)'],
  },
  {
    slug: 'allocation',
    name: 'Allocation vs IPS',
    stage: 'live',
    what: 'Asset-class drift against IPS bands and the money that would restore them.',
    works: ['Drift + breach state', 'Sector cap over sector-carrying holdings', 'Concentration'],
    missing: ['Full-sector coverage (few instruments carry a sector yet)'],
  },
  {
    slug: 'buckets',
    name: 'Buckets & milestones',
    stage: 'live',
    what: 'FI corpus, house, emergency and education goals vs their flows.',
    works: ['Bucket balances & funded ratio', 'M1 / M2 milestone state'],
    missing: ['raised_on timestamps for open milestones (owner true-up)'],
  },
  {
    slug: 'rails',
    name: 'Owner rails',
    stage: 'live',
    what: 'The owner\u2019s own rules, reported separately from IPS clauses.',
    works: ['Cash ceiling at 10% (PRD §3.3, read from settings_rails)', 'Breach messages'],
    missing: [
      'The other seven owner rails are constants in code, not read from settings_rails',
      'More rail types as the owner defines them',
    ],
  },
  {
    slug: 'rsu',
    name: 'RSU pipeline',
    stage: 'live',
    what: 'Projected vest schedule at the live NOW price and USD/INR.',
    works: ['Tranche projection', 'Confirmed (ACTUAL) vests', 'Next vest'],
    missing: ['Confirmation happens on Telegram; the web UI is read-only for now'],
  },
  {
    slug: 'ips',
    name: 'IPS viewer',
    stage: 'live',
    what: 'The current IPS version, append-only.',
    works: ['Rendered full text + version'],
    missing: ['Clause-level navigation (Phase 2)'],
  },
  {
    slug: 'freshness',
    name: 'Data freshness',
    stage: 'live',
    what: 'Every source\u2019s age against its freshness limit, and the instruments FR-31 blocks.',
    works: ['Age vs limit per source', 'unimplemented ≠ stale', 'Blocked-instrument list'],
    missing: ['NAV / price ingestion paths (amfi, bhavcopy, screener)'],
  },
  {
    slug: 'audit',
    name: 'Audit log',
    stage: 'live',
    what: 'The append-only ledger of every agent/owner/system action.',
    works: ['All rows, newest first', 'Web import resolutions (web_upload entity)'],
    missing: ['Filters and drill-down (Phase 2)'],
  },
  {
    slug: 'import',
    name: 'Statement import',
    stage: 'live',
    what: 'Owner uploads a brokerage/Kite or Fidelity RSU statement, the LLM proposes costs/vests, and the owner confirms each one — the web twin of the Telegram /cost and /fidelity flows.',
    works: ['Archive to data/screenshots', 'LLM extraction when LLM_API_KEY is set', 'Owner confirm / reject with audit trail', 'Same write functions as the Telegram bot'],
    missing: ['LLM_API_KEY in .env — extraction is dormant until it is', 'Ticker map extension as new instruments appear'],
  },
  {
    slug: 'watchlist',
    name: 'Watchlist',
    stage: 'live',
    what: 'The advisory watchlist, append-only: a removal is a removed_on date, never a deleted row.',
    works: ['Active and removed names with source and reason', 'Read-only web surface'],
    missing: [
      'Add / remove / reprioritise from the web — owner decisions still go through the quarterly proposal flow',
      'The seeded rows carry an LLM-originated provenance that has not been owner-signed',
    ],
  },
  {
    slug: 'signals',
    name: 'Signal review',
    stage: 'live',
    what: 'The satellite composite and the section 6 quality gate for the latest scoring run.',
    works: [
      'Composite plus the valuation / trend / earnings / fit legs',
      'Fail-closed quality gate shown per name',
      'Fundamentals from the most recent screener upload carrying that instrument',
    ],
    missing: ['Owner confirm / dismiss on a signal', 'History across scoring runs — only the latest is shown'],
  },
  {
    slug: 'recommendations',
    name: 'Recommendation pipeline',
    stage: 'live',
    what: 'Paper recommendations with their alternates, cited IPS clauses and suppression state — no orders anywhere.',
    works: [
      'FR-11 primary plus alternates, and the FR-10 clause citations',
      'FR-12 capped actions listed as suppressed rather than hidden',
    ],
    missing: ['Approve / suppress from this page — approvals live on /approvals', 'Engine evidence is stored but not yet rendered in a readable shape'],
  },
  {
    slug: 'maturity',
    name: 'Maturity calendar',
    stage: 'live',
    what: 'Dated instruments, what they redeem for and when.',
    works: [
      'Redemptions inside a 365-day horizon with days-until',
      'Face value and coupon, with an unrecorded face value shown as unknown rather than zero',
    ],
    missing: ['Routing decision captured on the page', 'Coupon accrual forecast between now and maturity'],
  },
  {
    slug: 'narrative',
    name: 'Weekly narrative',
    stage: 'live',
    what: 'The weekly deep report and its LLM narration.',
    works: [
      'Every delivered report, newest first, with the narration that was actually sent',
      'The engine bullets beside the narration, so a narration that drifted from them is visible',
      'A run delivered without a narration says so, rather than showing an empty panel',
    ],
    missing: [
      'Runs delivered before 2026-09-21 carry no narration — it was not stored until then',
      'A dry run is not recorded at all, by design, so it cannot mask a failed send',
    ],
  },
  {
    slug: 'funds',
    name: 'Mutual funds',
    stage: 'live',
    what: 'Every fund held, scored on consistency, cost and size.',
    works: [
      'Consistency over rolling 12-MONTH windows, downsampled from daily NAVs',
      'Cost and size from INDmoney, with AUM in rupees crore verified against known fund sizes',
      'A fund with too little NAV history has its consistency withheld rather than scored 0 silently',
    ],
    missing: [
      'Fund tenure and style drift have no source — 25 of the 100 points are unreachable, so 75 is full marks',
      'Size scores the same for every fund held: the AUM ramp tops out at 2,000 crore and all six are far above it',
      'No mf_switch recommendation — a switch needs a candidate universe, which is an owner decision',
    ],
  },
  {
    slug: 'scoring',
    name: 'Scoring & calibration',
    stage: 'live',
    what: 'Whether a recommendation beat the benchmark it was measured against, grouped by conviction.',
    works: [
      'Calibration by conviction and horizon, withholding a hit-rate until a bucket has enough evaluations',
      'Benchmarked recommendations with their 3 / 6 / 12 month evaluation state',
    ],
    missing: ['The minimum-N of 20 is an assumed threshold awaiting owner confirmation'],
  },
  {
    slug: 'execution',
    name: 'Broker integration & orders',
    stage: 'p2',
    what: 'Execution is every action walled behind a fresh human approval.',
    works: ['Phase 2 — deliberately not built yet'],
    missing: ['Broker integration', 'Approval gate', 'Settlement/position reconciliation'],
  },
];

export const STAGE_LABEL: Record<Stage, string> = {
  live: 'Live',
  p1: 'Phase 1',
  p2: 'Phase 2',
};