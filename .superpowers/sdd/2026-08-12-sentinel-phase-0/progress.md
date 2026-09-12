# Sentinel — SDD progress ledger

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
