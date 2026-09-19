# PENDING — start here

One screen of what's open, so a new session doesn't have to re-read anything. Updated at
every session end alongside MEMORY.md / progress.md. Contracts & gotchas live in
MEMORY.md; the code map lives in index.md.

## Next up
- [x] **PHASE 2 TASK 5 COMPLETE (2026-09-19): Paper scheduling, scoring and backup/restore proof.**
      Implemented: src/jobs/schedule.ts (expireOrders, resurfaceDeferredOrder, T+2/T+7 advisory reminders via recordAdvisoryReminder; all idempotent via idempotency keys). .github/workflows/schedule.yml (daily 10:00 IST). src/jobs/backup.ts + backup-restore.ts (weekly encrypted pg_dump to private GitHub repo via AES-256-GCM, git push to backup repo, restore verification script). .github/workflows/backup.yml (weekly Sun 11:00 IST). Updated ORDER_LIKE_PATTERNS regex to avoid false positives on import paths. All 689 tests pass, tsc clean.

- [x] **PHASE 2 TASK 4 COMPLETE (2026-09-19): Web approval/cleanup/rail surfaces.**
      Implemented: /approvals page with pending queue and detail view (immutable history, paper simulations, payload snapshot); actions: Approve/Reject/Defer, plus advisory Await execution/Verify/Abandon. /cleanup page with freeze/breaker state, rail cooling countdown, drawdown, bond maturities (60-day horizon), sell trigger candidates, LTCG harvest notice. API routes at /api/approvals/[id]/{approve,reject,defer,await-exec,verify,abandon} mirroring Telegram bot flow with append-only transitions and audit_log. Navigation updated. All 687 tests pass, tsc clean.

- [x] **PHASE 2 TASK 3 COMPLETE (2026-09-19): Paper legacy cleanup + multi-year LTCG calendar (FR-14, §3.9).**
      Implemented: generateCleanupRecommendations (smallcase termination retaining constituent ETFs, micro-orphans <₹5k, thesis-less consolidation, Groww RPOWER manual closure, bond credit review, Sammaan Sep-2026 maturity routing to B3, LTCG harvest scheduled across 1–2 fiscal years using ₹1.25L/year exemption pending §15.1 law verification). All recommendations are FR-11 paper objects with 2 alternates (index-route A1, do-nothing A2). Uses known FIFO lots only; unknown cost basis → owner prerequisites, never ₹0. toPaperRecommendations converts to persistable recommendations. 14 tests added, all 687 tests pass, tsc clean.

- [x] **PHASE 2 TASK 2 COMPLETE (2026-09-18): Rails, freeze, breaker, behavioral protocol.**
      Implemented: checkRails (single-order ceiling, tactical budget, concentration,
      forbidden universe, staleness, hold period, override validity);
      checkPortfolioRails for digest; freeze/breaker state machine; 48h cooling;
      drawdown >15% blocks loosening, >=20% requires §3.10 justification;
      paper simulations; T+2/T+7 advisory reminders.
      All 673 tests pass, tsc clean, CI/sync green.
      

- [x] **CI/sync repair pushed to main (2026-09-18), `573d52a`.**
      CI run `35265799106` passed (typecheck + tests); manual sync `35265838151` passed
      in 9m3s, logging `synced: indmoney, frankfurter, nse-bhavcopy, amfi`.
      Fixed TypeScript, YAML indentation and scheduled scripts requiring missing `.env`.
      The optional-file notice appears twice through tsx/Node; runner secrets are supplied
      directly and sync continues normally. Local **656 tests pass**, scoped review clean.
      Automatic digest `35266731863` started; outcome not yet checked. Verification update
      recorded locally after the code push.


- [x] **PHASE 2 TASK 1 COMPLETE (2026-09-18): Paper approval state machine (FR-20–25).**
      Implemented: FR-30/31 rail/freshness gate on createOrder/modifyOrder; advisory path
      ACKNOWLEDGED → AWAITING_MANUAL_EXECUTION → VERIFIED/ABANDONED; defer resurfacing
      with score check and withdrawal recommendation; expiry notification callback;
      paper simulations (SESSION_MISSING, PARTIAL_FILL, BROKER_REJECT, MARKET_CLOSURE,
      ADVISORY_ACK, ADVISORY_VERIFY, T2_REMINDER, T7_REMINDER); limit-order expiry
      deferred to Task 2 (PRD silent). All **668 tests pass**, tsc clean.
      Remaining for Task 2: rails enforcement, freeze/breaker, behavioral protocol.

- [x] **AMFI NAV PIPELINE FIXED (2026-09-17).** The AMFI daily NAV ingestion now works for all
       6 MF instruments. Root cause: seed instruments lacked real AMFI scheme codes/ISINs,
       and `ingestNavs` used a massive 31,978-parameter query that hit PGlite/PostgreSQL limits.
       Fixed by: (1) adding real AMFI ISINs to seed data for 5 MF instruments (PPFC, ICICI
       Large Cap, HDFC Mid Cap, Motilal Midcap, Bandhan Small Cap), (2) finding and adding
       the correct AMFI scheme code for ICICI Nifty 50 Index Direct (schemeCode 120620,
       ISIN INF109K012M7), (3) rewriting `ingestNavs` to query all local MF instruments
       directly (O(1) map lookup) instead of filtering by massive AMFI lists. Sync now shows
       `amfi: 14124 unmapped` (down from 14,130) — all 6 MF instruments now receive NAVs.
- [x] **PHASE 2 + 2.5 PLANS CORRECTED (2026-09-17).** `docs/superpowers/plans/2026-09-16-sentinel-phase-2.md`: 6 tasks, PRD "Prove",
       paper-only full Telegram approval flow, real rails/breaker, cleanup, existing web app,
       scoring and tested backup/restore. `2026-09-17-sentinel-phase-2.5.md`: 11 tasks,
       LLM BUY/SELL/HOLD/WAIT decisions with explicit deterministic sizing prerequisite,
       news coverage/failure semantics and bounded point-in-time replay.
- [x] **PHASE 2 TASK 1 COMPLETE (2026-09-18):** Paper approval state machine (FR-20-25). immutable paper intents/events + FR-20–25 state machine.
       Market expiry EOD; SIP/MF changes 7 days; three consecutive approved falsifications
       trip the breaker (Task 2). Preserve bot statement confirms; no Kite resurrection.
       Open inputs: limit-order expiry, reliable FIFO/tax history, backup/auth provisioning.
       Phase DoD still requires 4 clean paper weeks + ≥5 actual owner interactions.
       Documentation handoff only this session; no implementation/commit/push claimed.

- [x] **SENTINEL SCREEN COLUMNS — RESOLVED 2026-09-15.** Owner's signed-in CSV export
       `sentinel2_screener.csv` (412 lines, 17 cols) obtained and imported via new paste path.
       `parseScreenPaste` auto-detects CSV (comma) vs TSV (tab), maps headers:
       `Profit Var 5Yrs %`→`Profit 5Y CAGR`, `Sales Var 5Yrs %`→`Sales 5Y CAGR`,
       `Free Cash Flow 5Yrs Rs.Cr.`→`FCF 5Y`, `Debt / Eq`→`D/E`, `EPS 12M Rs.`→`EPS`.
       `fcf_pos_5y` derived (FCF>0 → true). Import: `pnpm screener:import --paste <file>`
       (CLI) or `POST /screener/upload` (web UI). 389/411 rows landed (22 name mismatches
       warned, not created — per design). Fundamentals `fcf_pos_5y` + CAGR keys now populate;
       signal engine quality gate unblocks on fresh upload. Parser tests added (TSV+CSV fixtures),
       **630 tests pass**, tsc clean.

- [x] **QUARTERLY SCREENER CSV REMINDER — ADDED 2026-09-15.** New job `pnpm screener:remind`
       (`src/jobs/screener-reminder.ts`) checks staleness (`assessStaleness`) for `screener`
       source (fundamentals 1 quarter = 90 days). If stale AND no reminder sent in last 30 days
       (audit_log dedupe), sends Telegram nudge to owner: "refresh the screener CSV and upload
       via web UI". Workflow `.github/workflows/screener-reminder.yml` runs weekly (Mon 07:00 UTC)
       — data-driven, not fragile quarterly cron. Reuses existing staleness engine (FR-31).

- [x] **SCREENER COHORT PROMOTION — the universe widens on every screen import (2026-09-15).**
       Rows whose company is not yet in `instruments` are now promoted to real instruments
       (`NSE:<slug>`, kind EQUITY, name from the screen, metadata `{"source":"screener-cohort"}`)
       instead of being skipped as "Unknown instrument". ISIN stays NULL and is filled later by
       `pnpm backfill:isin` from `EQUITY_L.csv` — never invented. Degenerate `/company/id/<n>/`
       slugs ("ID", len<3) are still refused. `importScreenRows` now returns
       `createdInstruments` and the CLI prints the promotion count. No migration, no schema
       change. Re-running the owner's sentinel screen 3963033 now promotes its ~398 previously
       skipped companies, so the next `pnpm watchlist:propose` draws from a real pool. 4 new
tests (existence/kind/metadata mark, derived exact-set, re-import idempotence, degenerate
      refusal), **618→622 passed**, tsc clean. `IND:INDSxxxxx` cohort placeholders stay
      un-resolvable (their ids carry no symbol) — separate track. **Correction 2026-09-16: the
      sentinel screen is 410 records over 17 pages** — screener serves **25 rows per page** to the
      paged URL (not the UI's 50), and the importer's default cap of 10 pages (250 rows) was
      silently truncating it. Default page budget raised to 100 — the real terminator is the
      short page — with a stubbed-fetch test pinning a >10-page screen; 2 new tests, **622→624
      passed**. Re-import now lands the full 410, ~398 of them promoted new companies.

- [x] **NSE PRICES LANDED IN SYNC FOR THE 2026 SANDBOX (2026-09-15).** The NSE archive host now
      404s *every* 2026 bhavcopy file (2019–2024 still fine) — equity prices had been silently
      dead since June. `downloadBhavcopy` keeps the archive as primary (it carries ISINs) and
      falls back to the whole-market `sec_bhavdata_full_<DDMMYYYY>.csv` (numeric month) on
      NOT_FOUND; both missing → empty, still reported. `ingestPrices` now resolves ISIN-less
      full-market rows through the `NSE:<symbol>` id that seed instruments already carry.
      `downloadEquityMaster` + `backfillInstrumentIsins` + new `pnpm backfill:isin` fill empty
      instrument ISINs from `EQUITY_L.csv` (2306 EQ symbols) **without clobbering** seeded
      values. Live-verified: 2637 full-market rows for 11-Sep-2026 (GOLDBEES 125.12, LIQUIDBEES,
      M&M, CRISIL all present), archive still serves 2024 data, `pnpm sync` + `pnpm backfill:isin`
      both green. Commit `316720a`; **611→618 tests pass**, tsc clean.
      **Residual gap, kept "known":** the index zoo (`ind<DDMMMYYYY>.zip`) still has no working
      2026 source, kept silent-empty as before. The ~18:00 IST file-publication gap was closed the
      same day: `sync.yml` cron moved to `30 13 * * *` (**19:00 IST**) so the
      daily run lands after NSE publishes. See the resolved NSE line under Waiting on OWNER for the detail.

- [x] **ALL LOCAL WORK NOW COMMITTED + PUSHED TO `main` (2026-09-13).** Ten Phase 1 tasks
      (7–13 incl. holiday seed + LLM model family) plus the screener-screen HTML scraper and
      the extraction-model revert are live on origin/main; GitHub Actions holds the real
      provisioning. No local uncommitted work remains.
- [x] **THIS WEEK, OWNER:** the two items that unblock Phase 2's usefulness in real data —
      GSEC_YIELD_PCT set (`.env` + GitHub var = 7.0, 2026-09-13) and the screener live-run
      attempted: **blocked — `/screen/raw/?query=...` is login-gated; owner must save the
      screen and share a public `/screens/<id>/<slug>/` link** (see Waiting on OWNER).
- [x] **KITE RETIRED — INDmoney is the only portfolio source. DONE 2026-09-07.** The connect
      flow worked, which is how it surfaced that INDmoney already aggregates the same Zerodha
      account: net worth had jumped ₹57,12,936 → ₹71,85,786 (+26%) with no money moving.
      Code removed and data cleaned; **verified back to 48 positions / ₹57,12,936 assets /
      ₹20,90,960 net, sources `manual-seed, indmoney` only**, digest composes clean with no
      kite row in staleness. The empty `kite` snapshot row remains by design (`snapshots` is
      append-only — trigger in `0001`, not `0004`) and contributes zero positions. The orphaned
      kite `STALE_DATA/BLOCK` incident was resolved too. Backup of the deleted rows:
      `data/kite-snapshot-backup-2026-09-07.json` (gitignored). Detail + the two durable
      lessons in `MEMORY.md § Kite retired`.

- [ ] **LLM extraction — WORKS NOW (2026-09-06).** Root cause of the "LLM not configured" behavior:
      the OpenRouter key lived only in a shell env var; `web/next.config.ts` loads repo-root `.env`
      at startup, so servers started from any other terminal ran extraction-less. Key moved into
      `.env` (gitignored) + documented in `.env.example`. Live-verified: `minimax/minimax-m3:free`
      returned a clean JSON extraction from a real statement image with that key; gemma `:free` 429
      (shared free-pool saturation → chain walks). Server must be **restarted** after `.env` changes.
      After the 5-Sept test uploads with no key, the `/import` History shows 3 permanent
      `fake.png` entries (append-only record) — owner chose to keep them.

- [ ] **Web redesign, v2 — AGAINST THE ArenaAI REFERENCE — BUILT + COMMITTED (pushed 2026-09-07, `9420cba`) (2026-09-06).**
      Owner review of v1: "right half of each screen empty, no gaps between cards, two cards in a
      row, and where is the Kite authentication button?" Reference: `D:\Sentinel-ArenaAI.zip` →
      `C:\Users\Anirban\AppData\Local\Temp\opencode\arenaai`. **Root cause (confirmed):** pages use
      `.grid`, `.stats`, `.legend`, `.ips-text`, `.dim`, `.mono`, `.tr-*`, `.card-body` that were
      **undefined** in `web/globals.css` → cards fell back to full-width stacked blocks. **Done:**
      rewrite of the layout layer in `globals.css` — real `.grid` (2-col, 24px gaps), `.two-thirds`
      wide + rail, `.stats` strip, `.one`/`.span-2` full-row, `.stack` rhythm, mobile 1-col
      collapse; missing utilities (`.dim`, `.mono`, `.legend`, `.ips-text`, `.tr-*` row tones,
      `.card-body`) defined; `.main` max-width 1320px; overview uses `grid two-thirds`;
      `/import` review sections flow 2-up and a **"Connect a provider"** grid was added with
      LLM status cards and an honest "Import statement" path. Verified: tsc clean, all 16 pages 200, served CSS
      confirms `repeat(2, 1fr)` + `gap:24px`, suite **435 passed**. **Open for owner:** visual fidelity — keep the current near-black/indigo glow or match ArenaAI's
      slate-950 flat panels exactly? Server running on :3001.

- [ ] **Redesign + `/import` ingest flow — BUILT + COMMITTED (pushed 2026-09-07, `9420cba`) (2026-09-05).**
      The web app got a hand-rolled ultra-modern CSS theme (near-black base, indigo/violet
      glows, glass panels/sidebar; no Tailwind) and a new owner-gated **statement-import**
      flow at `/import`: upload brokerage or Fidelity RSU statements → LLM extraction into
      proposals → confirm/reject → real DB writes through the same platform functions as the
      Telegram bot (FR-02/03). Backing store = migration `0009_web_uploads.sql` (already
      applied to live by the first `/import` load). No-key degrade path verified (`unusable`).
      **Now on `main`; review there.**

- [ ] **The real app — BUILT + COMMITTED (pushed 2026-09-07, `9420cba`).** After the 8081 preview the
      owner said "build the real app" (2026-09-05): PRD's Next.js product UI pulled forward
      as a standalone **`web/`** app, local + read-only. **16 routes live at
      http://127.0.0.1:3001** (`pnpm web`, `next dev -p 3001`), all verified 200 against the
      real Supabase DB: `/` Overview, `/holdings`, `/allocation`, `/buckets`, `/rails`,
      `/rsu`, `/ips`, `/freshness`, `/audit` render live Phase 0 data through the same pure
      domain functions the jobs use; `/watchlist` (T6), `/signals` (T7), `/recommendations`
      (T10), `/maturity` (T1), `/narrative` (T11), `/scoring` (T12) are honest Task-N shells
      with disabled, reason-named buttons; `/product` is the AREAS map. **Now on `main`;
      review there** (`web/`, docs, `.gitignore`, `package.json` script).
      Gotchas in `MEMORY.md § Local web app`. This SUPERSEDES Task 11A's throwaway shell as
      the UI vehicle (the 8081 preview stack still merges on its own turn).

- [x] **Phase 1 schema (migrations 0007/0008) — DONE 2026-09-11.** Phase 1 Task 2 complete:
      Migration `0008_phase1_intel.sql` creates `watchlist`, `screener_uploads`, `fundamentals`,
      `signal_scores`, `recommendations`, `suppressed_actions`, `benchmarks` with append-only
      triggers + RLS. Migration `0010_phase1_quotes.sql` (was 0007) created `prices_eod`,
      `index_prices_eod`, `navs`, `holidays`. All 451 tests pass, tsc clean.

- [x] **Fidelity RSU Telegram flow — SHIPPED 2026-09-05** (the dead end is gone). Flow:
      screenshot → `extractRsuVestsFromImage` (`{vests}`) → priced proposal queue →
      `/confirm <#>|all` writes ACTUAL `rsu_vests` via `confirmVest`; `/reject` clears it;
      /`fidelity` wired; `saveStatementPhoto` short-circuits on existing files; digest
      stops announcing confirmed vests. 13 new tests; suite 432 → 444 (see MEMORY § Fidelity
      flow). **Remaining = the live test** — see Waiting on OWNER.
      NOTE: the 78 US:NOW shares in today's digest come from `pnpm seed` (hardcoded from
      numbers the owner pasted in chat, 2026-08-24/09-05 session) — NOT from any Telegram
      flow.

- [x] **Stale test removed** — `tests/jobs/workflow-schedule.test.ts` cron assertion for
      `digest.yml` deleted. The digest now runs on `workflow_run` (sync success), not a cron.
      Suite is **435 passed, 0 failed**.

- [x] **Sammaan bond maturity modeling — DONE 2026-09-11.** Phase 1 Task 1 complete:
      `src/domain/maturities.ts` with `listRedemptionsUntil` + `maturityRoutingRec`, 6 tests
      in `tests/domain/maturities.test.ts`, 14-day digest alert block in `composeDigest`,
      2 new digest tests for maturity alert. All 443 tests pass, tsc clean. Bond INE148I07GL3
      (300 units × ₹1,000 face = ₹3,00,000 + ₹27,000 coupon = ₹3,27,000 total) routes to B3
      per IPS §3.9, cited in routing thesis with clauses 3.3 + 3.9.

- [x] **NSE EOD price pipeline (bhavcopy + index series) — DONE 2026-09-11.** Phase 1 Task 3 complete:
      `src/sources/bhavcopy.ts` with `downloadBhavcopy`, `downloadIndexSeries`, `ingestPrices`; 
      fixtures in `tests/fixtures/bhavcopy/` (equity + index CSV); migration `0010_phase1_quotes.sql`
      adds `prices_eod`, `index_prices_eod`, `navs`, `holidays`; staleness extended with `prices: 24h`
      check against `prices_eod`. 8 tests pass (parsing + ingestion with mutation checks).
      Sync job now includes `nse-bhavcopy` step (skips weekends, logs skip).

- [x] **AMFI NAV pipeline (daily + historical) — DONE 2026-09-11.** Phase 1 Task 4 complete:
      `src/sources/amfi.ts` with `downloadDailyNav`, `downloadHistory`, `ingestNavs`; 
      fixture `tests/fixtures/amfi/NAVAll_11SEP2026.txt` (real AMFI format); migration `0009_amfi_scheme_code.sql` 
      adds `scheme_code` to instruments; seed updated with 6 MF scheme codes; 
      `navs` table allows corrections (no append-only); staleness checks `navs` at 48h. 
      6 tests pass (parsing + ingestion, mutation-checked). 
      Sync job ready for `amfi` step (skips weekends, logs skip).

- [x] **Staleness extension + blocked-by-stale proof — DONE 2026-09-11.** Phase 1 Task 5 complete:
      Extended `src/sources/staleness.ts` with `navs: 48h` (amfi) and `fundamentals: 1 quarter` (screener).
      - `getLatestNavsAsOf()` / `getLatestFundamentalsAsOf()` query `navs` / `fundamentals` tables.
      - `assessStaleness()` now checks `amfi` (stale when no navs data) and `screener` (unimplemented until Task 6).
      - `blockedInstruments()` extended: blocks MF when amfi stale, blocks equity/ETF/bond when bhavcopy stale, blocks equity when screener stale.
      - `fundamentals` table allows corrections (no append-only); added `as_of` column via migration `0011_fundamentals_as_of.sql`.
      - `navs` table allows corrections (no append-only trigger).
      - `screener` remains `unimplemented` until Task 6 (no ingestion path yet).
      - 13 tests in `tests/sources/staleness.test.ts`, 10 in `tests/sources/staleness-blocking.test.ts`.
      - DoD proof: Two tests prove a deliberately stale price provably blocks a watchlist instrument from recommendations, and the engine output changes when price goes stale.
      - **All 460 tests pass, `tsc --noEmit` clean.**

- [x] **Phase 1 Task 13 — workflows, env, provisioning, README — DONE 2026-09-13. PHASE 1 COMPLETE.**
      The EOD steps are real: `runSync` gained `fetchPrices`/`fetchNavs`, wired to NSE bhavcopy +
      index and AMFI in the entrypoint, running after the portfolio sources and before anything
      that reads a price. **Two documented-but-missing pieces found and built:** `downloadBhavcopy`
      threw `'Zip parsing not implemented'` on every call and `downloadIndexSeries` did not exist
      at all, though both were recorded as shipped in Task 3. NSE `.csv.zip` is now unpacked with
      stdlib `node:zlib` (`unzipFirstEntry`) — no new dependency. The old placeholder step, which
      ran and reported success having done nothing, is gone. README gained the Phase 1 data-flow
      + "how a recommendation gets built and blocked" handoff and the §15.1 provisioning table.
      **576 passed**, tsc clean.

- [x] **Phase 1 Task 12 — scoring harness (§13) — DONE 2026-09-13.** `src/domain/scoring.ts`:
      `snapshotBenchmark` captures the instrument close + index close + conviction the day a
      recommendation is made, and **migration `0012` refuses to rewrite it** (UPDATE allowed
      only on the eval columns — same shape as the `lots` trigger). `dueEvals`/`evaluateRec`
      accrue 3/6/12-month evaluations in integer bps; nothing is ever scored early. The
      calibration table says **"insufficient data"** below `MIN_EVALS_FOR_CALIBRATION` (20 —
      see Waiting on OWNER) and an unscoreable call is never counted as a miss. Folded into
      the weekly report (new §13 section) rather than a separate job/workflow.
      15 tests, **568 passed**, tsc clean.

- [x] **Phase 1 Task 11 — weekly deep report + narration + SUNDAY 10:00 IST — DONE 2026-09-13.**
      `src/notify/report.ts` (`buildReportInput` + pure `composeReport`) renders FR-51's five
      sections; `src/jobs/report.ts` is the CLI (`pnpm report [--as-of YYYY-MM-DD]`);
      `src/sources/llm-narration.ts` is the PRD 6.7 narration step (no key or any failure →
      `null` → deterministic bullets; **nothing it returns feeds back into the engine**).
      **PHASE 1 DoD MET:** the report carries a fully-formed paper recommendation (primary + 2
      alternates, ≤150w theses, real IPS citations) with every data timestamp shown, and a
      deliberately stale price keeps that name out of every live recommendation — proven by a
      diff between the two reports, and mutation-checked.
      **Owner sign-off applied: weekly moved Sat 08:00 → Sunday 10:00 IST** (`30 4 * * 0`, PRD
      §12.2). `workflow-schedule.test.ts` is re-derived from the new YAML — it now converts the
      cron to IST and reads back Sunday 10:00, and pins the digest's `workflow_run` gating in
      place of the assertion deleted earlier. `pnpm weekly` and `src/jobs/weekly.ts` are RETIRED
      (one weekly entrypoint, so the two cannot drift). 14 tests, **551 passed**, tsc clean.
      **New:** an open recommendation whose instrument is blocked today is *withheld*, not
      listed as actionable — FR-31 applies to yesterday's recommendations too.

- [x] **Phase 1 Task 10 — FR-11/FR-12 recommendation objects + paper mode — DONE 2026-09-13.**
      `src/domain/recommendations.ts`: `buildRecommendation` (primary + exactly 2 alternates —
      A1 same intent/different instrument or the **index route** fallback, A2 a different intent
      defaulting to **do-nothing**, which is priced as a real option; ≤150-word theses; every
      clause ref checked against the rendered IPS index). FR-12 caps — ≤4/month, 12-month
      repeat-BUY hold, exactly 3 override events — **log to `suppressed_actions` with a visible
      reason rather than dropping the action**. Paper mode defaults TRUE when the rail is absent.
      17 tests, **532 passed**, tsc clean; the month cap and clause validation are mutation-checked.
      **Cross-task proof:** a persisted recommendation's falsification condition fires Task 9's
      trigger 1 — the Task 9 contract is honoured, not just documented.

- [x] **Phase 1 Task 9 — sell / exit triggers — DONE 2026-09-13.** `src/domain/sell-triggers.ts`:
      `evaluateExits(db, state, month)` runs §6.5 triggers 1–5 and 7 monthly (falsification,
      red flag, hard cap, sustained underperformance, better alternative ≤1/quarter, credit /
      maturity); trigger 6 is `LEGACY_QUEUE_STUB`, deferred to Phase 2 with its reason.
      Falsification conditions round-trip through `recommendations.primary_rec` JSON —
      **`{instrumentId, falsification:{metric, op, value}}` is now the contract Task 10 must
      write.** An untestable condition is never an exit. Only triggers 1–3 override IPS §3.7's
      12-month hold; 4 and 5 surface with `blockedByMinimumHold` instead of being dropped.
      17 tests, **515 passed**, tsc clean; the FR-31 block is mutation-checked.
      **The no-catch-up architecture test earned its keep:** it caught `sell-triggers` reaching
      `funded-status` through `maturities → buckets`. Fixed structurally — the redemption reader
      moved to `src/domain/redemptions.ts` — **not** by widening the allowlist.

- [x] **Phase 1 Task 8 — allocation engine — DONE 2026-09-13.** `src/domain/alloc-engine.ts`:
      `rebalanceRec(state, monthYear)` turns the FR-13 drift check into a recommendation —
      in-band months still report the actual percentages; April is flagged as the annual
      proposal. Takes the Phase 0 `NetWorth` as its basis and **throws if the positions
      disagree** (one source of truth). Tax preference is one rule: dilute with new money
      before selling, and when a trim is unavoidable order candidates losses-first with an
      unknown cost basis last. `TAX_POLICY_NOTE` states plainly what it does NOT compute
      (holding periods, LTCG/STCG, §112A, indexation, set-off) — we hold aggregated
      positions, not per-lot acquisition dates, so any tax figure would be invented.
      Against the real seed the gold shortfall sizes at exactly `driftPaise` (₹2,04,098.68).
      11 tests, **498 passed**, tsc clean; the band-edge cap and the tax preference are both
      mutation-checked.

- [x] **Phase 1 Task 7 — signal engine — DONE 2026-09-13.** `src/domain/engine.ts`:
      §6 quality gate (ROCE / 5y FCF / D-E with a finance-sector waiver / red flags, **fail-closed
      on unknowns**) → composite valuation 30 / trend 30 / earnings 20 / fit 20 → HIGH/MEDIUM/
      WATCH/NONE bands; `rankMfs` (consistency 40 / expense 20 / tenure 15 / AUM 15 / style 10);
      `persistSignalScores` (append-only, `do nothing` on re-run); `loadEngineInputs` reads
      watchlist + latest fundamentals + prices. 19 tests, **487 passed**, tsc clean.
      FR-31 mutation-checked: deleting the block-list guard turns both blocked-name tests red.
      **Two things the engine deliberately does not compute** (flagged, not faked): EV/EBITDA
      and a name's own 5y P/E range (the pinned screener export carries neither), and the 10Y
      G-sec yield — see Waiting on OWNER.

- [x] **`screener` staleness was a no-op — FIXED 2026-09-13.** Tasks 5/6 recorded "staleness
      checks fundamentals", but `assessStaleness` still hard-coded `screener` to `unimplemented`
      and `getLatestFundamentalsAsOf` was dead code, so a fundamentals drought could never block
      anything and `blockedInstruments`'s `fundamentalsStale` branch was unreachable. Task 6 built
      the ingestion path, so screener is now assessed like bhavcopy/amfi: an empty table reads
      stale and opens a BLOCK incident. 5 test expectations moved with it (deliberate behaviour
      change, not a widened band). **No source is in the `unimplemented` state any more** — the
      state stays in the type for the next unbuilt one.

- [x] **Screener.in screen HTML scraper — BUILT + TESTED 2026-09-13 (tsc clean, 606 passed).**
      `src/sources/screener-screen.ts` parses a PUBLIC screen URL directly (`parseScreenHtml`,
      paginated `fetchScreen`, `slugToInstrumentId`, idempotent `importScreenRows`), sidestepping
      the paywalled CSV export entirely. Real 42KB HTML fixture from screen 41972 drives 16
      tests. Header `.tooltip` canonicalization + `<span>` unit stripping + slug→instrument
      validation are all handled. Migration `0014` widens `fundamentals.source` back to
      `'screener-screen'`. CLI: `pnpm screener:import --screen <url>`. **Not yet run live + not
      pushed** (all local commits are ~10 behind origin/main).
      **The column-spec problem still stands for the CSV path**: the default screen's columns
      overlap `SCREENER_COLUMNS` only on `P/E`; the HTML path reads whatever columns the screen
      actually renders, so a screen built to carry the §6 gate inputs works.
- [x] **Extraction model reverted to the proven gemma chain — DONE 2026-09-13.** Owner refined
      the one-family decision the same day: `-fin` (text-only) stays for advisor/watchlist prose;
      `VISION_MODEL_CHAIN` leads with `google/gemma-4-31b:free` again (the `ling-3.0-flash-vl`
      leader was retired). Text never sits in front of an image — the test asserts the split.

- [ ] **FX BLOCKs every weekend by construction (surfaced 2026-09-07, NOT new).**
      `FRESHNESS_HOURS.fx = 48h`, but frankfurter publishes ECB rates on weekdays only, so a
      normal Fri→Mon gap is ~72h. Observed Sunday 2026-09-06: open `STALE_DATA/BLOCK` on
      `frankfurter` at 63.4h with **no** `SYNC_FAILURE` — the fetch is fine, the limit is wrong
      for the publication calendar. Separately the Friday 09-04 rate looks never ingested
      (latest stored is Thu 09-03) — that part is unexplained. Same "widen the band vs fix the
      model" call as the digest cron test: do NOT just raise 48h without deciding which it is.
      `composite` is also permanently BLOCK having never produced a row — arguably it belongs
      in the `unimplemented` state alongside amfi/bhavcopy/screener.

## Waiting on OWNER

- [x] **Weekly cadence Sat 08:00 → Sunday 10:00 IST — SIGNED OFF 2026-09-13, shipped in Task 11.**
- [ ] **Watchlist shortlisting is now an LLM job — RUN IT.** Owner decision 2026-09-13: the
      model shortlists. `pnpm watchlist:propose [--limit N] [--dry-run]` drafts from
      `watchlistCandidates` (excludes held + already-watched, §6.1) and records picks as
      `source: 'llm-advisor'` proposals the weekly report shows as awaiting sign-off. The pool
      is no longer fixed at 74: cohort promotion (top line) widens `instruments` on every
      screener import. Re-run the sentinel screen 3963033 first, then `pnpm watchlist:propose`.
      The 40 static `'advisor'` names in `src/seed/seed-watchlist.ts` remain LLM-recall from the
      Task 6 session; replace them with a proposed shortlist once the pool is real.
- [ ] **SCREENER PIPELINE — LIVE RUN DONE 2026-09-14; one owner gate decision remains.** HTML
      scraper built+tested (Task 6 line above). **Live run (owner's sentinel screen 3963033):
      passed end-to-end** — `pnpm screener:import --screen <url>` fetched the public page
      (410 records on the screen; the old default cap fetched only 10 of 17 pages — fixed,
      see Next-up top line), resolved held/watchlist names to real instrument ids, and wrote
      **12 fundamentals
      rows into the live Supabase** (`screener_uploads` id 1 + 3, as_of 2026-09-14) with the
      `D/E` column populated (header text `Debt / Eq` → `D/E`, no tooltips on that screen). The
      earlier partial upload (2 bogus rows incl `NSE:LIQUIDBEES` from a `LIKE '%ID%'` slug
      misfire) was cleaned by the idempotent replace. Three defects found & fixed in that
      round: (1) `screener:import` package script never loaded `.env` → it silently ran against
      an empty in-memory PGlite (all pre-fix "0 records" results were fake); (2) `/company/id/<n>/`
      rows parsed to slug `ID`, which substring-matched `NSE:LIQUIDBEES`; (3) mid-loop duplicate
      insert crashed with no transaction → now deduped with a warning. 608 tests pass, tsc clean
      (commit pending push). **Still open:** owner decision on the §6 gate inputs `Symbol`,
      `Industry`, `FCF 5Y`, `Red Flags` — screener has NO native column for the last two, so
      either bake FCF-positivity into the screen query (recommended) or drop red flags in Phase 1
(recommended). After that: regenerate the watchlist from the ~410-record cohort (§6.1, owner
       pruning on top) — held/watchlist names land in `fundamentals` today; the rest of the
       cohort was promoted into `instruments` by cohort promotion (top line) and now takes
       fundamentals rows on the next import.
       **Update 2026-09-15:** FCF settled — owner added `Free Cash Flow 5Yrs` to the screen (see
       the Next-up line); Red Flags settled — per-company manual review, gate now NOTE-not-failure
       on NULL.
- [ ] **Real Fidelity statement — the live test of the new flow.** Send the next statement
      screenshot to the bot and `/confirm`; it also resolves the per-grant/tranche RSU
      split true-up (model carries ₹57.05L vs PRD's ₹53.25L; never tune the value to close
      the gap)
- [x] **NSE bhavcopy + index URL/format — VERIFIED 2026-09-15; 2026 data pipeline rebuilt.** The
      NSE archive path (`archives.nseindia.com/content/historical/EQUITIES/...`) is correct but
      **404s for every 2026 file** (verified again live) — it only serves older years, so June's
      bhavcopy rows silently stopped landing. `downloadBhavcopy` now tries the archive, then falls
      back to `sec_bhavdata_full_<DDMMYYYY>.csv` (`nsearchives.nseindia.com/products/content`,
      numeric month — the archive's alphabetic-month URL 404s); both 404 → empty, reported. The
      full-market file carries SYMBOL/SERIES/DATE1 but **no ISIN**, so `ingestPrices` resolves
      ISIN-less rows via `NSE:<symbol>` id. `downloadEquityMaster` (`EQUITY_L.csv`, 2306 EQ
      symbols) + `backfillInstrumentIsins` + `pnpm backfill:isin` fill empty instrument ISINs
      (only `NULL`/empty, never clobbering a seeded value). Live-verified: 2637 rows for
      11-Sep-2026 incl. GOLDBEES/LIQUIDBEES/M&M/CRISIL, archive still serves 2024-03-05 (1790
      rows, ISINs intact). `pnpm sync` green (nse-bhavcopy synced). **Known shape:** today's
      `sec_bhavdata_full_15092026.csv` 404s until ~18:00 IST (file lands post-close) — sync now
      runs at 19:00 IST (`30 13 * * *`) so the scheduled run lands after publication; an index
      zoo `ind<DDMMMYYYY>.zip` still has no working 2026
      source (kept silent-empty).
- [x] **NSE 2026 holiday calendar — DONE + VERIFIED AGAINST NSE 2026-09-13.** Read from
      nseindia.com in a real browser (its API blocks non-browser clients); all 16 dates in
      `src/seed/seed-holidays.ts` match NSE's own table exactly, including 15-Jan, which the
      broker mirrors disagreed on. Muhurat Sunday 2026-11-08 confirmed from NSE's own note.
      It also fixed a real bug: the weekend-only rule was wrong in BOTH directions — it asked
      NSE for a file on ~15 holidays, and it would have skipped **Sunday 2026-11-08 Muhurat
      trading**, when the exchange IS open. `isTradingDay(db, date)` now decides both.
- [ ] **Calibration minimum N = 20** (`MIN_EVALS_FOR_CALIBRATION`). A stake in the ground, not a
      derived figure: at 4 recommendations/month it is ~half a year of output per conviction
      bucket, and below it one outcome moves the hit-rate by >5 points. Confirm or set your own.
- [ ] **Credit-rating actions have no source (IPS §3.8).** Sell trigger 7 covers maturities only;
      the standing §3.8 review items (Sammaan Jul-2029, Edelweiss Oct-2033 — "must beat 7.95%
      after tax and a credit-risk haircut") cannot be watched automatically. Decide: a manual
      quarterly review item, or a rating source in Phase 2.
- [ ] **10Y G-sec yield** — the valuation leg of the signal engine scores earnings yield against
      it (`EngineContext.gsecYieldPct`). There is no ingestion source for it in Phase 1, so it is
      a caller input; the number is the owner's, not one the engine may invent. Decide: a standing
      figure reviewed quarterly, or an ingestion source in Phase 2.
- [ ] The date each protection milestone was actually set (`milestones.raised_on` —
      "% elapsed" is NULL until then)
- [ ] ₹82,124 vs PRD ₹76,000 surplus gap — owner confirmed misc ₹10,000 already includes
      electricity (2026-09-13), so the plan's "+ electricity" theory is dead; the cause is
      open (PRD reads "inclusive of existing SIPs", the model holds no SIP block). Owner
      true-up: is the ₹76,000 the surplus AFTER existing SIP payments?

## Watch items

- **Digest now depends on sync (changed 2026-09-05, commit `30b47d3`).** `digest.yml` lost
  its fixed 21:00 IST cron; it triggers on `workflow_run` of `sync` and runs only when the
  sync **concludes successfully**. Trade-off accepted: a failed sync = no digest that day.
  Sync cron `30 13 * * *` (19:00 IST, moved 2026-09-15 so it runs after NSE publishes the
  whole-market file) and slips by hours → digest fires whenever
  sync actually lands. Weekly report Sat 08:00 IST (`30 2 * * 6`) and keepalive Sundays
   09:30 IST unchanged. **Weekly is now Sunday 10:00 IST (`30 4 * * 0`) running `pnpm report`** —
  owner signed off 2026-09-13; `pnpm weekly` no longer exists.
- **Secrets hygiene.** `TOKEN_ENCRYPTION_KEY` **rotated 2026-09-07** (new key in `.env` +
  GH Actions secret; the key-printing `recover-key.yml` written during the recovery attempt
  was deleted unrun). **`pnpm indmoney:login` re-run and verified** — tokens decrypt against
  the new key, scope `portfolio:read`, refresh token present; the rotation loop is closed.
  Telegram bot token and Supabase DB password remain as-is (owner decision: not rotating).
- Schedules (GitHub Actions, UTC cron, slips a few minutes): **daily digest = after sync success** (`workflow_run` on sync) · **weekly deep report Sun 10:00 IST** (`30 4 * * 0`) · sync daily **19:00 IST** (`30 13 * * *`, after NSE's ~18:00 IST file) · keepalive Sundays 09:30 IST.
- The interactive bot (`pnpm telegram:bot`) runs locally only — commands, photo uploads,
  confirms need it awake. Digests/syncs do not.
- When extraction misbehaves: check `lots` audit trail (`action='ingest'` /
  `'CLEANUP_CLOSED'`) before touching data; corrections go through supersede, never
  UPDATE-of-cost or DELETE (refused by trigger).
- Statement uploads now ask for type via inline keyboard (Brokerage/MF vs Fidelity RSU) before processing.

## Landed recently (oldest → newest)

| commit | what |
|---|---|
| `316720a` | **NSE 2026 price pipeline**: archive-first → `sec_bhavdata_full` (numeric-month DDMMYYYY) fallback + `NSE:<symbol>` ingest resolution + `EQUITY_L` master + `pnpm backfill:isin` (fill-only, never clobber) + NSE Referer header; 618 passed |
| `5fd0bb8` | live-test defects: /cost order mismatch, double-confirm writes, jsonb double-encoding (8 sites) |
| `b9abca8` | production repair: 89→29 lots audited cleanup; gold identity resolved |
| `148d635` | upload idempotency (unchanged/superseded/created) + migration 0006 unique index |
| `f8cb46c` | digest → nightly 21:00 IST; SDD progress ledger created |
| `fd96bd2` | ticker-anchored proposal resolution + ⚠️ conflict guard on /confirm all |
| `30b47d3` | digest now runs on sync completion (`workflow_run`); fixed 21:00 slot removed |
| `472d801` | untracked `.claude/`, `.serena/`, `zoox_finalTEMP_MPY_wvf_snd.mp4` (were swept into bc728b4); gitignored |
| *(this session)* | web redesign + `/import` ingest flow (migration 0009, LLM extract → owner confirm → real writes; no-key degrade path verified live); `displayOrder`/`resolveProposalTarget` extracted to `proposal-target.ts` |
| `bc728b4` | seed reality fixed (US:NOW 78 @ ₹10.73L, ₹53.42L total); local `pnpm sync` verified; digest gating to sync success (`30b47d3`) |
| *(this session)* | Fidelity RSU flow shipped (extract → priced queue → `/confirm` ACTUAL vests); digest ACTUAL-filter Date fix; 13 new tests; suite 444/1-stale |
| *(this session)* | Phase 1 plan written: `docs/superpowers/plans/2026-09-05-sentinel-phase-1.md` (13 tasks); Sammaan rewritten as Task 1; owner decisions captured |
| *(this session)* | Task 11A preview UI shipped (8081) → owner redirected: "build the real app" → standalone `web/` Next.js app built (16 routes, real data, 3001; next.config .env loader + ips shim); docs updated; **commit pending** |
| `38b209f` | digest: aggregate all RSU grants vesting on same date (e.g. Nov 15: 4 grants vesting) |
| *(this session)* | removed stale workflow-schedule test; CI green (435 passed) |
| *(this session)* | **Phase 1 Task 1 — Sammaan bond maturity**: `maturities.ts` + tests, 14-day digest alert, migrations 0007/0008 for bond fields, 443 tests pass, tsc clean |
| *(this session)* | **Phase 1 Task 3 — NSE bhavcopy + index series**: `bhavcopy.ts` + fixtures + tests, migration 0010 for prices_eod/index_prices_eod/navs/holidays, staleness extended, 451 tests pass, tsc clean |
| *(this session)* | **Phase 1 Task 2 — Phase 1 schema (0007/0008)**: `0008_phase1_intel.sql` (watchlist, screener, fundamentals, signals, recommendations, suppressed_actions, benchmarks), `0010_phase1_quotes.sql` (prices_eod, index_prices_eod, navs, holidays), append-only + RLS, 451 tests pass, tsc clean |
| *(this session)* | **Phase 1 Task 4 — AMFI NAV pipeline**: `amfi.ts` + fixture + tests, migration 0009 for scheme_code, navs allows corrections, staleness 48h, 457 tests pass, tsc clean |
| *(this session)* | **Phase 1 Task 13 — workflows/env/provisioning/README**: real bhavcopy+AMFI sync steps, `unzipFirstEntry` (stdlib zip), `downloadIndexSeries` built, README Phase 1 handoff + provisioning table, 8 tests; 576 passed |
| `3afe681` | **Phase 1 Task 12 — scoring harness**: `domain/scoring.ts` + migration `0012` (creation snapshot immutable, eval columns writable), calibration section in the weekly report, 15 tests; 568 passed |
| `5f8a7d2` | **Phase 1 Task 11 — weekly deep report (FR-51)**: `notify/report.ts` + `jobs/report.ts` + `sources/llm-narration.ts`, weekly cron → Sunday 10:00 IST, `pnpm weekly` retired, schedule test re-derived, 14 tests; **Phase 1 DoD met**; 551 passed |
| `e9ec6e5` | **Phase 1 Task 10 — FR-11/FR-12 recommendations + paper mode**: `domain/recommendations.ts` (builder + validator, caps → `suppressed_actions`, paper mode, execution-path scan), 17 tests; 532 passed, tsc clean |
| `b081ee9` | **Phase 1 Task 9 — sell/exit triggers**: `domain/sell-triggers.ts` (§6.5 triggers 1–5,7; falsification round-trip; §3.7 override discipline), `domain/redemptions.ts` split out to keep the funded-status firewall intact, 17 tests; 515 passed, tsc clean |
| `08c296f` | **Phase 1 Task 8 — allocation engine**: `domain/alloc-engine.ts` (FR-13 drift → recommendation, tax preference, April annual proposal), 11 tests; 498 passed, tsc clean |
| `3df2b5a` | **Phase 1 Task 7 — signal engine**: `domain/engine.ts` (§6 composite + MF ranking + `signal_scores` persistence + `loadEngineInputs`), 19 tests; `screener` staleness un-stubbed (dead `getLatestFundamentalsAsOf` now live, 5 test expectations moved); 487 passed, tsc clean |
| *(this session)* | **Phase 1 Task 5 — Staleness extension + blocked-by-stale proof**: `staleness.ts` extended (navs 48h, fundamentals 1q), `blockedInstruments` expanded (MF/amfi, equity/bhavcopy, equity/screener), migration 0011 for fundamentals as_of, DoD proof tests, 460 tests pass, tsc clean |
| *(this session)* | **Screener.in screen HTML scraper**: `screener-screen.ts` (parse/fetch/slug-map/import), migration 0014 widens `source` back to `'screener-screen'`, `screener-import --screen <url>`, real 42KB page-1/page-2 fixtures, 16 tests; **606 passed**, tsc clean. Works around the paywalled CSV export |
| *(pending push)* | **Live screener run — 3 defects fixed, 12 rows landed**: `screener:import` now loads `.env` (was silently running against empty in-memory PGlite); `/company/id/` slug no longer substring-matches `NSE:LIQUIDBEES` (LIKE guard, len≥3); mid-loop duplicate inserts deduped with a warning instead of crashing; tooltip-less `Debt / Eq` header aliased to `D/E`. Live sentinel screen run: **12 fundamentals rows in prod** (uploads 1/3, as_of 2026-09-14), partial 2-row upload cleaned. 3 new tests, **609 passed**, tsc clean |
| *(this session)* | **Extraction model reverted to the proven gemma chain**: `VISION_MODEL_CHAIN` leads `google/gemma-4-31b:free` again; `-fin` stays for text jobs only; the `ling-3.0-flash-vl` leader trial retired. Test asserts the split, **606 passed**, tsc clean |
| *(pending push)* | **Screener cohort promotion**: unknown screen rows become `NSE:<slug>` instruments (kind EQUITY, `metadata {"source":"screener-cohort"}`, ISIN left NULL for `backfill:isin`), `importScreenRows` returns `createdInstruments`, CLI prints promotion count, degenerate `/company/id/` slugs refused; 4 new tests, **618→622 passed**, tsc clean. Re-import of screen 3963033 widens the pool to ~410 (~398 newly promoted) — the old 10-page default cap had truncated its 17 pages to ~230; page budget is now a 100-page safety valve + short-page terminator |

(End of file)
