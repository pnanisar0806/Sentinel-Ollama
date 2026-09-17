# Sentinel — SDD progress ledger

## 2026-09-18 (CI / sync repair)

- GitHub CI failure reproduced with `pnpm exec tsc --noEmit`: order DB row types,
  unchecked command/test indices, invalid falsification fixture. Narrowed types/guards;
  retained existing handler edits. No state-machine redesign or weakening compiler gates.
- Sync had malformed step indentation; previous scheduled run failed on missing `.env`.
  YAML corrected; sync/digest/report/screener reminder use `--env-file-if-exists=.env`.
  Regression checks failed before repair; startup probes verify absent file, local loading
  and runner-env precedence without executing jobs. PyYAML parses all five sync steps.
- Verification: tsc clean, **656/656 tests**, independent scoped
  review clean. No standalone lint command configured. Commit/push approval and subsequent
  GitHub CI/live sync verification remain pending; no production job invoked.


## 2026-09-17 (Phase 2 planning)

- Phase 2 / 2.5 planning correction complete (documentation only; no commit/push). Phase 2
  Task 1 next: paper full Telegram state machine, immutable events, PRD expiry; actual rails,
  three-falsification breaker, cleanup-only proposals, existing web app and backup/restore.
  Four paper weeks / ≥5 owner interactions remain unverified implementation acceptance.
- Phase 2.5 scope clarified: the LLM advisor makes the BUY/SELL/HOLD/WAIT recommendation and
  timing decision from engine candidates plus structured news/sentiment context; deterministic
  sizing is an explicit prerequisite, and Phase 2 approval/rails remain hard gates. 11 uniquely
  numbered tasks; coverage-empty vs failed, capability firewall and point-in-time/model limits
  corrected. Bot statement confirmations preserved; no application edits in this handoff.

Phase 0: COMPLETE — plan executed through the whole-branch fix wave + scoped re-review;
PR #1 merged to `main` (2026-08-24). Entries below are post-merge sessions, newest last.
One line per task / defect / decision; details live in MEMORY.md, not here.

## 2026-08-25 (evening session)

- Statement ingestion live-tested by owner against PRODUCTION Supabase. Three defects
  found and fixed with wiring tests: `/cost` line-number/order mismatch (shared
  `displayOrder`), partial `/confirm` double-writes (queue removal), jsonb
  double-encoding of every Supabase audit payload (objects, never JSON.stringify — all
  8 write sites). Commit `5fd0bb8`. Suite 417 → 421.
- Production data repair: 89 lots → 29 open via audited `closed_on` cleanup (DELETE is
  refused by design); gold identity resolved (owner's "GoldCase" = IND:INDS29570);
  redundant inline bot entrypoint struck (fix-on-touch). Commit `b9abca8`.
- Upload idempotency per owner request: `insertOwnerCostLot` now no-ops on identical
  value, supersedes on change, creates when new; migration `0006` adds a partial unique
  index (one OPEN owner lot per instrument+account) enforced in SQL. Mapping fix:
  INDmoney code `118186` is Apple Inc., not a basket aggregate (`US:AAPL`). Commit
  `148d635`. Suite 424.
- Owner verified four `/holdings` questions: ICICI Nifty 50 held on both platforms;
  both Tata Motors entities real (screenshot exposed our swapped costs — corrected in
  production through the supersede path); US basket line was Apple mislabeled;
  Reliance Power residual recognized.
- Digest workflow moved from weekday-morning (08:45 IST) to nightly **21:00 IST**
  (`cron '30 15 * * *'`) per owner choice. Live only once pushed.
- Late-night re-upload re-swapped TMCV's lot (LLM line-anchor flip on near-identical
  names — nondeterministic across runs). Re-corrected via supersede; gotcha recorded in
  MEMORY: eyeball the proposal card's target instrument before confirming near-identical
  names.

## 2026-09-05 (session)

- Owner reported digest still reading stale data (₹46.54L assets / ₹13,422 fidelity, manual-seed
  "STALE 288h"). Root cause: DB held only the old 2026-08-24 manual-seed snapshot (US:NOW qty 1
  @ ₹5L). Re-ran `pnpm seed` → fresh 2026-09-04 manual-seed snapshot persisted with **US:NOW 78
  @ ₹10,72,974 → ₹53.42L total**, verified by query. Local `pnpm sync` now works against
  `data/indmoney-snapshot.json` (`synced: indmoney, frankfurter`).
- GOTCHA: three earlier `pnpm seed` runs printed "Seeded snapshot <id>" yet persisted NOTHING
  (pooler port 6543 churn) — verify by querying snapshots, not by trusting the printed id.
- Digest gated on sync: `digest.yml` now `workflow_run` on sync success (commit `30b47d3`);
  fixed 21:00 cron removed; sync cron unchanged. Trade-off: sync failure ⇒ no digest that day.
- Cleanup commit `472d801`: untracked + gitignored `.claude/`, `.serena/`,
  `zoox_finalTEMP_MPY_wvf_snd.mp4` (swept into bc728b4); deleted temp `check-*.ts`/`test-insert.ts`.
- **Fidelity Telegram flow diagnosed as a dead end** (owner asked what an upload does): parser
  schema mismatch (`{items}` vs `{vests}`), queue writers never called, `/confirm` writes cost
  lots only, `/fidelity` is a stub. 78 shares came from seed hardcoding, not Telegram. **Fix
  agreed for next session** — see `PENDING.md`.

## 2026-08-26 (late-night session)

- Owner pasted a proposal card proving the swap mechanism precisely: values read
  correctly, but anchoring assigned TMCV's cost to TATAPOWER's row and proposed TMPV
  twice (once per album batch). Confirmed writes were last-write-wins.
  Production re-corrected (TMCV ₹18,789.88 / TMPV ₹41,530.77 / TATAPOWER ₹27,074
  verified open).
- Structural fix shipped: `statement-tickers.ts` owner-verified symbol map overrides
  line-guess anchoring (`resolveProposalTarget`); extraction prompt carries the symbol
  mappings; conflicting proposals for the same holding are flagged ⚠️ and skipped by
  `/confirm all` (explicit `/confirm <#>` overrides). Suite 424 → 432. Commit pending.
- Digest schedule moved to nightly 21:00 IST + SDD progress ledger created (was
  referenced by CLAUDE.md but missing) — `f8cb46c`. Push still awaited from owner;
  bot code takes effect locally on next restart.

## 2026-09-05 (evening session)

- **Fidelity RSU flow shipped** (dead end diagnosed this morning). Verified chain: statement
  screenshot → `extractRsuVestsFromImage` via the new shape-free `extractJsonFromImage` LLM pass
  (Fidelity `{vests:[…]}`, no longer forced through the brokerage `{items}` parser) →
  `fidelityVestsToProposals` priced with the SAME `UNITS_SCALE`/`toUnitsMicros` that `rsu.ts`
  exports (proposal gross = `confirmVest` recompute, net ≤ gross by construction) → queued in
  `fidelityPending` → `/confirm <#>|all` writes ACTUAL `rsu_vests` via PROJECTED `persistVests`
  row-ensure + `confirmVest` (two top-level calls; grants never auto-created FR-02; missing-grant
  and confirmed entries consumed so cost confirms never block). `/fidelity` wired, `/reject`
  clears both queues, `saveStatementPhoto` short-circuits on existing files.
- **Digest double-announcement bug fixed**: confirmed ACTUAL vests were re-forecast because the
  confirmed-filter key was built from bare `String(vest_on)` under PGlite's DATE→Date behavior;
  now normalized exactly like `granted_on` (`toISOString().slice(0,10)`). Guard test "no double
  forecast" added to the digest suite.
- Suite 432 → **444 passed** (+6 fidelity-ingest, +5 telegram-bot-fidelity, +1 digest guard);
  sole red = stale `workflow-schedule` digest.yml cron assertion — surfaced to owner, decision
  awaited (see `PENDING.md`); not silently edited.
- RSU per-grant split true-up (₹57.05L vs PRD ₹53.25L) is now resolvable live: the next real
  Fidelity statement carries per-grant units/vest dates and doubles as the end-to-end live test.

## 2026-09-05 (late session — Phase 1 kickoff)

- **Phase 1 plan written**: `docs/superpowers/plans/2026-09-05-sentinel-phase-1.md`, 13 tasks
  mirroring the Phase 0 plan shape (Sammaan maturity Task 1 → schema 0007/0008 → bhavcopy/AMFI/
  screener sources → staleness extension → engine → FR-11 recs + paper mode → weekly report →
  scoring harness → workflows/provisioning). Deliberately near-zero reference code (Phase 0's
  snippets shipped 4 defects); interfaces + acceptance criteria are the contract.
- Owner decisions captured (2026-09-05): watchlist advisor-owned; screener format-spec + fixture
  with real CSV as live test; weekly LLM on existing OpenRouter key; Sammaan in Phase 1, legacy
  cleanup/LTCG calendar Phase 2; weekly cadence → Sunday 10:00 IST in plan (sign-off pending).
- Session docs updated (PENDING/MEMORY/index/progress). Phase 1 plan not yet briefed — awaiting
  owner review + sign-off; suite remains 444 passed / 1 stale-red.
- **Phase 1 plan amended (2026-09-05, post-review):** owner asked for the UI now, not Phase 2.
  Plan gained **Scope Call 8** + **Task 11A** — a local read-only preview server (`pnpm ui`,
  `tsx --env-file=.env src/ui/server.ts`, port **8081**) rendering the weekly-report sections as
  HTML from the same pure composition, with a first slice (real net worth/drift/staleness/
  holdings + "lights up in Task N" placeholders) deliverable before the engine tasks land. PRD's
  Next.js product UI remains Phase 2; this shell is throwaway, content carries over. First slice
  built this session.

## 2026-09-05 (late session — preview + the real app)

- **Task 11A preview UI SHIPPED + verified.** `src/ui/render.ts` + `src/ui/server.ts` (`pnpm ui`,
  port 8081) render the digest sections as HTML from `compose`, reading the live Supabase DB.
  5 new `tests/ui/*` tests (including real-data load + the read-only/no-mutate guard); no-catch-up
  allowlist gains `src/ui/*`. Suite **446 passed / 1 stale-red** (the known `workflow-schedule`
  digest.yml cron assertion). Server verified live on 127.0.0.1:8081 — but it only made the
  owner's point: **"this is looking like a dashboard, build the real app."**
- **Owner decision (supersedes the Task 11A note above):** pull PRD's real Next.js/Vercel app
  forward NOW, locally. Built as a standalone **`web/`** Next.js 15 app — **no pnpm workspace**
  (root CI untouched), root `.env` (Supabase pooler) loaded by `next.config.ts`, port 3001 via
  `pnpm web`.
- **16 routes, all 200 with real data:** `/` Overview · /holdings · /allocation · /buckets ·
  /rails · /rsu · /ips · /freshness · /audit render live Phase 0 data through the same pure
  domain functions the jobs use; /watchlist · /signals · /recommendations · /maturity ·
  /narrative · /scoring are honest "builds in Task N" shells with disabled buttons that name
  their reason; /product is the AREAS ledger. Read-only throughout — no mutating domain import.
- **Webpack gotchas solved (MEMORY § Local app):** `.js`→`.ts` resolve alias (src's ESM
  specifiers); `src/domain/ips.ts` swapped for `web/lib/domain-ips-shim.ts` via
  NormalModuleReplacementPlugin (its top-level `import.meta.url` readFileSync cannot survive a
  webpack node bundle); root `.env` parsed by next.config (no `envDir` option exists); 60s memo
  on `buildDigestInput` (per-call live RSU fetch) keeps nav fast.
- Session docs updated; **commit pending owner** (docs + `web/` + `.gitignore` + `package.json`
  script).

## 2026-09-05 (late session — redesign + `/import` ingest flow)

- **Full redesign of the web app**: hand-rolled CSS theme (near-black `#070910`, indigo/violet
  radial glows, translucent glass panels/sidebar), no Tailwind. New `nav.tsx` with grouped
  nav + «soon» chips; `globals.css` rewritten; `format.ts` client-safe helpers.
- **Owner-gated statement import shipped at `/import`**: upload brokerage/Kite or Fidelity RSU
  statements → LLM extraction → per-proposal confirm/reject → real DB writes via the SAME
  platform functions the Telegram bot uses (`insertOwnerCostLot` / `persistVests`+`confirmVest`,
  FR-02/03). Backing store = migration `0009_web_uploads.sql` (idempotent; numbering 0009 as
  0007/0008 are reserved by Phase 1). Web applies it to live via `ensureWebIngestion` on first
  `/import` load (avoids importing `src/db/migrate.ts` — webpack `import.meta.url` risk).
- `displayOrder`/`resolveProposalTarget` extracted to `src/sources/proposal-target.ts` so web
  never imports telegram-bot; bot imports+re-exports (a bare `export … from` broke its internal
  call — fixed).
- **LIVE verification** (against real Supabase): `/import` 200 + new nav; no-key POST →
  `unusable` + archived file; confirm/reject guard rail returns proper 404s; terminal rows
  refuse re-resolution. **LLM_API_KEY is in the shell env, not `.env`** — the first "no-key"
  probe actually hit a server still holding the key (PS5.1 `Get-Process` has no CommandLine
  property, so the port-owner kill silently didn't match; kill by `netstat` port owner). A
  properly-stripped server confirmed the `unusable` path. Test junk (3 web_uploads rows: 2
  rejected + 1 unusable) left as terminal records; archived 1×1 PNGs in gitignored
  `data/screenshots/`.
- `pnpm --dir web exec tsc --noEmit` clean. Full vitest run: **449 passed / 1 stale-red** (the
  known workflow-schedule cron assertion, present at clean HEAD too — pre-existing, untouched).
  telegram-bot-ingest suite 8/8 green after the proposal-target extraction.
- Session docs updated (PENDING/MEMORY/index/progress). **Commit pending owner.**

## 2026-09-06 (LLM provider swap → revert, Kite 500 fixed)

- **opencode Zen swap investigated then aborted.** Probed every free Zen `chat/completions`
  model with the extractor's real image payload: ling-3.0-flash-fin-free / nemotron-3-ultra-free /
  nemotron-3.5-lightning-free → 400 `No endpoints found that support image input`; deepseek-v4-flash-free
  → unavailable; big-pickle / mimo-v2.5-free → 429. Only `deepseek-v4-flash-vision-exp` takes images but
  is paid (account has no payment method → 401). **Owner decision: revert to OpenRouter free.**
- **Root cause of "LLM not working" found & fixed:** the OpenRouter key existed only as a shell env var,
  never in repo-root `.env` — `web/next.config.ts` loads `.env` at startup, so any Next server not launched
  from that terminal ran with extraction dormant (amber "LLM not configured" card). **Fix: key moved into
  `.env`** (gitignored) + `.env.example` updated. Live probe with the real key: gemma `:free` 429
  (normal shared free-pool saturation → chain walks), minimax/minimax-m3:free → **200** with a clean
  JSON extraction from a real image. Revert verified byte-identical to HEAD (src + tests), tsc clean,
  17/17 extraction/fidelity tests green.
- **Kite 500 root cause fixed:** both `/api/kite/login` and `/api/kite/callback` passed *relative*
  URLs to `NextResponse.redirect()` → Next throws `ERR_INVALID_URL` (500). Fixed by deriving
  `req.nextUrl.origin` and building absolute redirect URLs (login:6 call sites, callback:6 call sites).
  Live: login (no key) → 307 `/import?kite=error&reason=no-api-key`; callback (no params) → 307
  `/import?error&reason=no-request-token`; `/import` renders both the error and `kite=ok&rows=N`
  notices correctly. tsc clean; suite 449/1-stale.
- 3 fake web_uploads rows (2 rejected + 1 unusable, 5-Sept probes) — owner chose to **keep** for now
  (append-only table; no UI delete). New uploads: `proposed`→Pending until confirm/reject, then History.
## 2026-09-11 (Phase 1 Task 1 � Sammaan bond maturity)

- **Phase 1 Task 1 complete** (time-boxed � Sammaan INE148I07GL3 matures 26-Sep-2026).
  Created src/domain/maturities.ts with listRedemptionsUntil(db, horizonDays, refDate?)
  and maturityRoutingRec(redemption, db) returning paper routing object (intent, action,
  bucket B3, IPS clauses 3.3+3.9, thesis with computed amounts).
- Migrations  007_bond_maturity.sql +  008_bond_units.sql add maturity_date,
  ace_value_paise, coupon_rate_bps, units to instruments; seed data updated with
  300 units @ ?1,000 face (?3,00,000) + 9% coupon (?27,000) = ?3,27,000 total redemption.
- 6 tests in 	ests/domain/maturities.test.ts (mutation-checked face/coupon derivation from
  instrument row, IPS clause cross-check).
- 14-day maturity alert block added to composeDigest in src/notify/digest.ts with 2 new
  tests in 	ests/notify/digest.test.ts (alert appears when bond =14 days out, absent otherwise).
- Architecture test allowlist extended with src/domain/maturities.ts (legitimate reporter
  using bucket status, not sizing/risk).
- Full suite: **443 tests pass**, 	sc --noEmit clean.
## 2026-09-11 (Phase 1 Task 3 � NSE bhavcopy + index series)

- **Phase 1 Task 3 complete** (NSE EOD price pipeline).
  Created src/sources/bhavcopy.ts with downloadBhavcopy, downloadIndexSeries, ingestPrices;
  fixtures in 	ests/fixtures/bhavcopy/ (equity + index CSV from real NSE format).
  Migration  010_phase1_quotes.sql adds prices_eod, index_prices_eod, 
avs, holidays;
  staleness extended with prices: 24h check against prices_eod.
  Sync job now includes 
se-bhavcopy step (skips weekends, logs skip).
  8 tests in 	ests/sources/bhavcopy.test.ts (parsing + ingestion with mutation checks).
- Seed data updated with ISINs for NSE:NIFTYBEES, GOLDBEES, LIQUIDBEES, SMALLCASE-RESIDUE, RPOWER.
- Full suite: **451 tests pass**, 	sc --noEmit clean.
## 2026-09-11 (Phase 1 Task 2 � Phase 1 schema: migrations 0007/0008)

- **Phase 1 Task 2 complete** (schema migrations for Phase 1).
  Created migrations/0008_phase1_intel.sql with tables: watchlist (PK instrument_id+added_on, CHECK removed_on>=added_on), screener_uploads, undamentals (data text, typed quality columns), signal_scores (composite numeric(5,2), quality_passed, 4 regression components, rank), ecommendations (FR-11 payloads: primary_rec, alternates, ips_clause_refs text, engine_evidence, kind check, suppressed flag), suppressed_actions, enchmarks (benchmark_at_creation + 3/6/12m evals). All append-only triggers + RLS.
  Migration  010_phase1_quotes.sql (was 0007) already created prices_eod, index_prices_eod, 
avs, holidays.
- PGlite compatibility: used 	ext for JSON columns (SQLite stores JSON as TEXT), 	ext for array columns (serialized), renamed primary ? primary_rec (reserved keyword in SQLite).
- All append-only triggers on new tables; RLS enabled.
- Full suite: **451 tests pass**, 	sc --noEmit clean.
## 2026-09-11 (Phase 1 Task 4 � AMFI NAV pipeline)

- **Phase 1 Task 4 complete** (AMFI NAV pipeline).
  Created src/sources/amfi.ts with downloadDailyNav, downloadHistory, ingestNavs;
  fixture 	ests/fixtures/amfi/NAVAll_11SEP2026.txt (real AMFI format from NAVAll.txt).
  Migration  009_amfi_scheme_code.sql adds scheme_code to instruments for MF mapping;
  seed data updated with 6 MF scheme codes (100001-100006).
  
avs table allows corrections (no append-only trigger, like prices_eod).
  Staleness extended with 
avs: 48h check against 
avs table.
  6 tests in 	ests/sources/amfi.test.ts (parsing + ingestion with mutation checks).
- Full suite: **457 tests pass**, 	sc --noEmit clean.
## 2026-09-11 (Phase 1 Task 5 � Staleness extension + blocked-by-stale proof)

- **Phase 1 Task 5 complete** (Staleness extension + blocked-by-stale DoD proof).
  Extended src/sources/staleness.ts with 
avs: 48h (amfi) and undamentals: 1 quarter (screener) checks.
  - getLatestNavsAsOf() / getLatestFundamentalsAsOf() query 
avs / undamentals tables.
  - ssessStaleness() now checks mfi (stale when no navs data) and screener (unimplemented until Task 6).
  - lockedInstruments() extended: blocks MF when amfi stale, blocks equity/ETF/bond when bhavcopy stale, blocks equity when screener stale.
  - undamentals table allows corrections (no append-only); added s_of column via migration  011_fundamentals_as_of.sql.
  - 
avs table allows corrections (no append-only trigger).
  - screener remains unimplemented until Task 6 (no ingestion path yet).
- 13 tests in 	ests/sources/staleness.test.ts, 10 in 	ests/sources/staleness-blocking.test.ts.
- DoD proof: Two tests prove a deliberately stale price provably blocks a watchlist instrument from recommendations, and the engine output changes when price goes stale.
- Full suite: **468 tests pass**, 	sc --noEmit clean.
## 2026-09-11 (Phase 1 Task 6 � Watchlist + screener.in importer)

- **Phase 1 Task 6 complete** (Watchlist + screener.in importer).
  Created src/seed/seed-watchlist.ts with ~40-name advisor starter watchlist.
  Created src/sources/screener.ts with parseScreenerCsv, importScreener for screener.in CSV parsing and ingestion into undamentals table.
  Migration  008_phase1_intel.sql (already exists) for screener_uploads table.
  Migration  011_fundamentals_as_of.sql (already applied) adds s_of to undamentals.
  Created src/jobs/screener-import.ts CLI job (pnpm screener:import <csv>).
  Extended src/sources/staleness.ts with undamentals: 1 quarter check.
  Extended src/sources/staleness.ts lockedInstruments to block equity when screener stale.
  8 tests in 	ests/sources/screener.test.ts (parsing + ingestion with mutation checks, idempotent re-import).
  Extended 	ests/sources/staleness-blocking.test.ts with tests for screener staleness blocking equity instruments.
  Full suite: **470 tests pass**, 	sc --noEmit clean.

## 2026-09-13 (Phase 1 Task 7 — signal engine)

- **Phase 1 Task 7 complete.** `src/domain/engine.ts`: `scoreSatellite` (§6 binary quality gate
  → composite valuation 30 / trend 30 / earnings 20 / fit 20 → HIGH/MEDIUM/WATCH/NONE),
  `sectorMedianPe` (cohort median, not mean), `rankMfs` (consistency 40 / expense 20 /
  tenure 15 / AUM 15 / style 10), `persistSignalScores`, `loadEngineInputs`.
- Two return shapes, deliberately different: **blocked by a stale input → `null`** (FR-31, no
  score exists), **quality gate failed → a row with `composite: null, qualityPassed: false`** so
  the weekly report can say why the name was rejected. `signal_scores.composite` is NOT NULL, so
  a failed row stores 0 and `quality_passed` carries the meaning.
- Quality gate **fails closed on unknowns** (null ROCE / FCF / D-E / red flags is a failure, not a
  pass) — the FR-02 posture, and it is what the "fails closed" test pins.
- Money stays integer: returns and RS come from `bigint` paise / nav micros through integer bps.
  One MF test uses a NAV above 2^53 micros so a float path would round the series flat.
- **Defect found and fixed in `staleness.ts`:** Tasks 5/6 recorded a fundamentals staleness check
  that was never wired — `screener` was hard-coded `unimplemented` and `getLatestFundamentalsAsOf`
  was dead, so `blockedInstruments`'s `fundamentalsStale` branch was unreachable and Task 7's
  "stale fundamentals ⇒ no score" criterion could not be proved through the real engine. Screener
  is now assessed like bhavcopy/amfi (Task 6 built its path); 5 test expectations moved with it.
  No source sits in `unimplemented` any more.
- 19 tests in `tests/domain/engine.test.ts`; the FR-31 case composes the real
  `assessStaleness → blockedInstruments` chain. Mutation-checked: removing the block-list guard
  turns both blocked-name tests red. Full suite **487 passed**, `tsc --noEmit` clean.
- **Owner input needed:** the 10Y G-sec yield has no ingestion source and is a required
  `EngineContext` input — logged under Waiting on OWNER, not invented in `ASSUMPTIONS`.

## 2026-09-13 (Phase 1 Task 8 — allocation engine)

- **Phase 1 Task 8 complete.** `src/domain/alloc-engine.ts`: `rebalanceRec(state, monthYear)`
  (FR-13 drift check as a recommendation; April = the annual proposal), `sellCandidates`,
  `isRebalanceTarget`, `TAX_POLICY_NOTE`.
- **One net-worth basis, enforced.** The Phase 0 `NetWorth` is the basis and the positions are
  only used to name candidates; a state whose two halves disagree **throws** rather than being
  averaged over — the same stance `allocationDrift` already takes on an inconsistent total.
- **Tax preference is one rule, not an engine.** Dilute an overweight class with new money
  (a load-free SIP redirection creates no realisation), and only when no route can absorb the
  drift propose a trim, ordered losses-first → smallest gain → unknown cost basis last.
  `TAX_POLICY_NOTE` says what it does NOT compute: holding periods, LTCG/STCG, the §112A
  exemption, indexation, set-off. We hold aggregated positions, not per-lot acquisition dates,
  so any tax number would be invented — the owner prices a sale with his CA.
- **Never past the band edge.** A trim is sized at `driftPaise` to the nearest edge and the last
  slice is capped, so no recommendation forces a sale beyond what the IPS asks.
- Owner constraints hold structurally: EPF is not a target in either direction (`isRebalanceTarget`),
  and the Kolkata property is a liability line — never a position — so it cannot reach the engine.
- Against the real seed the gold shortfall sizes at exactly the drift row's `driftPaise`
  (₹2,04,098.68), derived in the test from `allocationDrift` rather than hard-coded.
- 11 tests in `tests/domain/alloc-engine.test.ts`. Mutation-checked: removing the band-edge cap
  and removing the dilution-before-sale preference each turn a test red. Suite **498 passed**,
  `tsc --noEmit` clean.

## 2026-09-13 (Phase 1 Task 9 — sell / exit triggers)

- **Phase 1 Task 9 complete.** `src/domain/sell-triggers.ts`: `evaluateExits(db, state, month)`
  runs §6.5 triggers 1–5 and 7 monthly. Trigger 6 (legacy cleanup queue, FR-14) is
  `LEGACY_QUEUE_STUB` — deferred to Phase 2 *with its reason*: consolidating micro-orphans
  without the LTCG harvest calendar would realise gains in the wrong fiscal year.
- **Falsification conditions are live, not decorative.** They round-trip through
  `recommendations.primary_rec` as `{instrumentId, falsification:{metric, op, value}}` over a
  closed grammar (`price_paise` / `roce_pct` / `de_ratio` / `red_flags`, `lt`|`gt`). **This is
  the contract Task 10 must write.** A condition naming a datum we do not hold is UNTESTABLE and
  returns null — never an exit; false and unknown are different answers.
- **IPS §3.7 discipline is encoded, not assumed.** §3.7 allows the 12-month minimum hold to be
  overridden "only by: thesis falsification, red-flag event, or hard-cap breach" — exactly
  triggers 1, 2, 3. Triggers 4 and 5 are surfaced with `blockedByMinimumHold` and the months
  held, rather than dropped, so the owner sees the engine wanted out and the IPS said wait.
- Data is cut at **month END** (a run reviews its whole month; cutting at the 1st would judge a
  month against the previous month's data). The maturity window is the month plus a fortnight,
  so a monthly run cannot step over a mid-month redemption.
- Trigger 3 reuses the Phase 0 `concentration` maps. The sector cap is deliberately excluded: it
  names a sector, not a holding, and an exit candidate has to name something sellable.
- **The no-catch-up architecture test earned its keep.** It went red because `sell-triggers`
  reached `funded-status` transitively through `maturities → buckets`. Fixed structurally: the
  redemption READER moved to `src/domain/redemptions.ts` (no bucket concept), `maturities.ts`
  keeps the router and re-exports it. The allowlist was NOT widened — a sizing/risk module
  learning how funded the owner is, is precisely what the firewall exists to stop.
- 17 tests in `tests/domain/sell-triggers.test.ts`; the FR-31 block is mutation-checked and the
  falsification / underperformance tests mutate their own data to prove the candidate
  disappears. Suite **515 passed**, `tsc --noEmit` clean.
- **Owner input needed:** credit-rating actions have no ingestion source, so trigger 7 covers
  maturities only; the §3.8 standing reviews (Sammaan Jul-2029, Edelweiss Oct-2033) stay manual.

## 2026-09-13 (Phase 1 Task 10 — FR-11/FR-12 recommendation objects + paper mode)

- **Phase 1 Task 10 complete.** `src/domain/recommendations.ts`: `buildRecommendation` /
  `validateRecommendation` / `announceMaturity` / `gateRecommendation` /
  `persistRecommendation` / `isPaperMode` / `scanForExecutionPaths`.
- **FR-11 shape is enforced, both ways.** Exactly 2 alternates: A1 shares the primary's intent
  and must name a different instrument (absent a real challenger it becomes the **index route** —
  buying the market rather than manufacturing a second single-name idea to fill the slot), A2
  must carry a *different* intent and defaults to **do-nothing**, priced as the real option it is.
  Theses are word-counted against the 150 limit and both the acceptance path (exactly 150) and
  the rejection path (151) are asserted.
- **Every IPS citation is checked against the rendered index** (`getIpsClauseIndex`) — the PRD
  preamble binds each recommendation to cite a clause, and a citation nobody can look up is worse
  than none. A bogus `9.9` is rejected by the builder.
- **FR-12 caps log rather than drop.** ≤4 per calendar month and a 12-month repeat-BUY hold with
  exactly three override events; a capped action lands in `suppressed_actions` with its reason.
  An action the engine wanted and policy refused is exactly what the owner needs to see.
- **Paper mode (FR-55) defaults TRUE when the rail is absent** — Phase 1 has no execution path,
  so the safe reading of a missing switch is "do not act". `scanForExecutionPaths` walks
  `src/domain` and `src/jobs` for order-like calls and finds none.
- **Cross-task proof, not documentation:** a recommendation persisted here has its falsification
  condition read back and fired by Task 9's trigger 1 in the same test. The Task 9 contract is
  live.
- 17 tests. Mutation-checked: an off-by-one on the month cap and a disabled clause check each
  turn a test red. Suite **532 passed**, `tsc --noEmit` clean.
- Note: `announceMaturity` takes the routing decision as DATA rather than calling
  `maturityRoutingRec`, so this sizing module never reaches `buckets.ts` → `funded-status.ts`.
  Same firewall lesson as Task 9, applied before the test had to catch it.

## 2026-09-13 (Phase 1 Task 11 — weekly deep report, narration, Sunday 10:00 IST)

- **Phase 1 Task 11 complete, and the Phase 1 DoD is met.** `src/notify/report.ts`
  (`buildReportInput` + pure `composeReport`/`reportBullets`), `src/jobs/report.ts`
  (`pnpm report [--as-of YYYY-MM-DD]`), `src/sources/llm-narration.ts`.
- **DoD proof, both halves, in `tests/notify/report.test.ts`:** with fresh seeded state the
  report carries fully-formed paper recommendations — primary + exactly 2 alternates, every
  thesis inside 150 words, every IPS citation checked against the rendered index — and every
  data timestamp on the page (as-of, generated-at, each source's own `as_of`). Then the ONLY
  change is the price feed ageing past its limit: the name leaves the scored set, leaves every
  live recommendation, and appears under staleness with `bhavcopy … against a 24h limit`. The
  diff between the two reports is the proof, and dropping the filter turns the test red.
- **New rule the DoD forced out:** FR-31 is not only about *generating* a recommendation. One
  raised last week on data that has since gone stale is not actionable either, so open
  recommendations whose instrument is blocked today move to `pipeline.withheld` and are shown
  under staleness. They are withheld, not deleted — silence would be worse than either.
- **Narration (§6.7) cannot corrupt a number.** `narrate` receives the finished engine output
  and returns prose; nothing feeds back. No key, a non-200, or a throw all return `null` and the
  report ships its deterministic bullets. The report build never touches the network in tests.
- **Owner signed off on the cadence change (2026-09-13): weekly moves Sat 08:00 → Sunday 10:00
  IST** (`30 4 * * 0`, PRD §12.2). `workflow-schedule.test.ts` is **re-derived from the new
  YAML** — it converts the cron to IST and reads back Sunday 10:00 rather than restating the
  string — and now also pins the digest's `workflow_run` gating, replacing the assertion that
  was deleted (and reported, never silently edited) when the digest left its fixed cron.
- **`src/jobs/weekly.ts` and `pnpm weekly` are retired.** The old job sent the daily digest plus
  a TODO where this report belonged; leaving it would have left two weekly entrypoints to drift.
  `report.ts` took over the dashboard write, and `weekly.yml` runs `pnpm report`.
- **Firewall, again:** `jobs/report.ts` replaced `jobs/weekly.ts` on the funded-status allowlist
  (a reporting entrypoint, reaching it only through maturity routing), and a NEW assertion keeps
  `notify/report.ts` — which drives the sizing engines — permanently off that list.
- `GSEC_YIELD_PCT` blank/absent means "not configured": the report states the signal review did
  not run rather than scoring against `Number('') === 0`, a 0% risk-free rate that would make
  every name look cheap. Documented in `.env.example`; `weekly.yml` passes it as a repo var.
- 14 tests. Suite **551 passed**, `tsc --noEmit` clean.

## 2026-09-13 (Phase 1 Task 12 — scoring harness §13)

- **Phase 1 Task 12 complete.** `src/domain/scoring.ts`: `snapshotBenchmark`, `dueEvals`,
  `evaluateRec`/`runDueEvals`, `calibration`, `addMonths`.
- **The creation snapshot is immutable at the database level.** Migration `0012` replaces
  `benchmarks`' blanket append-only trigger with `sentinel_benchmarks_immutable()`: UPDATE is
  allowed only when `recommendation_id`, `benchmark_as_of` and `benchmark_jsonb` are unchanged,
  so the 3/6/12-month evals can accrue onto the row while the point of comparison cannot be
  rewritten. Blanket append-only would have made the eval columns unwritable; dropping the
  trigger would have made the whole §13 exercise unfalsifiable. Same shape as `lots`.
- **Nothing is scored early** — a horizon that has not elapsed by `asOf` is not returned, and a
  `dueEvals` run on a fresh seed yields zero rows.
- **Honest emptiness.** A conviction bucket under `MIN_EVALS_FOR_CALIBRATION` (20) reports
  "insufficient data" rather than a percentage; an unscoreable call (a missing close at creation
  or at the eval date) is recorded with its reason and **never counted as a miss**. One winning
  call is not a 100% hit-rate, and the test pins exactly that.
- Folded into the weekly report as a new §13 section instead of a separate job and workflow —
  the evals fall due on their own clock and the weekly run is already the place they land.
- 15 tests, including the database refusing an overwrite of a snapshot. Suite **568 passed**,
  `tsc --noEmit` clean.
- **Owner true-up:** the minimum-N of 20 is a judgement call about how much evidence he wants
  before trusting the calibration table — logged under Waiting on OWNER.

## 2026-09-13 (Phase 1 Task 13 — workflows, env, provisioning, README) — PHASE 1 COMPLETE

- **The EOD steps are real now.** `runSync` takes `fetchPrices`/`fetchNavs`, wired in the
  entrypoint to NSE bhavcopy + index series and AMFI, running AFTER the portfolio sources and
  BEFORE anything that reads a price. A missing fetcher is an explicit skip on stderr.
- **Two pieces recorded as shipped in Task 3 did not exist.** `downloadBhavcopy` ended in
  `throw new Error('Zip parsing not implemented')` — it downloaded the archive and then always
  threw — and `downloadIndexSeries` was never written at all, though both are named in Task 3's
  ledger entry and in `index.md`. The step that "ran" them was a placeholder with the download
  commented out, so the daily sync recorded **a successful nse-bhavcopy step having done
  nothing**: the silent degradation PRD §8.2 exists to forbid, sitting inside the job whose
  whole contract is loud failure.
- **Fixed with the standard library.** NSE serves `.csv.zip`; `unzipFirstEntry` parses a
  single-entry archive with `node:zlib` (stored + deflate, and it scans for the central
  directory when the local header carries no size). No new dependency in a two-dependency repo.
  Tests build real ZIPs with `deflateRawSync` and round-trip the actual bhavcopy fixture.
- Fix-on-touch: `fetchWithRetry` retried a 404 three times because `SourceError.retryable`
  existed and was ignored. A non-trading day now answers once.
- README gained the Phase 1 handoff — a data-flow diagram, "how a recommendation gets built",
  "the two ways it gets stopped" (FR-31 staleness and IPS §3.7 policy), "what the engine will
  not invent" — and the §15.1 provisioning table with each item's real status. Scripts and the
  architecture tree are current.
- **Honest about what is unverified:** the NSE archive URL and CSV columns are fixture-verified
  only, and the `holidays` table is empty. Both are in PENDING as owner/provisioning items
  rather than guessed at.
- 8 new tests (4 zip, 4 sync steps). Suite **576 passed**, `tsc --noEmit` clean.
- **Phase 1 is complete: tasks 1–13, with 11A superseded by the `web/` app.**

## 2026-09-13 (post-Phase-1: screener screen HTML scraper + extraction-model revert)

- **The paywalled CSV export is no longer the ingestion path.** screener.in's CSV export is
  behind a paywall; a public screen URL is not. `src/sources/screener-screen.ts` parses the
  rendered table HTML directly: `parseScreenHtml` (data-row-company-id rows, header `tooltip`
  → canonical column key, `<span>` unit suffixes stripped, per-column `normalizeHeader`),
  paginated `fetchScreen` (`?page=N`, 25/page, stops on a short page), `slugToInstrumentId`
  (validates against `instruments`, no invented instruments), and idempotent
  `importScreenRows` — re-importing the same `(as_of, filename)` deletes the prior batch
  because `screener_uploads` is append-only and ON CONFLICT cannot update. Migration `0014`
  widens `fundamentals.source` back to `'screener-screen'` (0013 had narrowed it to
  `'screener-in'` only). CLI: `screener:import --screen <url>`.
- **Driven by real HTML.** The 16 tests run against two real 42KB page captures from screen
  41972. 606 passed, `tsc --noEmit` clean.
- **The owner gate decision on the §6 inputs is still owed** (screener has no native `Symbol` /
  `Industry` / `FCF 5Y` / `Red Flags` columns) — logged under PENDING.
- **Extraction model reverted the same day.** The owner refined the one-family decision:
  `VISION_MODEL_CHAIN` again leads `google/gemma-4-31b:free`, the `ling-3.0-flash-vl` leader
  trial retired; `TEXT_MODEL` (`-fin`, text-only) stays for advisor/watchlist prose and is kept
  out of the vision chain by test. The stale model-wiring tests were updated together rather
  than left to go red on the swap. 606 passed, `tsc --noEmit` clean.

## 2026-09-15 (NSE 2026 price pipeline — full-market fallback + ISIN backfill)

- **Root cause closed: the NSE archive host stopped serving 2026.** Every `cm<DD><MON><YYYY>bhav.csv.zip`
  for a 2026 trading date returns 404 (verified live, multiple dates); the same pattern still
  serves 2019–2024 (2024-03-05 → 200, 1790 rows, ISINs intact). Equity prices had been DDL nicht
  landing since June. diagnosis confirmed by curl/probes, not assumed.
- **Fix is archive-first with a whole-market fallback.** `downloadBhavcopy` tries the archive,
  and on `SourceError NOT_FOUND` falls back to
  `nsearchives.nseindia.com/products/content/sec_bhavdata_full_<DDMMYYYY>.csv` (numeric month —
  the alphabetic-month URL 404s; caught by a live probe after the first fallback attempt returned
  0 rows). Both missing → `{rows: [], report}`, still reported honestly. Live: 11-Sep-2026 →
  2637 EQ rows, DATE1-truth dates, GOLDBEES/LIQUIDBEES/NIFTYBEES (SERIES=EQ) present.
- **Full-market rows carry no ISIN.** `parseFullMarketCsv` yields `isin:''`; `ingestPrices` now
  resolves those rows through the `NSE:<symbol>` id that seeded instruments already hold, so no
  schema change and no invented instruments. `20MICRONS` (not seeded) correctly lands in
  `unknownSymbols`.
- **ISIN backfill from the whole-market master.** `downloadEquityMaster` (`EQUITY_L.csv`, 2306 EQ
  symbols; GOLDBEES/LIQUIDBEES absent — ETFs excluded there) + `backfillInstrumentIsins` fills
  only `NULL`/empty instrument ISINs, never clobbering a seeded value (both branches tested,
  including a non-clobber test). New `pnpm backfill:isin` job. Live run: 1 instrument updated.
- **`fetchWithRetry` now sends the NSE `Referer` header** (browser posture the site expects) and
  widens `Accept` to incl. CSV. Fix-on-touch: `formatNseDateNumeric` for the full-market URL.
- Fixtures: `tests/fixtures/bhavcopy/full_11SEP2026.csv` + `EQUITY_L.csv`. Tests: parseFullMarketCsv,
  parseEquityMaster, full-market ingest via NSE:<symbol>, backfill fill + no-clobber. Suite
  **618 passed**, `tsc --noEmit` clean. Commit `316720a`.
- **Residual, documented in PENDING:** today's full-market file appears only after ~18:00 IST (a
  17:30 IST cron can re-dispatch for the same day); the index zoo `ind<DDMMMYYYY>.zip` still has
  no working 2026 source and stays silent-empty. Both environmental/known, neither silent-break.
- Push of all approved work (AMFI fix + `e745218` + NSE pipeline) per owner instruction.

## 2026-09-15 (sync cron moved to 19:00 IST — after NSE publishes)

- The ~18:00 IST file gap was a scheduling problem, not a code one: `sync` ran daily 17:30 IST,
  minutes before NSE publishes `sec_bhavdata_full_<DDMMYYYY>.csv`, so on every trading day the
  scheduled run 404'd today's file and `prices_eod` stayed empty/stale. Owner chose **19:00 IST**.
- `sync.yml` cron `0 12 * * *` → `30 13 * * *` (19:00 IST), with a comment explaining the
  after-publication dependency. The digest is `workflow_run` on sync, so it follows automatically.
- No test change needed — `workflow-schedule.test.ts` pins sync to "daily (7 days)" only, not the
  hour (12/12 green). Docs kept honest: `index.md` workflow table, `PENDING.md` (Next-up + schedule
  list), `MEMORY.md` (digest-gating note + timing-gap note), `docs/SETUP.md` schedule block
  (corrected the stale "weekdays 08:45 digest" line to `workflow_run` while in there).
- First 19:00 IST run also backfills today's missing `prices_eod` data once the file is out.
- Committed + pushed.

## 2026-09-15 (screener cohort promotion — screen rows become instruments)

- **The universe-widening step the watchlist pool was waiting on.** `importScreenRows` used to
  skip every row whose company was not already in `instruments`; the live sentinel run (screen
  3963033, 2026-09-14) landed only 12 of ~230 for exactly that reason. Now each unknown row is
  **promoted** via new `ensureScreenInstrument` (internal, not exported): id `NSE:<slug>`, kind
  EQUITY, currency INR, exchange NSE, `metadata = {"source":"screener-cohort"}`, `on conflict
  (id) do nothing`. Identity is derived from the screen slug (screener exports no ticker); the
  human-readable name is trusted from the screen; **ISIN is deliberately left NULL** to be filled
  by `pnpm backfill:isin` from `EQUITY_L.csv` — never invented.
- **Known simplification (scope note):** ETF rows would be mis-kinded as EQUITY (source-row
  kind/exchange dropped at promotion). Low severity, one screen type; noted, not built around.
- **Degenerate `/company/id/<n>/` rows still refused** (slug len < 3 — the LIKE-guard fix from
  the 2026-09-14 live run stays; they can't be promoted, so still warn `Unknown instrument
  (not created)`).
- **Return contract widened:** `importScreenRows` → `{ uploadedId, inserted, createdInstruments,
  warnings }`; the screen-job CLI prints `Promoted N new companies into the instruments
  universe`. `screenerImportCsv` (legacy pinned-spec path) reports `createdInstruments: 0` and
  never promotes. No migration, no schema change.
- 4 new tests in `tests/sources/screener-screen.test.ts`: (1) unknown row becomes a real
  instrument with kind/metadata mark; (2) **derived** exact-count check over two synthetic slugs
  (COHORTD1/COHORTD2) — earlier fixtures were unusable because the file's own import tests had
  already promoted every fixture slug; (3) re-import idempotence (`createdInstruments: 0`,
  count unchanged); (4) degenerate `ID` slug never created and still warned. Fixture-derived
  approach abandoned in favour of self-contained synthetic rows. **618→622 passed**, tsc clean.
- Growth path recorded for Phase 2: the pile grows screen-by-screen toward the whole market
  (~2,600) by pulling more screens over time (whole-market prices already flow daily); news /
  sentiment / partnerships reading stays planned for the next stage.
