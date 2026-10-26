# Piece 3: funds first, a strict stock gate, and a fund mix review. Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Every subagent runs on Opus (owner rule).

**Goal:** Funds get the monthly money before stocks. A stock reaches the advisor only if it passes five fail-closed checks and has a composite of at least 85. The owner approves a target range for each fund type on `/funds`, and `/funds` then suggests SIP amounts that move new money toward that mix. None of this ever sells.

**Architecture:**
- **Stock gate:** `src/domain/stock-checks.ts` holds a pure evaluator and a read-only loader. Valuation is recomputed on read from the latest close and the uploaded EPS, so no job is needed. Governance events come from a narrower classifier plus a three-year BSE backfill in `src/sources/news.ts`.
- **Fund mix:** `src/domain/fund-mix.ts` holds the fund-type table, the spec §7 range table, the proposal, the actual mix, findings, the signed mix, the monthly fund candidates and the SIP suggestion. Signed ranges live in a new append-only table.
- **Sizing and advisor:** `sizing.ts` sizes fund candidates first and withholds stocks while any fund type is below its midpoint. `recommend.ts` moves to `advise-v3`: funds skip the news rule, and a stock BUY must carry `whyNotFund`.
- **Index funds:** the new-index-fund chooser (§8.1) reads INDmoney's category listing into a new append-only table during the daily sync.

**Tech Stack:** TypeScript, vitest + PGlite, postgres-js/Supabase, Next.js 15 `web/`, INDmoney MCP, BSE announcements API.

**Spec:** `docs/superpowers/specs/2026-10-23-funds-first-design.md`, owner-approved 2026-10-23. It supersedes §3 of `2026-10-14-sips-goals-advisor-design.md`.

## Global Constraints

- **Money:** branded `bigint` paise only (`src/money/paise.ts`). Shares and ranges are integer **basis points** (1% = 100 bps), never floats, so the 42.5% midpoint is exact. P/E is a unitless ratio and may be a JS number.
- **Unknown values:**
  - Unknown is `null`, shown on a page as "unknown" or "—". It is never ₹0 and never 0%.
  - A stock check whose data is missing returns `UNKNOWN`, and `UNKNOWN` counts as a failure.
  - Before a mix is signed, the target column reads "not set — approve the proposal below".
- **New tables:**
  - Every stored row carries `as_of` and `source`.
  - Every new table has `sentinel_append_only()` triggers for UPDATE, DELETE and TRUNCATE.
  - RLS is enabled with **no policy**. Copy the pattern from `migrations/0036_log_batch_a.sql`. The `pg_policies` = 0 test must stay green.
- **Never sells:** no new code path emits SELL, TRIM or REDEEM. An overweight type gets no candidate and a suggested SIP of at least ₹0. Sales remain the job of the existing sell triggers.
- **Firewall:** the normal plan stays goal-blind.
  - `fund-mix.ts` takes the horizon from `ASSUMPTIONS.ownerBirthYear + ASSUMPTIONS.fiTargetAge` (`src/config/assumptions.ts`).
  - Nothing new imports `goal-plan.ts`, `funded-status.ts` or `buckets.ts`.
  - `tests/architecture/no-catch-up.test.ts` passes **unchanged**.
- **Spec values to copy exactly:**
  - **Debt:** a D/E of 1 or more fails (`QUALITY.maxDeRatio`). `FINANCE_SECTORS` are exempt.
  - **Pledge:** a pledge above 0% fails.
  - **Valuation:** a P/E above 1.5 × the sector median fails. A stock with no sector, or with fewer than 5 peers, is `UNKNOWN`.
  - **Growth:** a 5-year profit CAGR or a 5-year sales CAGR below 12% fails.
  - **Cash flow:** 5-year cash from operations below 70% of 5-year profit after tax fails.
  - **Promoter holding:** a drop of more than 5 percentage points over a year fails.
  - **Composite:** at least `BANDS.high` (85).
  - **Core share:** core is at least 70% of equity flows.
  - **Scheme cap:** 35% of the liquid portfolio for a single scheme (`CAPS.singleMfScheme`).
  - **SIPs:** amounts round to ₹100; the SIP total is unchanged; non-core flows never exceed 30%; midpoints are normalised to 100%.
  - **Ranges:** the spec §7 range table is copied verbatim in Task 4.
- **The `Db` interface:** `{ query<T>(sql, params?): Promise<T[]>; exec(sql); withTransaction<T>(fn); close() }`.
  - PGlite returns `bigint` columns as JS numbers and `date`/`timestamptz` columns as `Date`; postgres-js returns strings. Widen with `BigInt()`, and select `::text` where exactness matters.
  - PGlite is a single connection.
- **Reference code is a sketch:** the snippets below are unverified, and plan snippets in this project have a track record of being wrong. Adjudicate on working arithmetic.
- **Tests:**
  - TDD: each test must be seen red first.
  - Never widen a band or edit an expected constant to go green.
  - Derive expected values from fixtures, and mutation-check every guard named in a task.
- **Copy:** pages follow `design-system/sentinel/MASTER.md` and use only the `web/lib/ui.tsx` primitives (`PageHead`, `Card`, `DataTable`, `Badge`, `Stat`, `Notice`, `Money`). An empty table says why it is empty and names the job that fills it.
- **Commits:** local only, never pushed. Messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Verification per task:**
  - the task's tests;
  - `pnpm vitest run tests/architecture tests/db`;
  - `pnpm exec tsc --noEmit`;
  - when `web/` is touched, `pnpm --dir web exec tsc --noEmit`.

## Decisions this plan makes (the spec left them to the builder)

1. **Fund types:**
   - The type comes from an explicit table keyed by **ISIN**. That is the scheme identity shared by the seed, INDmoney and AMFI. A position resolves through its own `instruments.isin` or its canonical sibling's.
   - Each entry carries a `topUp` flag. Junior BeES and Vanguard S&P 500 have `topUp: false` (§8: kept, not topped up). An untyped fund shows as "type unknown" and is never a candidate.
2. **Horizon:**
   - Years = (`ownerBirthYear + fiTargetAge`) − the current IST year. That is 2050 − 2026 = 24 today.
   - 15 years or more uses the `15+` column; 7 to 15 years uses `7-15`.
   - Under 7 years there is **no proposal** ("the range table has no row under 7 years — owner decision needed").
3. **Signed mix:**
   - One row per signing in `fund_mix_signed` (migration 0037), with ranges stored as jsonb. The latest row is in force.
   - The owner signs the whole table exactly as proposed; there are no edits.
   - A proposal is "new" when its band differs from the signed band, or when the signed row is 365 days old or more. The old ranges stay in force until the owner signs again.
4. **P/E:**
   - Recomputed **on read**: `latest close (prices_eod, ≤ 5 days old) ÷ uploaded 'EPS'`. No job is needed, because a daily close makes it daily.
   - Peers are every stock in the **latest Screener upload** with the same `instruments.sector`, a fresh close and a positive EPS. The stock itself is included in its own cohort.
   - EPS of 0 or less is `FAIL` ("loss-making").
   - The composite's own valuation leg (`engine.ts:592`, a watchlist-only median) is **not** changed here.
5. **Governance check (a):**
   - **What counts:** only the spec's list, matched on BSE `raw_subcategory`/`headline`.
   - **Rating downgrades:** BSE rating filings do not say the direction; it is in a PDF (migration 0027). So a rating filing counts only if its headline or subject says "downgrade".
     - The page says that the PDF is not parsed.
     - **This is a judgment call to surface to the owner** (see Task 11).
   - **Clear (PASS):** requires a successful 3-year backfill run that is at most 35 days old. Without one, the check is `UNKNOWN`.
   - **Who is backfilled:** only stocks that already pass the other four checks, are in the HIGH band and passed the quality gate. They are backfilled in `monthlyAdvice` before sizing.
6. **Overall management check:** `FAIL` if any of (a), (b) or (c) fails; otherwise `UNKNOWN` if any is unknown; otherwise `PASS`. The growth check combines its two legs the same way.
7. **Funds before stocks:**
   - Stocks are withheld while any fund type with an approved range is below its midpoint.
   - **Before a mix is signed, stocks are withheld too** ("no approved fund mix yet — approve it on /funds"). The owner's priority is funds, and with the new columns missing no stock can pass anyway.
8. **Fund top-up sizing:**
   - The same tranche as today: `min(remaining envelope, max order, free cash)`.
   - If held value + tranche > 35% of `portfolioPaise` (the same "liquid portfolio" base the 10% stock cap uses), that fund is **withheld and the next is tried**. It is not clamped.
   - Fund candidates are ordered by type gap below the midpoint (largest first), then by held value (larger first), then by id.
9. **Fund quality bar:**
   - An active fund qualifies when `heldRank ≤ ceil((cohortSize + 1) / 2)`, taken from `evaluateSwitches`.
   - An empty cohort counts as unknown, so the fund is not a candidate.
   - Index funds and ETFs are exempt. A fund with `challengerId !== null` is not a candidate.
10. **SIP tilt:**
    - **Weights:**
      - Each type's weight is `mid + max(0, mid − actual)` in bps.
      - A `newMoney: false` type gets 0.
      - Normalise the weights to 100%.
    - **Non-core cap:** if MID + SMALL + LARGE_ACTIVE together exceed 30%, scale them down to 30% and scale core up proportionally.
    - **Rounding:** each fund is floored to ₹100. The remainder goes to the Nifty 50 index row (the anchor), so the total is exact; ₹30,254 is not a multiple of ₹100. The page says so.
    - **Split within a type:** pro rata to current SIPs. If no fund of that type has a SIP, the largest held top-uppable fund of that type gets it.
    - **Untyped SIPs:** they keep their amount and are left out of the redistribution.
11. **New index fund (§8.1):**
    - **Source:** INDmoney `get_mf_by_category` for slugs `nifty-next-50-index-funds` and `global-index-funds`, with `get_mf_funds_details` for `benchmark_name`.
    - **Eligibility:**
      - The benchmark names Nifty Next 50, or S&P 500 or NASDAQ-100 for the US type.
      - The fund resolves to an AMFI Direct Growth scheme (`resolvePeerToAmfi` + `isDirectGrowth`).
      - INDmoney reports `sip_allowed`.
    - **Verified live 2026-10-23:**
      - `get_mf_by_category` carries `sip_allowed` and `purchase_allowed`.
      - The top three `global-index-funds` all have `sip_allowed: false` (Kotak US Specific Equity Passive FoF, Motilal Oswal S&P 500 Index, ICICI US Bluechip).
      - So "none open" is a real, expected outcome.
    - **Unknown status:** if `sip_allowed` is absent for a row, the fund is shown but not proposed.
    - **Tracking error:** Task 10's first step verifies whether any source carries it. If none does, the column stays null, ranking uses expense ratio then AUM, and the page says tracking error is unavailable.
12. **Prompt and schema:** prompt `advise-v2` becomes `advise-v3`, and schema `advise-schema-v1` becomes `advise-schema-v2`, because the reply gains a field.
13. **IPS 70/30:**
    - **Where it changes:** PRD §3.4 and `src/config/ips-v1.ts` change byte-identically. The `ips-verbatim` test enforces this, and `installIps` appends the next `ips_versions` row on the next job start.
    - **`satelliteFit` cap:** becomes 30%.
    - **What counts against the cap:** direct stocks **plus** typed MID, SMALL and LARGE_ACTIVE funds, because spec §7.1 makes these the non-core.

## Review Focus

1. **A stale close.** A stale close (over 5 days) must make valuation `UNKNOWN`, never a P/E computed from an old price (Task 2).
2. **One fund held under two ids.** A fund held under seed `MF:*` and live `IND:*` must count once in the actual mix. Read through `loadPositions`, which dedupes (Task 4).
3. **SIP snapshot stale or unknown.** If the SIP snapshot is stale, or holds a non-MONTHLY SIP, the suggestion is withheld with the envelope's reason. It is never computed from a null total treated as 0 (Task 9).
4. **The goal date moves the horizon band.** The signed ranges stay in force, `/funds` says a new proposal is ready, and candidates keep using the signed row (Task 5).
5. **Unknown envelope or cash.** If the envelope or cash is unknown, a fund candidate is withheld with that reason and never sized from ₹0 or from the full budget (Task 7).

---

### Task 1: Governance events and the three-year BSE backfill

**Files:**
- Modify: `src/sources/news.ts`.
- Test: `tests/sources/governance.test.ts`, using captured rows in `tests/fixtures/bse/`.

**Interfaces (Produces):**
- `type GovernanceKind = 'auditor_resignation' | 'sebi_order' | 'fraud' | 'default_insolvency' | 'pledge_invocation' | 'rating_downgrade'`.
- `isGovernanceEvent(r: { rawCategory: string | null; rawSubcategory: string | null; headline: string; snippet: string | null }): GovernanceKind | null`.
  - **Matched:** auditor resignation (or cessation); SEBI order, adjudication or penalty; fraud; default, insolvency or an NCLT admission; invocation of pledge; and a credit-rating filing whose headline or snippet matches `/downgrad/i`.
  - **Never matched:** litigation, clarification, strike or lockout, Reg 29 or SAST, or a pledge *creation* or encumbrance disclosure.
- `backfillGovernance(db: Db, instrumentId: string, now: Date, opts?: { fetchImpl?: typeof fetch; scrips?: BseScrip[] }): Promise<{ state: 'success' | 'success_empty' | 'failed' | 'unresolved'; stored: number }>`.
  - Fetches 36 months of announcements with `fetchBseAnnouncements`. Storage is the same `news_events` insert `recordNews` uses; extract that insert into a shared helper, not a copy.
  - Writes one `news_fetch_runs` row with `window_from` = now − 3 years.
- `governanceStatus(db: Db, instrumentId: string, now: Date): Promise<{ status: 'CLEAR' | 'EVENT' | 'UNCHECKED'; events: { on: string; kind: GovernanceKind; headline: string }[]; checkedAt: string | null }>`.
  - `UNCHECKED` unless a success run for the instrument has `window_from ≤ completed_at − 3 years + 1 day` and `completed_at ≥ now − 35 days`.
  - `EVENT` if any `news_events` row published within the 3 years before `now` matches `isGovernanceEvent`.

- [ ] **Step 1:** Capture real rows into `tests/fixtures/bse/`:
  - one real BSE row each for an auditor resignation, a credit-rating filing and a litigation item (`fetchBseAnnouncements` for a held or watched scrip);
  - or reuse the rows already there.
  - Record the scrip and date in the fixture's file name. Do not hand-write rows.
- [ ] **Step 2: Write the failing tests.**
  - `isGovernanceEvent` returns `'auditor_resignation'` for the auditor fixture row.
  - It returns `null` for the litigation row and for a rating filing whose headline lacks "downgrade".
  - It returns `'rating_downgrade'` for a rating row whose headline reads "Credit Rating - Downgrade".
  - `governanceStatus` is `UNCHECKED` with no backfill run, and `UNCHECKED` when the only backfill is 36 days old.
  - It is `EVENT` after a backfill that stored an auditor resignation 2 years ago, and `CLEAR` after a successful empty backfill.
  - A failed backfill (`fetchImpl` returns HTTP 500) leaves the status `UNCHECKED` and writes a `failed` run.
- [ ] **Step 3:** Run `pnpm vitest run tests/sources/governance.test.ts`. Expect failures (functions not exported).
- [ ] **Step 4:** Implement.
- [ ] **Step 5: Mutation check.** Drop the 35-day freshness condition; the 36-day test must go red. Restore it.
- [ ] **Step 6:** Run the task tests, `tests/sources`, `tests/architecture` and tsc. Commit with `feat: governance events and three-year BSE backfill`.

---

### Task 2: Screener columns and the five stock checks

**Files:**
- Modify: `src/sources/screener-screen.ts` (`TEXT_ALIAS` and `COLUMN_MAP`).
- Create: `src/domain/stock-checks.ts`.
- Test: `tests/domain/stock-checks.test.ts` and `tests/sources/screener-screen.test.ts`.

**Interfaces:**
- **Consumes:** `governanceStatus` (Task 1), `FINANCE_SECTORS`, `QUALITY`, `BANDS` (`engine.ts`).
- **Produces:**
  - `type CheckStatus = 'PASS' | 'FAIL' | 'UNKNOWN'`.
  - `type CheckName = 'debt' | 'pledge' | 'valuation' | 'growth' | 'management'`.
  - `interface CheckResult { check: CheckName; status: CheckStatus; value: string | null; threshold: string; asOf: string | null; source: string }`. For example: value `'P/E 31.2 vs Chemicals median 24.0 (11 peers)'`, threshold `'≤ 1.5 × sector median'`.
  - `interface StockCheckInput`:

    ```ts
    {
      sector: string | null;
      deRatio: number | null;
      pledgedPct: number | null;
      eps: number | null;
      close: { pricePaise: bigint; asOf: string } | null;
      asOf: string;
      sectorPe: { median: number; peers: number } | null;
      profit5yCagrPct: number | null;
      sales5yCagrPct: number | null;
      cfo5y: number | null;
      pat5y: number | null;
      promoterDropPp: number | null;
      governance: Awaited<ReturnType<typeof governanceStatus>>;
      uploadAsOf: string | null;
    }
    ```

  - `evaluateChecks(i: StockCheckInput): CheckResult[]`. This is pure and always returns five results, in the order debt, pledge, valuation, growth, management.
  - `uploadSectorPe(db: Db, asOf: string): Promise<Map<string, { median: number; peers: number }>>`. It uses the latest upload with `as_of ≤ asOf`, recomputes each P/E as close ÷ EPS, and skips stale closes and EPS ≤ 0.
  - `interface StockChecks { instrumentId: string; name: string; composite: number | null; qualityPassed: boolean; checks: CheckResult[]; passed: boolean }`, where `passed` = quality passed && composite ≥ `BANDS.high` && all five `PASS`.
  - `loadStockChecks(db: Db, asOf: string, now: Date): Promise<StockChecks[]>`. It covers every instrument in the latest `signal_scores` date, sorted by composite descending.
  - `awaitingGovernance(db: Db, asOf: string, now: Date): Promise<string[]>`. These are ids in the HIGH band that passed quality and whose four non-governance checks pass, but whose governance is `UNCHECKED`.

- [ ] **Step 1: Verify against the real source.**
  - Open the owner's latest real export and the latest upload's `fundamentals.data` keys in the local `.pglite`. The real export is the repo root `sentinel2_screener.csv` or a newer one.
  - Today the export carries `EPS 12M Rs.` (already mapped to `EPS`) and `Debt / Eq`. It carries **no** pledged, promoter, cash-from-operations or profit-after-tax column.
  - Add a `TEXT_ALIAS` entry mapping each such header to the canonical keys `'Pledged %'`, `'Promoter Holding'`, `'Promoter Chg 1Y'`, `'CFO 5Y'` and `'PAT 5Y'`, **only for headers seen in a real export**.
  - Known gap: the paste/CSV path strips `" %"`, so a `Pledged %` header lands as `'Pledged'` and misses the HTML path's `'Pledged %'` key (`screener-screen.ts:44` vs `:100`).
  - If the columns are not yet in any real export, add no guessed aliases. The checks then stay `UNKNOWN`, which is correct per spec §4, and Task 11 records the owner input.
  - Also confirm that CFO 5Y and PAT 5Y use the same aggregation (both sums or both averages). If they differ, the ratio is `UNKNOWN`.
- [ ] **Step 2: Write the failing tests for `evaluateChecks`.** Each test changes one field of a "clean" input, in which all five pass.
  - **Debt:**
    - `deRatio: 1` → debt `FAIL`; `0.99` → `PASS`; `null` → `UNKNOWN`.
    - Sector `'Banking'` with `deRatio: null` → `PASS`, with the waiver in `value`.
  - **Pledge:** `pledgedPct: 0.01` → `FAIL`; `0` → `PASS`; `null` → `UNKNOWN`.
  - **Valuation:**
    - close ₹150 and EPS 1 (P/E 150) against median 100 → `PASS` (exactly 1.5×).
    - Median 99 → `FAIL`.
    - `peers: 4` → `UNKNOWN`; `sector: null` → `UNKNOWN`.
    - Close older than 5 days → `UNKNOWN` (Review Focus 1).
    - `eps: -2` → `FAIL`.
  - **Growth:** profit 11.9 → `FAIL`; sales 11.9 → `FAIL`; both 12 → `PASS`; profit `null` with sales 20 → `UNKNOWN`; profit `null` with sales 5 → `FAIL`.
  - **Management:**
    - `cfo5y: 69, pat5y: 100` → `FAIL`; `70/100` → `PASS`.
    - `promoterDropPp: 5.1` → `FAIL`; `5` → `PASS`; `null` → `UNKNOWN`.
    - Governance `EVENT` → `FAIL`; `UNCHECKED` → `UNKNOWN`.
  - **Overall:** `passed` is false when any one check is `UNKNOWN`, even with composite 90.
- [ ] **Step 3: Write the failing PGlite tests.**
  - `uploadSectorPe` uses every same-sector stock in the latest upload, not just the watchlist. Seed 6 upload rows with only 1 on the watchlist, and expect `peers: 6`.
  - `loadStockChecks`:
    - reads the promoter drop as the latest upload's `Promoter Holding` minus that of the latest upload ≥ 365 days earlier;
    - prefers `Promoter Chg 1Y` when that key is present.
  - A screen-paste test: a header verified in Step 1 lands on its canonical key.
- [ ] **Step 4:** Run the tests and confirm they fail.
- [ ] **Step 5:** Implement. Reuse `rawNumber` from `engine.ts` (export it); do not write a second number parser.
- [ ] **Step 6: Mutation checks.**
  - Flip `>` to `>=` in the valuation comparison; the exactly-1.5× test must go red.
  - Treat `UNKNOWN` as a pass in `passed`; the composite-90 test must go red.
- [ ] **Step 7:** Run the task tests, `tests/domain`, `tests/sources` and tsc. Commit with `feat: five fail-closed stock checks`.

---

### Task 3: The stock gate wired in, with the per-stock checks on /advisor

**Files:**
- Modify:
  - `src/domain/sizing-input.ts` (the buys query);
  - `src/jobs/report.ts` (`monthlyAdvice` backfills governance before sizing);
  - `web/lib/data.ts`;
  - `web/app/advisor/page.tsx`;
  - `web/lib/product.ts`.
- Test: `tests/domain/sizing.test.ts`, `tests/jobs/report-advice.test.ts` (create it if absent) and `tests/web/advisor-checks-shape.test.ts`.

**Interfaces:**
- **Consumes:** `loadStockChecks` and `awaitingGovernance` (Task 2), `backfillGovernance` (Task 1).
- **Produces:**
  - **`loadSizingInput`:** `buys` now contains only instruments with `composite ≥ BANDS.high`, `quality_passed`, and `StockChecks.passed`. The query previously used `BANDS.medium` (`sizing-input.ts:58`).
  - **`getStockChecks(): Promise<{ asOf: string | null; rows: StockChecks[] }>`** in `web/lib/data.ts`.

- [ ] **Step 1: Write the failing tests.**
  - **`loadSizingInput` over PGlite:**
    - a HIGH-band stock with a single `FAIL` (pledge 0.5%) is absent from `buys`;
    - a stock at composite 84 with five passes is absent;
    - a stock at composite 86 with five passes and a `CLEAR` governance status is present.
  - **`monthlyAdvice`:**
    - with a stubbed `fetchImpl`, a stock in `awaitingGovernance` gets exactly one backfill run before sizing;
    - a failed backfill leaves it out of the advisor snapshot.
  - **`getStockChecks` (web shape test):** returns five checks per row, each with a non-empty `threshold`; a `null` value stays `null`.
- [ ] **Step 2:** Run them red.
- [ ] **Step 3:** Implement. `monthlyAdvice` takes an optional `fetchImpl` for the backfill; the existing one already exists for the model.
- [ ] **Step 4: Web, on `/advisor`.**
  - **New card, "Stock checks":** one row per scored stock that passed quality.
    - Columns: company, composite with band badge, and the five checks.
    - Each check shows a `Badge` (green PASS / red FAIL / amber UNKNOWN), with the value, the threshold and the as-of date in the cell's dim line.
  - **Summary line:** "N of M pass all five".
  - **When none pass:** a `Notice` reads "No stock passes all five checks this month — that is a correct answer." Missing Screener columns are named when that is the cause.
  - **When no scores exist:** the empty state names `pnpm report` as the job that scores.
  - **Footnote:** "Credit-rating direction is read from the filing headline; the PDF is not parsed."
- [ ] **Step 5: `product.ts` (advisor row).**
  - **works:**
    - "Five fail-closed stock checks with value, threshold and as-of";
    - "Stocks reach the advisor only at composite ≥ 85 with five passes".
  - **missing:**
    - "Pledge, promoter and cash-flow checks need the Screener columns the owner adds" (drop this line once Task 2 Step 1 found them);
    - "Promoter trend unknown until a year of uploads or a 1-year change column";
    - "Rating direction from headline only".
- [ ] **Step 6:** Run the task tests, `tests/domain`, `tests/jobs`, `tests/web`, tsc and the web tsc. Commit with `feat: stock gate in sizing and per-stock checks on /advisor`.

---

### Task 4: Fund types, the range table, the proposal and the actual mix

**Files:**
- Create: `src/domain/fund-mix.ts`.
- Test: `tests/domain/fund-mix.test.ts`.

**Interfaces (Produces):**
- `type FundType = 'NIFTY50' | 'NEXT50' | 'FLEXI' | 'LARGE_ACTIVE' | 'MID' | 'SMALL' | 'US'`, with `FUND_TYPE_LABEL: Record<FundType, string>` copying the spec §7 names.
- `CORE_TYPES = ['NIFTY50', 'NEXT50', 'FLEXI', 'US']` and `NON_CORE_TYPES = ['LARGE_ACTIVE', 'MID', 'SMALL']`.
- `FUND_TYPE_BY_ISIN: Record<string, { type: FundType; topUp: boolean }>`.
- `interface RangeRow { type: FundType; minBps: number; maxBps: number; newMoney: boolean; reason: string }` and `midBps(r) = (minBps + maxBps) / 2`. This is an integer, because every min + max is even in bps.
- `RANGE_TABLE: Record<'15+' | '7-15', RangeRow[]>`. The values are in whole percent; store them ×100 as bps. The reasons are verbatim from spec §7.

  | fund type | 15+ | 7-15 | newMoney |
  |---|---|---|---|
  | NIFTY50 | 35–50 | 50–65 | true |
  | NEXT50 | 0–10 | 0–5 | true |
  | FLEXI | 15–25 | 10–20 | true |
  | LARGE_ACTIVE | 0–0 | 0–0 | **false** |
  | MID | 10–20 | 5–10 | true |
  | SMALL | 5–10 | 0–5 | true |
  | US | 5–10 | 5–10 | true |

- `horizonYears(nowIso: string): number` and `bandFor(years: number): '15+' | '7-15' | null`.
- `proposeMix(nowIso: string): { horizonYears: number; band: '15+' | '7-15'; ranges: RangeRow[] } | { horizonYears: number; band: null; reason: string }`.
- `normalisedMidpointsBps(ranges: RangeRow[]): Record<FundType, number>`. The values sum to exactly 10 000; the remainder goes to NIFTY50.
- `interface ActualMix { totalPaise: bigint; byType: Record<FundType, { valuePaise: bigint; shareBps: number; holdings: { instrumentId: string; name: string; kind: string; valuePaise: bigint; topUp: boolean }[] }>; untyped: { instrumentId: string; name: string; valuePaise: bigint }[] }`.
- `typeOf(db: Db, instrumentId: string): Promise<{ type: FundType; topUp: boolean } | null>`. It resolves the ISIN through the instrument or its canonical sibling.
- `loadActualMix(db: Db): Promise<ActualMix>`.
  - It covers `loadPositions` rows with `assetClass === 'EQUITY'` and kind `MF` or `ETF`. Direct stocks and the RSU are not funds.
  - Its denominator includes untyped funds.
  - A total of zero gives `shareBps` 0, and the page renders "unknown".
- `interface Finding { kind: 'overlap' | 'cost' | 'scheme_cap'; text: string; instrumentId: string | null }`.
- `loadFindings(db: Db): Promise<Finding[]>`:
  - **overlap:** LARGE_ACTIVE held while NIFTY50 is held;
  - **cost:** a held active fund's `expense_ratio_bps` above the median of its AMFI-category universe peers in `mf_metadata` (written by `enrichUniverse`). With fewer than 5 peers, the text says "cost not compared: n peers";
  - **scheme_cap:** a single fund above `CAPS.singleMfScheme` × the `loadPositions` total.

- [ ] **Step 1: Verify the ISINs.**
  - Run a read-only query on the local `.pglite`: `loadPositions` rows of kind MF or ETF in EQUITY, with `isin` and the canonical sibling's `isin`.
  - Fill `FUND_TYPE_BY_ISIN` **from that output only**. The seed ISINs below are the expected subset; confirm each.

    | ISIN | Fund | Type | topUp |
    |---|---|---|---|
    | INF109K012M7 | ICICI Nifty 50 Index | NIFTY50 | true |
    | INF732E01037 | Nifty BeES | NIFTY50 | true |
    | INF879O01027 | PPFC | FLEXI | true |
    | INF109K016L0 | ICICI Large Cap | LARGE_ACTIVE | true |
    | INF179K01XQ0 | HDFC Mid Cap | MID | true |
    | INF247L01445 | Motilal Midcap | MID | true |
    | INF194KB1AL4 | Bandhan Small Cap | SMALL | true |

    LARGE_ACTIVE's `newMoney: false` in the range table already blocks new money, so its `topUp` stays true.
  - Junior BeES (NEXT50) and Vanguard S&P 500 (US) get `topUp: false` with the ISIN read from the DB.
  - If Vanguard S&P 500 exists only inside `US:INDMONEY-BASKET` (a stock basket), it is not a fund: US actual is 0, and the comment says so.
- [ ] **Step 2: Write the failing tests.**
  - **Ranges:**
    - the `15+` table equals the spec values above;
    - every band's sum of minimums ≤ 10 000 ≤ its sum of maximums.
  - **Horizon:**
    - `horizonYears('2026-10-23T…')` is 24;
    - `bandFor(15)` is `'15+'`, `bandFor(14)` is `'7-15'`, and `bandFor(6)` is null.
  - **Normalised midpoints for `15+`:**
    - they sum to 10 000;
    - core (NIFTY50 + NEXT50 + FLEXI + US) is within 1 bp of `10000 × 75 / 97.5` (the spec's "77%"), computed in the test from `RANGE_TABLE`, not typed in;
    - core ≥ 7000.
  - **Actual mix:**
    - over the seed plus a live snapshot holding the same fund as seed `MF:*` and live `IND:*`, the fund is counted once (Review Focus 2);
    - an untyped equity MF appears in `untyped` and is included in `totalPaise`.
  - **Findings:** an `overlap` finding exists when both ICICI Large Cap and the Nifty 50 index fund are held.
  - **Firewall:** `tests/architecture/no-catch-up.test.ts` is unchanged and green.
- [ ] **Step 3:** Run them red.
- [ ] **Step 4:** Implement.
- [ ] **Step 5: Mutation check.** Point `typeOf` at the position id only, ignoring the canonical sibling; the double-count test must go red.
- [ ] **Step 6:** Run the task tests, `tests/domain`, `tests/architecture` and tsc. Commit with `feat: fund types, range table and actual fund mix`.

---

### Task 5: The signed mix (migration 0037), the approve route, and /funds target vs actual

**Files:**
- Create:
  - `migrations/0037_fund_mix.sql`;
  - `web/app/api/funds/route.ts`;
  - `web/app/funds/approve-mix.tsx` (a client button, styled like `ProposeRails` in `web/app/advisor/actions.tsx`).
- Modify:
  - `src/domain/fund-mix.ts`;
  - `web/lib/data.ts`;
  - `web/app/funds/page.tsx`;
  - `web/lib/product.ts`;
  - `tests/db/immutability.test.ts`.
- Test: `tests/domain/fund-mix-signed.test.ts` and `tests/web/funds-mix-shape.test.ts`.

**Migration 0037:**

```sql
create table fund_mix_signed (
  id bigserial primary key,
  horizon_years integer not null check (horizon_years >= 0),
  horizon_band text not null check (horizon_band in ('15+','7-15')),
  ranges jsonb not null,            -- RangeRow[] exactly as proposed
  as_of timestamptz not null,
  source text not null check (source = 'owner-signed')
);
-- append-only triggers (UPDATE/DELETE, TRUNCATE) + enable row level security, no policy
```

**Interfaces:**
- **Consumes:** `proposeMix`, `RangeRow`, `loadActualMix`, `loadFindings` (Task 4).
- **Produces:**
  - `approveMix(db: Db, req: { band: '15+' | '7-15' }, nowIso: string): Promise<{ id: number }>`.
    - It recomputes `proposeMix(nowIso)`.
    - It refuses when there is no proposal, or when `req.band !== proposal.band` ("the proposal changed — reload /funds").
    - It inserts the row and an `audit_log` row (entity `'fund_mix'`, action `'SIGNED'`, payload `{ rowId, band, horizonYears }`) in one transaction.
  - `loadSignedMix(db: Db): Promise<{ id: number; asOf: string; band: '15+' | '7-15'; horizonYears: number; ranges: RangeRow[] } | null>`.
  - `newProposalReady(signed, proposal, nowIso): boolean`. True when the bands differ, or when the signed row is 365 days old or more.
  - `getFundMix(): Promise<{ proposal: ReturnType<typeof proposeMix>; signed: … | null; newProposal: boolean; actual: ActualMix; findings: Finding[] }>` in `web/lib/data.ts`.
  - `POST /api/funds { action: 'approve', band }` returns `{ ok, message }` or a 409 with the domain error. The middleware authenticates it.

- [ ] **Step 1: Write the failing tests.**
  - **Table:**
    - the new table refuses UPDATE, DELETE and TRUNCATE;
    - the `pg_policies` count is still 0.
  - **Signing:**
    - `approveMix` writes the proposal's ranges verbatim, plus one audit row;
    - a mismatched band is refused;
    - two signings mean `loadSignedMix` returns the later one.
  - **Review Focus 4:** sign at `nowIso = '2026-10-23T…'`, then evaluate at `'2036-01-15T…'`. That is 14 years to 2050, so the band is `'7-15'`. `newProposalReady` is true, and `loadSignedMix` still returns the `15+` row.
  - **Web shape:** with no signed row, every target is `null`, never 0.
- [ ] **Step 2:** Run them red.
- [ ] **Step 3:** Implement the migration, the domain functions, the route and the getter.
- [ ] **Step 4: Web, on `/funds`.** Place these cards above "Ranking"; do not restyle the existing cards.
  - **"Fund mix: target vs actual":** one row per `FundType`.
    - Columns: type, target range (or a dim "not set — approve the proposal below"), actual % (or "unknown" when the total is 0), held value with `<Money>`, and status `Badge`. The status is below midpoint, in range, above range, or "0% new money".
    - The untyped funds follow as "type unknown".
  - **"Proposal":**
    - the horizon ("equity serves FI, ~2050, 24 years");
    - the range table with each reason;
    - the findings list;
    - the approve button, with a `Notice` when `newProposal` is true ("the signed ranges stay in force until you sign this one");
    - when the band is null, the proposal's `reason` in a `Notice`.
- [ ] **Step 5: `product.ts` (funds row).**
  - **works:** "Fund mix proposal with reasons and findings", "Owner approval stored append-only", "Target vs actual per fund type".
  - **missing:** "Cost finding needs universe peers' expense ratios (`pnpm mf:universe`)".
- [ ] **Step 6: Mutation check.** Remove the band-mismatch guard; its test must go red.
- [ ] **Step 7:** Run the task tests, `tests/db`, `tests/web`, tsc and the web tsc. Commit with `feat: owner-signed fund mix on /funds`.

---

### Task 6: IPS §3.4 amended to 70/30

**Files:**
- Modify:
  - `PRD_investment_agent.md:149-151`;
  - `src/config/ips-v1.ts:25-27`;
  - `src/domain/allocation.ts:190-226` (`SATELLITE_CAP_PCT` becomes 30, and `satelliteFit` also counts non-core typed funds);
  - `src/domain/alloc-engine.ts:136` (comment);
  - `tests/domain/satellite-fit.test.ts`;
  - `tests/domain/ips-install.test.ts`.

**Exact clause text.** It is identical in the PRD and in `ips-v1.ts`.

```
## 3.4 Equity structure: core–satellite 70/30
- **Core (≥70% of equity flows):** index instruments (Nifty 50, Nifty Next 50, flexi-cap of PPFC type, US index exposure) — consolidate into the existing ICICI Nifty 50 Index folios and BeES ETFs.
- **Non-core (≤30% of equity):** mid-cap, small-cap and active large-cap funds, and agent-recommended direct stocks, each stock with a ≤150-word written thesis containing an explicit falsification condition. Stocks operate on the curated watchlist (Section 8). Amended 2026-10-23 by the owner: "i dont need stocks unless they are very good".
```

**Interfaces:**
- **Consumes:** `FUND_TYPE_BY_ISIN` and `NON_CORE_TYPES` (Task 4).
- **Produces:** `satelliteFit(positions: Position[], nonCoreFundIds?: ReadonlySet<string>)`.
  - Headroom = 30% of equity − (direct stocks + positions in `nonCoreFundIds`).
  - The caller in `src/notify/report.ts:199` passes the set it builds with `typeOf`.

- [ ] **Step 1: Write the failing tests.**
  - **Headroom:** with equity ₹10L and direct stocks ₹1.5L, headroom is ₹1.5L (30% cap). Adding a ₹1L MID fund in `nonCoreFundIds` gives ₹0.5L.
  - **Install:** `installIps` on a DB whose tip is the 75/25 text writes a new version whose `ipsClause(…, '3.4')` contains `≥70% of equity flows`. A second call writes nothing.
  - **Verbatim:** the existing `ips-verbatim` test stays green, which proves the PRD and the module match.
- [ ] **Step 2:** Run them red.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `rg -n "75/25|≥75%|25% of equity|SATELLITE_CAP_PCT = 25" src web/app web/lib tests` and confirm that only historical comments or ledgers remain.
- [ ] **Step 5:** Run `tests/domain`, `tests/notify`, tsc and the web tsc. Commit with `feat: IPS 3.4 amended to core ≥ 70% (owner, 2026-10-23)`.

---

### Task 7: Fund candidates and the funds-first sizer

**Files:**
- Modify:
  - `src/domain/fund-mix.ts`;
  - `src/domain/sizing.ts`;
  - `src/domain/sizing-input.ts`;
  - `web/lib/data.ts`;
  - `web/app/advisor/page.tsx`;
  - `web/lib/product.ts`.
- Test: `tests/domain/fund-candidates.test.ts`, `tests/domain/sizing.test.ts` and `tests/web/advisor-funds-shape.test.ts`.

**Interfaces:**
- **Consumes:** `loadSignedMix`, `loadActualMix`, `typeOf` (Tasks 4–5), `evaluateSwitches` (`mf-switch.ts`), `CAPS.singleMfScheme`.
- **Produces:**
  - `interface FundBuy { instrumentId: string; name: string; kind: string; fundType: FundType; gapBps: number; heldPaise: bigint; quality: string }`. `quality` is, for example, `'rank 2 of 11 in Equity Scheme - Mid Cap Fund'` or `'index fund — exempt'`.
  - `interface FundCandidates { approved: boolean; buys: FundBuy[]; typesBelowMidpoint: FundType[]; excluded: { instrumentId: string; name: string; reason: string }[] }`.
  - `loadFundCandidates(db: Db, asOf: string): Promise<FundCandidates>`.
    - `typesBelowMidpoint` covers every type with an approved range and `newMoney`, where actual < midpoint. That includes a type with no holding.
    - `excluded` reasons:
      - "type unknown";
      - "0% new money";
      - "kept, not topped up";
      - "at or above midpoint (x% vs y%)";
      - "flagged for a switch to <name>";
      - "rank a of n — not in the top half";
      - "no category cohort on record".
  - `SizingInput` gains these fields:

    ```ts
    funds: FundCandidates;
    singleSchemeCapPct: number; // 35
    ```

  - `Candidate` gains these fields:

    ```ts
    vehicle: 'FUND' | 'STOCK';
    fund: {
      fundType: FundType;
      actualBps: number;
      midBps: number;
      quality: string;
    } | null;
    ```

  - **`vehicle` values:**
    - on BUY candidates, it comes from where the candidate originated;
    - on SELL and TRIM candidates, it is `FUND` for MF and ETF kinds and `STOCK` otherwise.
  - **`sizeCandidates` order:**
    - fund buys are sized first, ordered by `gapBps` descending, then `heldPaise` descending, then `instrumentId`;
    - a fund whose `heldPaise + tranche` exceeds the 35% scheme cap is withheld with "would take it above the 35% single-scheme cap (IPS §3.5)", and the next fund is tried;
    - the first eligible fund consumes the month's single tranche.
    - **Stocks:**
      - If `!funds.approved`, every stock BUY is withheld with "no approved fund mix yet — approve it on /funds".
      - Otherwise, if `typesBelowMidpoint` is non-empty, it is withheld with "not this month — a fund is below target (<labels>)".
      - Otherwise today's logic applies.
  - `getFundCandidates(): Promise<FundCandidates>` in `web/lib/data.ts`.

- [ ] **Step 1: Write the failing tests for `loadFundCandidates` (PGlite).**
  - With no signed mix, `approved` is false and `buys` is empty.
  - With a signed `15+` mix:
    - a MID fund below its midpoint is a candidate;
    - ICICI Large Cap (LARGE_ACTIVE) is excluded as "0% new money";
    - an active fund with a stubbed switch challenger is excluded;
    - an active fund ranked 7 of 11 is excluded;
    - the index fund is a candidate whatever its rank;
    - Junior BeES is excluded as "kept, not topped up";
    - an untyped fund is excluded as "type unknown".
- [ ] **Step 2: Write the failing tests for the pure `sizeCandidates`.**
  - **Ordering and one tranche:** two funds with gaps of 2 000 and 500 bps mean the 2 000 one is ELIGIBLE with the full tranche and the other is WITHHELD ("already used").
  - **Scheme cap:** a fund at 34% of the portfolio, where the tranche would take it past 35%, is withheld with the cap reason, and the next fund is ELIGIBLE.
  - **Stocks behind funds:** with funds below midpoint, a passing stock is WITHHELD with "not this month — a fund is below target". With `typesBelowMidpoint: []`, it is sized.
  - **Unsigned mix:** with `approved: false`, the stock is withheld with "no approved fund mix yet".
  - **Review Focus 5:**
    - `cashAvailablePaise: null` withholds the fund with "cash available cannot be established";
    - `envelopeReason` set with a budget of 0 withholds it with that reason.
  - **No sale:** every candidate produced from `funds.buys` has `action === 'BUY'`.
- [ ] **Step 3:** Run them red.
- [ ] **Step 4:** Implement. `loadSizingInput` calls `loadFundCandidates(db, asOf)` and reads `CAPS.singleMfScheme * 100` for `singleSchemeCapPct`.
- [ ] **Step 5: Web, on `/advisor`.**
  - Add a "Fund candidates this month" card **before** the stock checks card.
    - It lists the candidates, each with type, gap, quality and position.
    - It lists the excluded funds with reasons in a `<details>`.
  - When the mix is unsigned, it shows a `Notice`: "no approved fund mix yet — approve it on /funds", linking to `/funds`.
  - Update the advisor `PageHead` sub: funds come first, and a stock is the exception.
- [ ] **Step 6: Mutation checks.**
  - Remove the stock withhold when funds are below midpoint; the "stocks behind funds" test must go red.
  - Clamp to the cap instead of withholding; the scheme-cap test must go red.
- [ ] **Step 7:** Run `tests/domain`, `tests/web`, `tests/architecture`, tsc and the web tsc. Commit with `feat: funds before stocks in the monthly sizer`.

---

### Task 8: Advisor `advise-v3`: funds first, no news rule for funds, required `whyNotFund`

**Files:**
- Modify:
  - `src/advisor/recommend.ts`;
  - `src/domain/advisor-handoff.ts` (only if signing a fund BUY fails the test below);
  - `web/app/advisor/page.tsx` (render `whyNotFund`).
- Test: `tests/advisor/recommend.test.ts` and `tests/domain/advisor-handoff.test.ts`.

**Interfaces:**
- **Consumes:** `Candidate.vehicle` and `Candidate.fund` (Task 7).
- **Produces:**
  - `ADVISE_PROMPT_VERSION = 'advise-v3'` and `ADVISE_SCHEMA_VERSION = 'advise-schema-v2'`.
  - **`CandidateContext`:** gains `vehicle` and `fund: { fundType, targetRange, actualPct, quality } | null`.
  - **Fund context:** fund candidates skip `contextFor`'s news-coverage exclusion and get `signal: null` and `news: []`.
  - **Order:** `shown` is ordered funds first.
  - **`ModelDecision`:** gains `whyNotFund: string | null`.
  - **`validateDecision` rule:** it throws `'a stock BUY must say why not a fund (whyNotFund)'` when `decision === 'BUY'`, the chosen candidate is a `STOCK`, and `whyNotFund` is missing or blank.
  - **Stored payload:** a stock BUY's payload includes `whyNotFund`.
  - **Prompt:**
    - it adds the lines "Funds come first: a FUND candidate is preferred; a stock is the exception." and "A stock BUY must also return \"whyNotFund\": why this stock and not a fund this month.";
    - it adds `"whyNotFund":"<required for a stock BUY>"` to the reply schema;
    - all other rules are unchanged.

- [ ] **Step 1: Write the failing tests.**
  - **Prompt version:** the existing test `the prompt tells the model the budget is context, and the version is advise-v2` becomes `…advise-v3` and asserts `prompt_version === 'advise-v3'`.
  - **No `whyNotFund`:** a stock BUY reply without it gives `UNAVAILABLE` after two attempts, and both `llm_calls` rows read `invalid`.
  - **With `whyNotFund`:** the same reply carrying it gives BUY, with `whyNotFund` in the payload.
  - **Fund BUY:** a fund BUY without `whyNotFund` is accepted.
  - **News rule:** a fund candidate with news coverage `missing` is shown to the model and not listed in `excluded`. A stock with coverage `missing` is still excluded.
  - **Order:** in the snapshot's `shown` array, the fund comes before the stock.
  - **Handoff:** `signAdvice` on a fund BUY proposal creates an approval request for an amount-based MF order. Re-sizing must find the same candidate id.
- [ ] **Step 2:** Run them red.
- [ ] **Step 3:** Implement.
- [ ] **Step 4: Mutation check.** Drop the `whyNotFund` guard; the missing-`whyNotFund` test must go red.
- [ ] **Step 5: Web.** In the advice card, a stock BUY shows a "Why not a fund" block under "Why".
- [ ] **Step 6:** Run `tests/advisor`, `tests/domain`, tsc and the web tsc. Commit with `feat: advise-v3 — funds first, whyNotFund on stock buys`.

---

### Task 9: Suggested SIP amounts

**Files:**
- Modify:
  - `src/domain/fund-mix.ts`;
  - `web/lib/data.ts`;
  - `web/app/funds/page.tsx`;
  - `web/lib/product.ts`.
- Test: `tests/domain/sip-suggest.test.ts` and `tests/web/funds-sips-shape.test.ts`.

**Interfaces:**
- **Consumes:**
  - `loadSignedMix`, `loadActualMix`, `typeOf`, `normalisedMidpointsBps`, `NON_CORE_TYPES` (Tasks 4–5);
  - `loadSipCommitment`, `loadFreeEnvelope` (`src/domain/sips.ts`).
- **Produces:**
  - `interface SipSuggestion { fundType: FundType | null; instrumentId: string | null; fundName: string; currentPaise: bigint; suggestedPaise: bigint; reason: string }`.
    - `instrumentId: null` with `fundName: 'new index fund — see below'` marks a type with no held fund.
  - `suggestSips(i: { sips: { instrumentId: string; fundName: string; type: FundType | null; topUp: boolean; amountPaise: bigint }[]; ranges: RangeRow[]; actualBps: Record<FundType, number>; heldByType: Record<FundType, { instrumentId: string; name: string; valuePaise: bigint; topUp: boolean }[]> }): SipSuggestion[]`. This is pure and follows Decision 10.
  - `getSipSuggestions(): Promise<{ rows: SipSuggestion[]; totalPaise: bigint } | { rows: null; reason: string }>`.
    - It returns null when no mix is signed ("approve the fund mix first").
    - It returns null when `loadSipCommitment().totalPaise` is null; the reason is the envelope's reason (Review Focus 3).

- [ ] **Step 1: Write the failing tests for the pure `suggestSips`.**
  - **Total kept:** given the live fixture SIPs (`tests/fixtures/indmoney-mf-sips-2026-10-14.json`), the suggested amounts sum to exactly the typed SIP total.
  - **Rounding:** every row except the NIFTY50 anchor is a multiple of 10 000 paise.
  - **No negatives:** every `suggestedPaise ≥ 0n`.
  - **Large cap:** a LARGE_ACTIVE SIP is suggested at `0n`, with the reason "0% new money — held, never topped up".
  - **Non-core cap:**
    - **Inputs:**
      - actual MID 0, SMALL 0, NIFTY50 5 800, FLEXI 1 400 and US 0 (in bps);
      - the `15+` ranges;
      - suggestions with non-core above 30% before the cap.
    - **Expected:** the MID + SMALL + LARGE_ACTIVE share of the suggested total is ≤ 3 000 bps, allowing ₹100 rounding of one row.
  - **No tilt:** with actual equal to the midpoints, each type's share equals `normalisedMidpointsBps` within ₹100 per row.
  - **Untyped SIPs:** an untyped SIP keeps its amount unchanged.
  - **No held fund:** a type with no held fund (US) yields one row with `instrumentId: null`.
- [ ] **Step 2: Write the failing tests for `getSipSuggestions`.**
  - With a stale SIP snapshot (older than `SIP_MAX_AGE_DAYS`), it returns `rows: null` with the envelope's reason, never zeros.
  - With no signed mix, it returns `rows: null`.
- [ ] **Step 3:** Run them red.
- [ ] **Step 4:** Implement.
- [ ] **Step 5: Web, on `/funds`.** Add a "Suggested SIPs" card under the proposal.
  - **Columns:** fund, type, current → suggested (with `<Money>`), and reason.
  - **Footer:** "Total unchanged at ₹X. Each amount is rounded down to a whole ₹100; the remainder goes to the Nifty 50 index fund. Change SIPs in INDmoney; the next sync shows them here."
  - **When there are no suggestions:** a `Notice` with the reason.
- [ ] **Step 6: `product.ts` (funds row).** Add "Suggested SIPs keep the total and never sell" to works.
- [ ] **Step 7: Mutation checks.**
  - Drop the non-core cap; the non-core test must go red.
  - Drop the remainder-to-anchor step; the total-kept test must go red.
- [ ] **Step 8:** Run `tests/domain`, `tests/web`, tsc and the web tsc. Commit with `feat: suggested SIP amounts toward the approved mix`.

---

### Task 10: Choosing the new index fund (US index, Nifty Next 50)

**Files:**
- Create:
  - `migrations/0038_index_fund_candidates.sql`;
  - `src/sources/index-funds.ts`.
- Modify:
  - `src/jobs/sync.ts`, after the MF metadata block. As with that block, a failure here must not fail the sync.
  - `src/domain/fund-mix.ts`;
  - `web/lib/data.ts`;
  - `web/app/funds/page.tsx`;
  - `web/lib/product.ts`;
  - `tests/db/immutability.test.ts`.
- Test: `tests/sources/index-funds.test.ts`, using a captured fixture in `tests/fixtures/indmoney-index-funds-<date>.json`.

**Migration 0038:**

```sql
create table index_fund_candidates (
  id bigserial primary key,
  fund_type text not null check (fund_type in ('US','NEXT50')),
  indmoney_fund_id text not null,
  name text not null,
  benchmark_name text,
  amfi_scheme_code text,            -- null = plan not verified as Direct Growth
  expense_ratio_bps integer,
  aum_paise bigint,
  tracking_error_bps integer,       -- null when no source carries it
  sip_allowed boolean,              -- null = source silent
  as_of date not null,
  source text not null check (source <> ''),
  unique (indmoney_fund_id, as_of)
);
-- append-only triggers + RLS on, no policy
```

**Interfaces:**
- **Consumes:** `McpClient`, `resolvePeerToAmfi`, `isDirectGrowth`, `parseAumCrore`, `expensePctToBps`, `aumCroreToPaise`.
- **Produces:**
  - `recordIndexFundCandidates(db: Db, client: McpClient, asOf: string): Promise<{ stored: number }>`. It reads INDmoney slugs `nifty-next-50-index-funds` and `global-index-funds` (paged as in `fetchAllInCategory`), and then `get_mf_funds_details` for each fund's `benchmark_name`.
  - `interface IndexFundChoice { fundType: 'US' | 'NEXT50'; top: IndexFundRow | null; alternatives: IndexFundRow[]; notProposed: { row: IndexFundRow; why: string }[]; trackingErrorAvailable: boolean; reason: string | null }`.
  - `chooseIndexFund(rows: IndexFundRow[], fundType: 'US' | 'NEXT50'): IndexFundChoice`. This is pure.
    - **Eligible:** the benchmark matches (`/nifty next 50/i`, or `/s&p 500|nasdaq[- ]?100/i` for US), there is an `amfi_scheme_code`, and `sip_allowed === true`.
    - **Ranking:** expense ratio ascending, then tracking error ascending (skipped when no row has one), then AUM descending.
    - **Not proposed:** a row missing a value the ranking uses goes to `notProposed`.
    - **None open:** if no fund is eligible, `reason` is "no eligible fund is open to SIPs (RBI overseas limit)" for US, or the generic equivalent.
  - `getIndexFundChoices(): Promise<{ asOf: string | null; choices: IndexFundChoice[] }>`. It uses the latest `as_of` rows.
  - **Hook into Task 9:** a `SipSuggestion` row with `instrumentId: null` takes its `fundName` from `choice.top?.name ?? 'no eligible fund open — see below'`.

- [ ] **Step 1: Verify against the real source.**
  - Call `get_mf_by_category` for both slugs and `get_mf_funds_details` (baseline and `includes: ['fund_performance']`) for two funds. Save the raw payloads as the test fixture.
  - Record which field, if any, carries tracking error. If none does, `tracking_error_bps` stays null and the page says "tracking error unavailable from INDmoney".
  - Confirm that `sip_allowed` is present. On 2026-10-23 it was present, and false for the top 3 global index funds.
- [ ] **Step 2: Write the failing tests.**
  - **US fixture:** with every US fund at `sip_allowed: false`, `top` is null and `reason` names the closure.
  - **Next 50 ranking:** the lowest-expense eligible fund is `top`, and two alternatives follow in rank order.
  - **Incomplete rows:** a row without AUM is in `notProposed`.
  - **Unverified plan:** a row with no AMFI scheme code is not proposed, with the reason "plan not verified as Direct Growth".
  - **Stored rows:** `recordIndexFundCandidates` stores rows with `as_of`, and `source = 'indmoney-mcp'`.
  - **Table:** the new table refuses UPDATE, DELETE and TRUNCATE.
- [ ] **Step 3:** Run them red.
- [ ] **Step 4:** Implement, then wire `recordIndexFundCandidates` into `sync.ts` inside its own try/catch, logged like the metadata block.
- [ ] **Step 5: Web, on `/funds`.** Add a "New index fund" card for each of US and Nifty Next 50.
  - **Each card shows:**
    - the top choice and two alternatives, with expense ratio, tracking error (or "unavailable"), AUM, source and as-of;
    - the not-proposed rows with their reason;
    - the line: "Open it in INDmoney as a Direct Growth SIP; once the sync sees it, it is a held fund like any other."
  - **Empty state:** "No candidates on record — they are read by the daily `pnpm sync`."
- [ ] **Step 6: `product.ts` (funds row).**
  - **works:** "New index fund proposal for US and Nifty Next 50, ranked on cost, tracking error and size".
  - **missing:** "Tracking error has no source" (only if Step 1 found none).
- [ ] **Step 7: Mutation check.** Drop the `sip_allowed === true` condition; the US closed-fund test must go red.
- [ ] **Step 8:** Run `tests/sources`, `tests/db`, `tests/web`, tsc and the web tsc. Commit with `feat: propose the new US and Next 50 index funds`.

---

### Task 11: Docs: MEMORY, PENDING, ledger, index

**Files:**
- Modify:
  - `MEMORY.md`;
  - `PENDING.md`;
  - `.superpowers/sdd/2026-08-12-sentinel-phase-0/progress.md`;
  - `index.md`.

- [ ] **Step 1: `MEMORY.md`, under "Owner decisions".** Add the entry "Funds first (2026-10-13, amended 2026-10-23)", with one line each for:
  - funds take priority;
  - no watchlist sign-off;
  - five checks, where any failure is a no and unknown is a failure;
  - composite ≥ 85;
  - held funds topped up only;
  - IPS §3.4 at 70/30;
  - funds before stocks in a month;
  - the owner approves the ranges;
  - suggested SIPs;
  - the owner opens new index MFs.
- [ ] **Step 2: `MEMORY.md` Contracts.** Add "Funds-first contracts":
  - `evaluateChecks` and `loadStockChecks`, with P/E recomputed on read;
  - `governanceStatus`, with its 35-day validity and the headline-only rating direction;
  - `fund_mix_signed`, where the latest row is in force;
  - `loadFundCandidates`, and the `Candidate.vehicle` and `Candidate.fund` fields;
  - `advise-v3` with `whyNotFund`;
  - the `suggestSips` rule (tilt, 30% non-core cap, floor to ₹100 with the remainder to Nifty 50);
  - `index_fund_candidates`.
- [ ] **Step 3: `MEMORY.md` owner true-up items.** Add:
  - add the Screener columns (Pledged percentage, Promoter holding, cash from operations 5y, profit after tax 5y; a 1-year promoter-change column if offered), and send one export so the aliases are verified;
  - the rating-direction judgment call (headline only);
  - Vanguard S&P 500 and Junior BeES ISINs, if Task 4 Step 1 could not find them;
  - US index funds closed to SIPs as of 2026-10-23.
  
  Strike the "Satellite stays inside IPS §3.4's 25%" line at the 2026-09-27 entry, and point it to the amendment.
- [ ] **Step 4: `PENDING.md`.**
  - Tick piece 3, then point the next item to batch B.
  - Add these open items:
    - the owner signs the mix on `/funds`;
    - the owner adds the Screener columns;
    - the owner opens the Next 50 index fund (and the US one when one is open);
    - apply migrations 0037 and 0038 to prod.
- [ ] **Step 5: `progress.md`.** Add a ledger line: "Funds first (2026-10-23): 10 tasks + docs; stock gate, fund mix, funds-first sizer, advise-v3, SIP suggestions, index fund chooser; N tests; mutation-checked; migrations 0037–0038".
- [ ] **Step 6: `index.md`.** Add the new files and their exports:
  - `src/domain/stock-checks.ts`;
  - `src/domain/fund-mix.ts`;
  - `src/sources/index-funds.ts`;
  - the new exports in `src/sources/news.ts`;
  - `web/app/api/funds/route.ts`;
  - `web/app/funds/approve-mix.tsx`;
  - migrations 0037 and 0038.
- [ ] **Step 7:** Run the full suite once with `pnpm vitest run`, then tsc for root and web. Commit with `docs: funds-first ledger, contracts and owner inputs`.
