# Sentinel Phase 1 ("Think") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Reference code is deliberately sparse here.** Phase 0's plan snippets shipped real defects (Tasks 2, 3, 5, 6 — one failed its own acceptance criterion). Interfaces and acceptance criteria below are the contract; derive numbers from real data structures, mutation-check guard-rail tests, and adjudicate a contradiction on the merits rather than defending this document.

**Goal:** Deliver a weekly Telegram deep report containing **≥1 fully-formed paper recommendation** — primary + exactly two alternates, each with thesis (≤150 words), key risk, expected holding period, falsification condition, conviction+stated basis, strongest argument against, and ≥1 IPS v1 clause citation (FR-10, FR-11) — produced by the PRD §6 signal/allocation/sell engine over fresh NSE bhavcopy prices, AMFI NAVs, and the owner's quarterly screener.in CSVs. **Phase 1 DoD (§14):** the first weekly report has such a recommendation with every data timestamp shown, AND a deliberately stale price provably blocks a recommendation (badge reason visible, engine output changes).

**Architecture:** Extends the Phase 0 single TypeScript package. New free-source adapters (NSE EQ bhavcopy, NSE index series for relative strength, AMFI daily + historical NAV, screener.in CSV) implement the same `Source` contract — every row carries `as_of` + `source`. The **staleness engine is the choke point, not the adapters**: freshness policy extends to prices (24h trading days), NAVs (48h), fundamentals (1 quarter); violations put instruments in `blockedInstruments` (existing FR-31 feed) which the signal engine filters. Domain modules (engine, alloc-engine, sell-triggers, maturities, recommendations, scoring) are pure, deterministic, money-free-of-floats, and produce candidate objects; the only LLM step is **narration** (PRD 6.7) via OpenRouter (owner decision 2026-09-05) — the LLM never originates a number or a rank. Recommendations persist append-only and are scored post-hoc against the §13 calibration shell. Jobs are stateless `tsx` scripts invoked by GitHub Actions; schedules per §12.2 (EOD sync, Sunday weekly).

**Tech Stack:** TypeScript 5.x on Node 22, pnpm, vitest, `tsx`, raw SQL migrations, `@electric-sql/pglite` + `postgres`, Telegram Bot API over `fetch`, OpenRouter Chat Completions over `fetch`.

## Global Constraints

Inherited from Phase 0 (all hold): sole user; money never float (`BIGINT` paise / `nav_micros` = NAV×1e6); absent code paths not toggles; append-only audit + RLS; unknown cost is NULL and renders `—`, never ₹0; staleness is loud; `funded_status` unreadable by any sizing/risk code (architecture test enforces; sizing is Phase 2 anyway); planning assumptions in `src/config/assumptions.ts`; IST business dates; `'YYYY-MM-DD'` date strings in domain signatures.

Phase 1 adds:

- **FR-10:** recommendation objects are produced **only** by the §6 engine; every one cites ≥1 IPS v1 clause id (e.g. `3.3`) from `src/config/ips-v1.md` via the existing `ipsClause` extractor. A paraphrase that drifts from IPS v1 at a −20% drawdown is a product failure.
- **FR-11 payload is a stored contract:** primary + exactly 2 alternates; each carries `thesis` (≤150 words, counted), `key_risk`, `holding_period`, `falsification_condition`, `conviction` (LOW/MEDIUM/HIGH) `conviction_basis`, `strongest_counter`. Stored verbatim in the append-only `recommendations` table.
- **6.7 LLM boundary:** narration restates engine outputs and adds reasoning prose; it cannot invent, adjust, or re-rank numbers. Enforced by construction — narration receives serialized candidates, returns text, writes nothing back into scores/ranks.
- **Stale = blocked, visibly (FR-31):** freshness policy prices 24h trading days, NAVs 48h, fundamentals 1 quarter (portfolio 36h, FX 48h unchanged). Blocked instruments are excluded from the engine AND listed in the weekly report with their reason.
- **Watchlist is advisor-owned** (owner decision 2026-09-05). Owner curates only at setup; the quarterly revision is an advisor *proposal* (adds from screening, removals for failed quality gate / red flag / sustained underperformance) surfaced in the weekly report for owner sign-off. Every change recorded in `watchlist` (added_on/removed_on, source, reason).
- **Paper mode (FR-55) is the normal Phase 1 state.** `settings_rails.paper_mode` is true; pipeline fully runs, recommendations logged and scored, execution structurally impossible. Suppressed actions are logged and *reported*, never dropped.
- **Maturity events are Phase 1 citizens** (owner decision 2026-09-05): Sammaan INE148I07GL3 (26-Sep-2026) → redemption-to-cash + IPS bucket routing recommendation; 14-day alert in the daily digest.
- **Money-vs-scores separation:** currency is always BIGINT integers; composite scores are unitless [0,100] floats and never combined with a currency value. A `number` holding a currency amount is a bug; a float score is fine.

## Scope Calls (deviations from a literal PRD reading — flagged deliberately)

1. **Weekly-review LLM channel is OpenRouter, not the Anthropic API** (owner decision 2026-09-05). PRD §12.1 names Opus-class via Anthropic at ₹1.5–3k/mo; OpenRouter hosts same-class models behind the existing key. Model id is env-driven (`WEEKLY_LLM_MODEL`, default `anthropic/claude-sonnet-4-5`), verified at build. The deterministic engine is unaffected either way.
2. **Recommendations are paper-format from day one.** Approvals/orders are Phase 2/3; Phase 1's `recommendations` table *is* the paper record and the weekly report is the delivery surface (matches the DoD). No approval machinery this phase.
3. **Legacy cleanup queue (FR-14 / IPS §3.9) stays Phase 2** (owner decision). Phase 1's sell engine references it as a future input; sell trigger 6 is a documented no-op stub, not a dormant feature.
4. **Sammaan maturity is handled now** as Task 1 (time-boxed) and as a standing recommendation source (`maturity_routing`) in the engine.
5. **Scoring harness ships as data model + calendar shell** (§13): `benchmark_at_creation` is real; 3/6/12-month snapshots are produced by a scheduled job once their eval dates arrive (none will have by DoD). The calibration section in the weekly report starts as "insufficient data not yet available", not a fabricated hit-rate.
6. **Weekly cadence aligns to PRD §12.2 (Sunday 10:00 IST).** Current `weekly.yml` runs Sat 08:00. Owner sign-off required; the same step re-derives the *stale* `workflow-schedule` test decision and reports it back rather than silently fixing it.
7. **Held instruments never enter the satellite engine's BUY set** (§6.1: recommendations concern non-held names and MF switches). Holdings appear only in sell-triggers and alloc-engine.
8. **A local preview UI is added to Phase 1** (owner decision 2026-09-05, port **8081**). The PRD's real Next.js product UI stays Phase 2; Phase 1 ships a tiny `tsx` + `node:http` server — `pnpm ui` on `127.0.0.1:8081` — that renders the weekly-report sections as styled HTML from the same pure composition functions the Telegram reporter uses, reading the real local PGlite DB. v1.0 renders today's real data (net worth, drift, staleness, holdings) plus clearly-badged placeholders; sections light up as Tasks 3–12 land. The server is read-only (no mutate path imported) and is a throwaway preview shell — the content functions carry unchanged into Phase 2's Next.js app.

## File Structure (additions to Phase 0)

```
migrations/0007_phase1_quotes.sql   prices_eod, index_prices_eod, navs, holidays + triggers/indexes
migrations/0008_phase1_intel.sql    watchlist, screener_uploads, fundamentals,
                                    signal_scores, recommendations, suppressed_actions,
                                    benchmark + triggers/Rls
src/sources/bhavcopy.ts             NSE EQ bhavcopy + index bhavcopy download/parse
src/sources/amfi.ts                 AMFI daily NAV + historical NAV per scheme
src/sources/screener.ts             screener.in CSV → fundamentals (versioned upload)
src/sources/llm-narration.ts        OpenRouter narrative step (mocked in tests)
src/domain/engine.ts                §6 satellite composite [0,100] + MF ranking
src/domain/alloc-engine.ts          §6.4 drift-direction + tax-aware rebalance rec (FR-13)
src/domain/sell-triggers.ts         §6.5 monthly exit evaluation (FR-15)
src/domain/maturities.ts            bond redemption events + 14-day alerts
src/domain/recommendations.ts       FR-11 builders, alternates (§6.6), FR-12 caps, suppressions
src/domain/scoring.ts               §13 benchmark-at-creation + eval snapshots
src/notify/report.ts                weekly deep report composition (FR-51)
src/ui/render.ts                    pure report→HTML renderer (shared by the preview server)
src/ui/server.ts                    `pnpm ui` node:http server on 127.0.0.1:8081 (read-only)
src/jobs/report.ts                  `pnpm report` (weekly) entrypoint
src/jobs/screener-import.ts         `pnpm screener:import <csv>`
src/seed/seed-watchlist.ts          advisor starter watchlist (~40 names)
src/seed/seed-holidays.ts           NSE trading calendar seeding (2026, then yearly)
tests/…                             mirrors src; fixtures/ bhavcopy (zip→csv), index csv,
                                    amfi (zip→csv), screener.csv, matured-bond state
.github/workflows/{weekly,sync}.yml schedule additions / re-derivation
.env.example                        + OPENROUTER_MODEL (+ reuse OPENROUTER_API_KEY)
```

---

### Task 1: Sammaan bond maturity — model, route, alert (time-boxed first)

**Why first:** INE148I07GL3 matures **26-Sep-2026** (~3 weeks out); Phase 2's legacy cleanup is out of scope, so this lands here. Deliverable is complete and reviewable before the event.

**Files:**
- Create: `src/domain/maturities.ts`, `tests/domain/maturities.test.ts`
- Edit: `src/seed/seed-data.ts` (if any bond lacks `maturity_date`), `src/notify/digest.ts` (14-day maturity alert block), `tests/notify/digest.test.ts`

**Interfaces:**
- Consumes: `Db` (instruments), `src/domain/ips.ts`, `src/domain/surplus.ts`, `src/money/paise.ts`.
- Produces: `listRedemptionsUntil(db, horizonDays)` → `{ instrument_id, symbol, isin, maturity_date, face_paise, coupon_due_paise?, days_until }`; `maturityRoutingRec(redemption, state)` → paper routing object `{ intent, action: 'REDEEM→CASH', bucket, ips_clause_refs: ['3.1','3.3',…], thesis, note }` describing where proceeds land per IPS (B1/B2 bands, surplus curve) — no execution.

**Acceptance criteria (derive, don't trust this file):**
- `maturityRoutingRec` uses the instrument's own `face_value` + `coupon_rate` fields (mutation-check the test derives the yield from the real instrument row) — it does not hard-code ₹3,00,000 or a tap-in coupon.
- The Sammaan row's maturity matches the seeded `maturity_date`; a 14-day-window digest alert renders the message with the exact date and expected redemption amount in ₹ (paise→string via `formatPaise`).
- With today = 2026-09-05, `listRedemptionsUntil(14)` returns the Sammaan bond; with a horizon of 2 days it returns nothing. No invented numbers: if face/coupon fields disagree with the PRD stated total, add to owner true-up in `MEMORY.md`, do not tune.
- IPS clause id(s) cited exist in `src/config/ips-v1.md` (test cross-checks against the rendered clause index).
- `pnpm exec tsc --noEmit` clean; task's tests red-before-green.

---

### Task 2: Phase 1 schema — migrations 0007 + 0008

**Files:**
- Create: `migrations/0007_phase1_quotes.sql`, `migrations/0008_phase1_intel.sql`, `tests/db/migrations.test.ts` (extend), `tests/db/immutability.test.ts` (extend)

**Interfaces / table shapes (naming follows Phase 0 conventions):**

```
0007:
  prices_eod        (instrument_id FK instruments, trade_date DATE, close_paise BIGINT NOT NULL,
                     prev_close_paise BIGINT, source TEXT NOT NULL CHECK='nse-bhavcopy',
                     as_of TIMESTAMPTZ, PK (instrument_id, trade_date))
  index_prices_eod  (series_code TEXT, trade_date DATE, close_paise BIGINT NOT NULL,
                     source TEXT, as_of TIMESTAMPTZ, PK (series_code, trade_date))
  navs              (instrument_id FK, nav_date DATE, nav_micros BIGINT NOT NULL,
                     source TEXT NOT NULL CHECK='amfi', as_of TIMESTAMPTZ,
                     PK (instrument_id, nav_date))
  holidays          (holiday_date DATE PK, note TEXT NOT NULL)
0008:
  watchlist         (instrument_id FK PK, added_on DATE NOT NULL, removed_on DATE NULL,
                     source TEXT NOT NULL, reason TEXT NOT NULL)     -- open rows = currently listed
  screener_uploads  (id IDENTITY PK, uploaded_on TIMESTAMPTZ, as_of DATE NOT NULL,
                     filename TEXT, source TEXT NOT NULL CHECK='screener-in')
  fundamentals      (upload_id FK screener_uploads, instrument_id FK, data JSONB NOT NULL,
                     roce_pct NUMERIC, de_ratio NUMERIC, fcf_pos_5y BOOLEAN, red_flags INT,
                     UNIQUE (upload_id, instrument_id))            -- latest as_of per instrument = active
  signal_scores     (instrument_id FK, score_date DATE, composite NUMERIC(5,2) NOT NULL,
                     quality_passed BOOLEAN, reg_valuation, reg_trend, reg_earnings, reg_fit NUMERIC(5,2),
                     rank INT, PK (instrument_id, score_date))
  recommendations   (id IDENTITY PK, created_on DATE NOT NULL, kind TEXT CHECK IN
                     ('satellite','mf_switch','rebalance','sell','prepay','maturity_routing','legacy_note')
                     NOT NULL, intent TEXT NOT NULL,
                     primary jsonb NOT NULL, alternates jsonb NOT NULL,       -- full FR-11 payloads
                     ips_clause_refs TEXT[] NOT NULL,                          -- ≥1, all real clause ids
                     engine_evidence jsonb NOT NULL,                           -- scores/inputs that produced it
                     benchmark_as_of DATE, benchmark_jsonb,
                     source TEXT NOT NULL DEFAULT 'advisor',
                     suppressed BOOLEAN NOT NULL DEFAULT false,
                     suppressed_reason TEXT, created_at TIMESTAMPTZ)
  suppressed_actions(logged_on DATE, action text, reason TEXT, suppressed_by TEXT) -- FR-12/FR-55 visible log
  benchmarks(benchmark_at_creation per §13; see Task 12)
```

- Append-only triggers + RLS on: `prices_eod`, `navs`, `fundamentals` (allow new batch rows only — immutable once written), `watchlist` (add = new open row; *never* UPDATE an open row to removed — a new row with `removed_on` must be appended), `signal_scores`, `recommendations`, `suppressed_actions`. `screener_uploads` may be inserted/deleted by migration hygiene only.
- Indexes: `prices_eod(instrument_id, trade_date desc)`, `navs` same, `signal_scores(score_date)`, `fundamentals(upload_id)`, `recommendations(created_on)`.

**Acceptance criteria:**
- Migration runner (`pnpm migrate`) applies 0000→0008 cleanly on a fresh PGlite and a reset DB; compiler clean.
- Mutation tests prove every append-only table rejects UPDATE, DELETE, **and TRUNCATE** (Phase 0 style). New tables carry `as_of`-style timestamps; RLS enabled on all data tables.
- `watchlist` invariants in DB (CHECK): `removed_on IS NULL OR removed_on >= added_on`.

---

### Task 3: NSE EOD price pipeline (EQ bhavcopy + index series)

**Files:**
- Create: `src/sources/bhavcopy.ts`, `tests/sources/bhavcopy.test.ts`, `tests/fixtures/` (real captured zip → committed CSV + expected row rows)
- Edit: `src/jobs/sync.ts` (or `src/jobs/eod.ts` + package.json script), `.env.example`, `src/sources/staleness.ts` (see Task 5 wiring), `tests/jobs/workflow-schedule.test.ts` feed (Task 13)

**Interfaces:**
- `downloadBhavcopy(dateIso) → { rows, report }` — NSE EQ archive `archives.nseindia.com/content/historical/EQUITIES/<YYYY>/<MMM>/cm<ddMMMyyyy>bhav.csv.zip`; parse EQ rows keyed by ISIN + trading symbol.
- `downloadIndexSeries(dateIso) → index rows` — NSE index bhavcopy, `series_code` set (`NIFTY 500`, plus the indices used for benchmarks). Same fetch/parse/e2e error path (`SourceError` with retry/incident semantics per `sources/types.ts`).
- `ingestPrices(db, rows)` — upserts `prices_eod` / `index_prices_eod` for **watchlist + holdings instruments only** (ISIN → instrument_id; unmatched trading symbols are logged, not created — no phantom instruments). Index rows ingested for the series we track.
- Relative-strength sources: 6/12-month contiguous closes per instrument and `NIFTY 500` (validated: dates aligned on trading calendar, not wall 6/12-mo).

**Acceptance criteria (derive; the NSE file layout is an external truth — verify, don't assume):**
- **Verify at build (PRD §15.1.9):** current bhavcopy URL shape, column order, SERIES filter (EQ only), date parsing, and gap handling (holiday = no file = not a failure). Test against the committed real fixture; assert the parsed row count and a handful of spot close values in paise against the fixture's own numbers (derive one side from the CSV, not from constants).
- A 404/empty/malformed day raises a `SourceError`; two consecutive failures surface an incident + the daily digest badges NSE stale (staleness wiring, Task 5).
- Non-trading day returns zero rows without error. Unknown symbol → warning row in `report`, no insert into `instruments`.
- Spot checks: bhavcopy CLOSE `1234.55` → `close_paise=123455`; monetary columns all BIGINT.
- TDD: red first (fixture absent), then green; `tsc` clean.

---

### Task 4: AMFI NAV pipeline (daily + historical)

**Files:**
- Create: `src/sources/amfi.ts`, `tests/sources/amfi.test.ts`, `tests/fixtures/amfi/*` (daily zip→csv, per-scheme history json)
- Edit: sync/EOD job wiring; `.env.example`

**Interfaces:**
- `downloadDailyNav() → rows` (official AMFI bulk daily NAV file — **format verified at build**, §15.1.9; fallback mirror documented) → `navs` for held + watchlist MF instruments keyed by scheme code→instrument_id (existing MF instrument rows must carry the AMFI scheme code — seed/verify, add column to instruments if missing at migration time in Task 2).
- `downloadHistory(schemeCode, sinceIso) → rows` — per-scheme history for MF **ranking** (rolling-return consistency). Primary: AMFI full-history bulk (official, free). Store into a `nav_history` staging table in 0007 **if** ranking needs it (see Task 7 — the trade search body decides; prefer deriving rolling returns from `navs` when the daily job has been running long enough).
- NAV precision: NAV ×`1e6` as `nav_micros` BIGINT (mirrors `UNITS_SCALE` discipline). NAV `27.1240` → `27124000`.

**Acceptance criteria:**
- Real fixture parses; scheme-code → instrument mapping resolves every held/watchlist MF, or the count of unresolved schemes is reported loudly (no silent drops).
- Daily NAV for today is never overwritten retroactively: same `(instrument_id, nav_date)` conflict → keep existing (source file is authoritative-append, gaps filled by a later day's file is fine).
- Doesn't re-download if `navs` already has that `nav_date` (cheap idempotency), while still drift-fixing a *stale* date (→ incident per Task 5).
- Cost: all sources ₹0 per §8.1 (no paid feed). `tsc` clean; fixture-driven red→green.

---

### Task 5: Staleness extension — prices/NAVs/fundamentals + blocked-by-stale proof

**Files:**
- Edit: `src/sources/staleness.ts` (policy + `blockedInstruments`), `src/notify/digest.ts` (stale badge), `tests/domain/staleness.test.ts` (extend), new `tests/domain/blocked-rec.test.ts`

**Interfaces:**
- Extend `FreshnessPolicy` to: `prices` 24h trading days, `navs` 48h, `fundamentals` 1 quarter (calendar), FX 48h, portfolio 36h.
- `blockedInstruments(db, policy)` → set of `instrument_id` (+ reason: `price_stale`, `nav_stale`, `fundamentals_stale`, `fx_stale`, `portfolio_stale`). Market-hours aware: a price dated the last trading day is fresh even if 26h old on a Monday before market open.
- The signal engine (Task 7) filters its universe with this set; the weekly report (Task 11) prints the blocked list with reasons.

**Acceptance criteria — includes the Phase 1 DoD proof:**
- A test seeds a *deliberately stale* price for one watchlist name (as_of wired to 3 trading days ago) and proves: (a) the instrument is in `blockedInstruments` with `price_stale`; (b) the engine output *changes* vs the fresh-price run — the stale name is absent from candidates and the report lists it with the reason. This is the DoD test, written before real blocking exists (red → green).
- Trading-day awareness: a Friday close is fresh until the next Monday 17:30 unless a newer file exists; a fix verifies this on a seeded calendar incl. holidays.
- 2 consecutive failed source syncs → incident row + digest badge (existing incident machinery).

---

### Task 6: Starter watchlist + screener.in importer

**Files:**
- Create: `src/sources/screener.ts`, `src/jobs/screener-import.ts`, `src/seed/seed-watchlist.ts`, `src/seed/seed-holidays.ts`, `tests/sources/screener.test.ts`, `tests/domain/watchlist.test.ts`, `tests/fixtures/screener.csv`
- Edit: `package.json` (`screener:import` script), seed wiring, `.env.example`

**Interfaces:**
- Watchlist: `watchlist.ts` helpers — open/close/list; `seedWatchlist` applies the advisor starter set (~40; large-caps + a band of Indian MF funds for switch opportunities, **excluding held instruments** — §6.1; no penny stocks). Seed rows carry `source='owner'` **only** for names the owner has explicitly confirmed at review; anything I generate is `source='advisor'` and comes with the selection rationale inline (owner reviews before first weekly).
- Screener: `parseScreenerCsv(text) → { records, warnings }` against a **pinned column contract** (documented in the file header: exact screener.in export columns used — the referential DOCUMENT of the format). `importScreener(db, csv)` → new `screener_uploads` row + `fundamentals` rows; active fundamentals = latest `as_of` per instrument; quality-gate fields (ROCE, D/E, 5y FCF positivity, red flags) are the typed columns; the rest rides in `data` JSONB (P/E, EV/EBITDA, 5y history, sector, market cap — no hard-dropped columns).
- Holidays: `seed-holidays` loads NSE trading calendar (2026 seed verified, then yearly).

**Acceptance criteria:**
- Fixture CSV (generated to the pinned columns) imports; a **deliberately malformed row** (missing required column) hard-fails with a readable error and *zero* partial writes (transactional batch) — the real-live-test CSV (owner upload) may add columns; the parser must consolidate, not crash, and produce a warnings list displayed in the weekly report.
- Quality-gate derivation is mutation-tested against the fixture (e.g. change ROCE below 15 → `quality_passed=false`) with the expected value derived from the row, not hard-coded.
- Watchlist is advisor-owned: only `source='owner'` seed rows survive *without* a change record; closing a name = append a new watchlist row with `removed_on`, never an UPDATE.
- `pnpm screener:import` idempotent on re-upload of the same `as_of`+filename (replaces nothing; warns `already active as_of`).
- `tsc` clean; red→green TDD.

---

### Task 7: Signal engine — satellite composite + MF ranking

**Files:**
- Create: `src/domain/engine.ts`, `tests/domain/engine.test.ts`
- Consumes: `Db` prices/index/navs/fundamentals/`blockedInstruments`; produces `signal_scores`.

**Interfaces:**
- `scoreSatellite(instrument, context) → SignalScore | null`:
  - **Quality gate (binary, §6):** ROCE>15%, ≥4 of last 5 years positive FCF (data availability noted when sparse), D/E<1 (banking/finance exempt by sector), no red flags (screener `red_flags=0`). Fail → null (no score), recorded as `quality_passed=false`.
  - **Composite [0,100]:** valuation 30 (Earnings Yield vs 10Y G-sec [assumption/rate config] + P/E/EV-EBITDA relative to own 5y + sector median — all inputs from fundamentals + prices; sector medians from the screener cohort, not external tables), trend 30 (6-mo RS vs `NIFTY 500`, ±12-mo, price/200DMA), earnings 20 (delivery/quality + growth consistency from fundamentals history), fit 20 (bucket alignment — e.g. satellite bucket headroom after current recommendations; concentration caps; sector rotation balance).
  - Thresholds: composite ≥85 → HIGH, 70–84 → MEDIUM, 60–69 → watch (scored, not recommended), <60 → none. Recommended universe = MEDIUM/HIGH non-blocked names.
- `rankMfs(context) → ranked list` — §6 MF scoring: rolling-return consistency 40, expense ratio 20, fund tenure 15, AUM 15, style drift 10. Prices/navs/history only; **no_float money** — returns computed in `nav_micros`.
- Persist the day's `signal_scores` row (deterministic; source anchors noted).

**Acceptance criteria (derive; the weights are PRD-fixed but their *outputs* are falsifiable):**
- A watchlist name with a stale price or stale fundamentals cannot receive a score (task 5 proof composes here).
- **Red-flag stripping:** set `red_flags=1` in a fixture → quality gate blocks → no score; mutation test, value derived from the row.
- Sector-weathering sanity: relative strength is monotonically consistent with a hand-computed RS on the fixture (derive the expected RS from the actual closes).
- Unitless scores; no currency is a float. `tsc` clean; red→green.

---

### Task 8: Allocation engine — monthly drift move + annual April rebalance

**Files:**
- Create: `src/domain/alloc-engine.ts`, `tests/domain/alloc-engine.test.ts`
- Consumes: Phase 0 `allocation.ts`, `buckets.ts`, `surplus.ts`, `ips.ts`, `blockedInstruments`.

**Interfaces:**
- `rebalanceRec(state, monthYear) → { direction, tax_notes, actions: CandidateAction[] }` — turns the existing monthly drift check (FR-13, ±5% bands) into a *recommendation*: excess bucket → the IPS-aligned direction with **tax-aware preference** (accumulating SIPs, harvesting offsetting losses over realising gains), never a forced sale beyond IPS bands; the money moves as a *direction* to Phase 2, not an order.
- Annual (April, fiscal-year aware — India: April) rebalance *proposal*: resurface the drift as a recommendation object when drift breaches, else state `in-band` with the numbers.
- B1/B2/NOW/EPF all inside the net-worth basis (Phase 0 already handles this); the **Kolkata property is not a target** (hard constraint held across).

**Acceptance criteria:**
- Reuses the Phase 0 real net-worth basis (one source of truth, not a re-computation); a ₹0-cost drift (no breach) yields `in-band` with the actual percentages, derived from state.
- Tax-preference behavioural test: given a realised-gain candidate and an equivalent load-free accumulating-SIP route, the recommendation prefers the SIP route (document the tax logic at the top of the module; keep small, no tax engine — *flag to owner what it does and doesn't compute*).
- Breach example from the real balance sheet → direction integer arithmetic only (paise). `tsc` clean; red→green.

---

### Task 9: Sell / exit triggers — monthly evaluation (FR-15)

**Files:**
- Create: `src/domain/sell-triggers.ts`, `tests/domain/sell-triggers.test.ts`
- Consumes: `recommendations` (falsification conditions), `instruments`, prices, `fundamentals`, `alloc-engine` caps, `ips.ts`.

**Interfaces:**
- `evaluateExits(db, state, month) → CandidateAction[]` evaluating §6.5 triggers **1–5,7** monthly; trigger 6 (legacy queue) is the documented Phase 2 stub:
  1. **Falsification:** an open recommendation's `falsification_condition` is *testable* against fresh data (prices/fundamentals) and true → exit candidate.
  2. **Red flag** appears in the latest screener upload for a held name → exit candidate (not auto — paper).
  3. **Hard-cap breach** of a held instrument vs §3 concentration caps (phase 0 caps) → exit candidate.
  4. **Sustained underperformance:** 12-month return vs thesis benchmark < −20% for 2 consecutive quarters → exit candidate.
  5. **Tax-aware better alternative** generator (new satellite/MF candidate vs held equivalent) → ≤1 such exit per quarter (paper).
  7. **Credit / maturity rule** (bonds): rating action or maturity within 14 days → maturity/exit alert (Task 1 integrates).
- Each candidate carries the trigger id, the data that fired it, and an IPS citation.

**Acceptance criteria:**
- Falsification test is a real harness: seed a recommendation whose falsification condition trips on seeded prices → exit candidate appears with `trigger=falsification`; untripped → absent. (Round-trip through the appended recommendation — proves FR-11's stored conditions are live, not decorative.)
- Underperformance arithmetic is derived from the actual price series in the fixture (mutation: move the series above −20% → candidate disappears).
- Sell candidates are paper objects (§6.5 "first-class" = they exist as recommendation-kind `sell`), blocked instruments never produce an exit (stale → no assertion either way).
- `tsc` clean; red→green.

---

### Task 10: Recommendation objects — FR-11/FR-12 + paper mode

**Files:**
- Create: `src/domain/recommendations.ts`, `tests/domain/recommendations.test.ts`
- Consumes: engine candidates, alloc/sell outputs, `ips.ts`; persists to `recommendations` + `suppressed_actions`.

**Interfaces:**
- `buildRecommendation(candidates, state) → Rec` — deterministic builder turning engine outputs into the FR-11 contract: primary + exactly 2 alternates (§6.6: A1 same-intent different instrument / index-route fallback; A2 different intent — do-nothing + redirect drift repair / debt-prepayment / maturity routing). Theses ≤150 words (count asserted), each alternate carries the full payload, `ips_clause_refs` ≥1 real clause id (validated against the rendered IPS index).
- **FR-12 caps:** ≤4 recommendation objects per calendar month; 12-month min-hold on a name (no repeat BUY inside 12 months of the prior recommendation's `created_on`) with **3 override events only** — IPS spec change, material adverse falsification, owner directive. A manufactured action that breaches a cap is logged to `suppressed_actions` (visible note) rather than dropped.
- **Paper mode (FR-55):** reads `settings_rails.paper_mode`; when true, recommendations are *logged+scored* and the surface is the weekly report — there is no execution path anywhere in `src/jobs/report.ts` (structural test scans for order-like calls).
- `announceMaturity` integrates Task 1 as a `maturity_routing` recommendation when relevant.

**Acceptance criteria:**
- Counter-example guard: an FR-11-true object missing an alternate, or with a 151-word thesis, fails the builder's own validation (assert both acceptance and rejection paths).
- Override-event test: a repeat BUY inside 12 months suppressed-with-reason; with an `owner directive` override row it passes. Value derived from the stored prior recommendation's dates.
- The 4/month cap test: a fixture month with 4 existing recommendations → 5th candidate suppressed (`suppressed_actions` row), reason visible in the report.
- Every `ips_clause_ref` exists in `ips-v1.md` (rendered index cross-check).
- `tsc` clean; red→green.

---

### Task 11: Weekly deep report job (FR-51) + narrative step + schedule

**Files:**
- Create: `src/sources/llm-narration.ts`, `src/domain/report-lines.ts` (pure composition), `src/notify/report.ts`, `src/jobs/report.ts`, `tests/notify/report.test.ts`
- Edit: `package.json` (`report` script), `.env.example`, `.github/workflows/weekly.yml` (Sunday 10:00 IST per PRD §12.2 — with owner sign-off), `tests/jobs/workflow-schedule.test.ts` (re-derive; see next), `src/sources/staleness.ts` (report-time blocked list exposure)

**Interfaces / report sections (§12.2 + FR-51):**
  1. **Signal review** — today's `signal_scores` vs last week: new HIGH/MEDIUM, fallen, quality-gate drops.
  2. **Watchlist changes** — open/close rows since last report (advisor proposals awaiting owner sign-off rendered distinctly).
  3. **Recommendation pipeline** — current open recommendations, their trust anchors, falsification status (live from Task 9), caps deliberation, suppressed actions appended (FR-12 visible note).
  4. **Staleness report** — blocked instruments + reasons + incident log (FR-31) — *this section is what makes a stale price visible*.
  5. **Narrative** (§6.7) — deterministic bullet summary → OpenRouter prompt → prose. LLM receives serialized engine output + prompt-only text; returns narrative; nothing feeds back. If no `OPENROUTER_API_KEY`, fall back to the deterministic bullet summary (no narrative) without error.
- `report.ts` accepts `--as-of <date>` (reproducible report on a past date from persisted rows — the tests use it); default today.

**Acceptance criteria — the DoD:**
- **The weekly report test is the Phase 1 DoD:** with fresh seeded state, `report --as-of <seed-date>` produces a report containing **≥1 fully-formed paper recommendation** (primary + 2 alternates, all FR-11 fields, ≤150w theses, IPS citations) **with every data timestamp shown**; and with one watchlist price deliberately stale, the same invocation produces a report that (a) lists that name under staleness with reason, and (b) does not embed it in any recommendation — a diff between the two reports proves the blocking. Written before narration exists.
- Narrative step: with a mock LLM transport, prose returns verbatim; with no key, deterministic summary shows; with the real transport mocked-off it is never called in tests (no network in vitest).
- Report length is bounded (each section's fixed shape; long lists collapse with counts) — a Telegram renderer that stays under ~4096 chars per message (split channels if needed; Phase 0 path).
- `weekly.yml` runs `pnpm report`; schedule changed to Sunday 10:00 IST **only after owner sign-off**; the `workflow-schedule` test is re-derived from the new YAML in the same step and the stale-test *decision* reported back to the owner (never silently resolved).

---

### Task 11A: Local preview UI (`pnpm ui`, 127.0.0.1:8081)

**Why:** the owner previews the weekly report locally and iterates on what's ugly/missing before Telegram-ifying it. The real Next.js UI is Phase 2; this is a thin read-only preview shell over the same pure composition, unblocked to ship its first slice now (before Tasks 3–12 land) so layout + content can be judged early.

**Files:**
- Create: `src/ui/render.ts` (pure HTML renderer), `src/ui/server.ts` (`startServer` + `handleRequest`), `tests/ui/ui.test.ts`
- Edit: `package.json` (`ui` script → `tsx --env-file=.env src/ui/server.ts`)
- No edits to `src/notify/` for the shell — the shell consumes `buildDigestInput`/`composeDigest` and, once Task 11 lands, the report composition; mutate nothing.

**Interfaces:**
- `renderPage(db, view) → HtmlDocument` — pure (async DB reads, then string): paths `/` (weekly-report preview) and `/digest` (existing daily digest as a styled card). Sections render from **real data today**: net worth + buckets, allocation drift vs IPS, staleness/blocked instruments, holdings table, employer-concentration breach. Planned sections render an explicit placeholder badge naming the task that fills them (`recommendations` → Task 10, `signal scores` → Task 7, `maturity alert` → Task 1).
- `startServer(db, opts)` — `node:http`, binds `127.0.0.1:8081`, responds 200 `text/html`; `handleRequest(db, url)` exported for tests (no port in vitest).

**Acceptance criteria:**
- `handleRequest` returns the page whose figures are **derived from the seeded DB at render time** (e.g., net-worth total comes from `netWorth(...)` output, not a hardcoded literal); a mutation-check disproves tunneling.
- Placeholder sections exist and carry the "lights up in Task N" badge; `/digest` reuses `composeDigest` output as-is (no re-formatting drift).
- **Read-only is verified:** the server never imports a mutating path (scan for `writeSnapshot|persist|update|delete` in `src/ui/*` in review; simplest is that neither file imports beyond `db/client` reads + domain readers).
- `pnpm ui` fails fast with a clear message if the DB is unreachable; `pnpm exec tsc --noEmit` clean; tests red-before-green.

---

### Task 12: Scoring harness (§13) + calibration shell

**Files:**
- Create: `src/domain/scoring.ts`, `tests/domain/scoring.test.ts`, `src/jobs/score-evals.ts` (or fold into report schedule)

**Interfaces:**
- `snapshotBenchmark(rec)` — at creation, capture `benchmark_as_of` + the benchmark series (instrument price + index) into `recommendations.benchmark_jsonb` (post-hoc eval needs a point of comparison, §13.2).
- `dueEvals(db)` → recommendations whose 3/6/12-month eval dates have passed without a snapshot; `evaluateRevs(rec)` computes return-vs-benchmark in integer units, conviction-health flags, and writes the §13 snapshot.
- Calibration **report section**: conviction bucket vs hit-rate table; "insufficient data" when fewer than the agreed minimum N (flag the threshold to the owner in MEMORY).

**Acceptance criteria:**
- Benchmark snapshot captures the exact close+index at creation (mutation-check: change the seeded price → snapshot differs).
- No recommendation is ever scored before its eval date (a dueEvals run on a fresh seed yields zero rows).
- Calibration section with zero evals renders the honest "insufficient data" line, not zeros-percentages.

---

### Task 13: Workflows, env, provisioning verification, README

**Files:**
- Edit: `.github/workflows/{sync,weekly}.yml`, `tests/jobs/workflow-schedule.test.ts`, `.env.example`, `README.md`, `index.md`, `PENDING.md`, `MEMORY.md`
- Create: `docs/superpowers/plans/2026-09-05-sentinel-phase-1.md` already exists (this file); provisioning checklist section lands in README.

**Contents:**
- **EOD job** extended to run bhavcopy + AMFI after the existing sync (order matters: prices before engine).
- **Weekly job** repointed to Task 11's `pnpm report`; schedule per §12.2 (after owner OK).
- `.env.example` documents `OPENROUTER_MODEL` (+ `OPENROUTER_API_KEY` already present) and any screener path var.
- §15.1 provisioning verification items for Phase 1, confirmed at build: bhavcopy URL/format, AMFI bulk format, index series availability, OpenRouter weekly model id + pricing sanity (~₹1.5–3k/mo), NSE 2026 holiday calendar fill.
- README Phase 1 handoff section (data-flow diagram + how a recommendation gets built/blocked).
- Session docs updated per session-end protocol.

**Acceptance criteria:**
- Workflow YAML parse is exercised by the existing env/schedule tests (re-derived not doctored); CI green; `pnpm exec tsc --noEmit` clean; full suite green with the stale-test *decision* logged in PENDING (unchanged, awaiting owner).

---

## Verified facts used by this plan (checked 2026-09-05)

- Phase 0 shipped 16 tables, `funded_status` guard test, `blockedInstruments` + `ipsClause` ready for Phase 1 (README handoff, lines 65–79).
- Weekly workflow exists at `.github/workflows/weekly.yml` (currently Sat 08:00 IST; PRD §12.2 says Sunday 10:00).
- Migrations run 0000→0006; Phase 1 extends with 0007/0008 (Task 2). All Phase 0 constraints re-affirmed.
- Staleness engine + incident machinery exist; freshness policy lives in `src/sources/staleness.ts` (extended in Task 5).
- Owner decisions (2026-09-05): watchlist advisor-owned w/ seed+quarterly proposal; screener format spec + fixture now, real CSV as live test; weekly LLM via existing OpenRouter key; Sammaan maturity in Phase 1, legacy cleanup/LTCG calendar in Phase 2.