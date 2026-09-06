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
    works: ['cash.ceiling at 20%', 'Breach messages'],
    missing: ['More rail types as the owner defines them'],
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
    stage: 'p1',
    task: 'Task 6',
    what: 'The ~40-name advisory watchlist with quarterly proposals.',
    works: ['The daily digest names watchlist candidates'],
    missing: ['Persistent watchlist table', 'Advisor proposals & owner sign-off flow'],
  },
  {
    slug: 'signals',
    name: 'Signal review',
    stage: 'p1',
    task: 'Task 7',
    what: 'Machine-checked signals, presented for the owner to confirm or dismiss.',
    works: ['Signals are hand-synthesised in the Telegram summaries today'],
    missing: ['Signal record table', 'Gap filters (freshness-gated)', 'Owner confirm/dismiss'],
  },
  {
    slug: 'recommendations',
    name: 'Recommendation pipeline',
    stage: 'p1',
    task: 'Task 10',
    what: 'Paper recommendations the owner approves, suppresses or marks executed — no orders anywhere.',
    works: ['Nothing yet — FR-31 gating and the whole pipeline are Task 10'],
    missing: ['Recommendation generation', 'Paper record', 'Approval gate UI'],
  },
  {
    slug: 'maturity',
    name: 'Maturity calendar',
    stage: 'p1',
    task: 'Task 1',
    what: 'Sammaan bond maturity and any other dated instruments.',
    works: ['Sammaan redeems 26-Sep-2026 (known)'],
    missing: ['Interest/redemption forecast', 'Roll-over or reinvest auto-decision'],
  },
  {
    slug: 'narrative',
    name: 'Weekly narrative',
    stage: 'p1',
    task: 'Task 11',
    what: 'The Opus/OpenRouter weekly synthesis in Telegram, previewed here.',
    works: ['The weekly Telegram already carries a synthesis placeholder'],
    missing: ['LLM narration', 'Recommendation narration driven by the pipeline'],
  },
  {
    slug: 'scoring',
    name: 'Scoring & calibration',
    stage: 'p1',
    task: 'Task 12',
    what: 'Track whether recommendations beat their baseline, and calibrate.',
    works: ['Nothing yet — there is no recommendation record to score'],
    missing: ['Scorecard', 'Calibration feedback'],
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