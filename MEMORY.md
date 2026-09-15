# Sentinel — durable project memory

Last updated: 2026-09-05. Phase 0 complete + fix wave + re-review; branch merged to `main`.
Post-merge: Supabase provisioned (secrets in GH Actions), production double-count fixed,
statement-ingestion workstream (photo → LLM proposal → owner confirm → owner lot). Read this
at session start (see `CLAUDE.md`). Update it when a durable fact changes.

---

## Fidelity RSU flow — SHIPPED 2026-09-05 (evening)

Fidelity screenshot → `extractRsuVestsFromImage` (`sources/fidelity-ingest.ts`) → priced
`FidelityProposal[]` queued in `telegram-bot.ts` `fidelityPending` → `/confirm <#>|all`
writes ACTUAL `rsu_vests` + audit row; `/reject` clears both queues; the digest stops
announcing a vest once it is ACTUAL.

- **Money math shares `rsu.ts` constants.** `UNITS_SCALE` and `toUnitsMicros` are now
  EXPORTED from `src/domain/rsu.ts`; `fidelityVestsToProposals` uses them, so the
  proposal's `grossPaise` literally equals `confirmVest`'s recomputed gross and
  `netPaise ≤ gross` passes by construction. The old 10⁴ scale inflation (proposal net
  ~100× the true figure) is gone. `priceUsdCents = cents(BigInt(Math.round(priceUsd*100)))`.
- **Row-ensure is two top-level calls, never nested:** `persistVests(db, [PROJECTED], {asOf})`
  (FR-03-safe upsert, never touches ACTUAL) → select id by `(grant_id, vest_on)` →
  `confirmVest`. `Db.withTransaction` does not nest.
- **Grants are never auto-created** (FR-02). A vest whose grant has no `rsu_grants` row is
  skipped ("no such grant — add it to seed data first"), and skipped entries are CONSUMED:
  `handleConfirm` routes to `fidelityPending` first, so a stuck entry would silently block
  later cost confirmations until removed.
- **`saveStatementPhoto` short-circuits** when `join(dir, fileId)` already exists on disk —
  kills the callback-path "file not found" dead-end for brokerage AND fidelity keyboards.
- **PGlite DATE→Date gotcha now has TWO sites.** digest's `buildDigestInput` filter
  normalizes `vest_on` exactly like `granted_on`:
  `instanceof Date ? toISOString().slice(0,10) : String(...).slice(0,10)`. Building a key
  from bare `String(r.vest_on)` never matched `'YYYY-MM-DD'` and re-announced confirmed vests.
- **13 new tests** (fidelity-ingest 6, telegram-bot-fidelity 5, digest ACTUAL-filter 1).
  Suite 444 passed / 55 files, plus the one stale `workflow-schedule` cron failure —
  surfaced, not fixed (see Gotchas below).
- **A real Fidelity statement is the live test** — and it also resolves the open RSU
  per-grant split true-up (₹57.05L vs PRD ₹53.25L): the statement carries per-grant units
  and dates, which is exactly what that gap asks for.

---

## 2026-09-05 session — seed reality + Fidelity flow gap + digest gating

**Seed is now the real Fidelity picture.** `pnpm seed` writes a fresh manual-seed snapshot
(2026-09-04): US:NOW **78 shares @ ₹10,72,974** (`107_297_400` paise), total assets
**₹53,41,973.61**. The old 2026-08-24 snapshot (US:NOW qty **1** @ ₹5L, ₹47.69L total) still
sits in the DB and the latest-per-source reader (`networth.ts:103` `distinct on (source)`)
now returns the new one. The ₹46.54L / ₹13,422-fidelity digest the owner saw was the OLD
snapshot revalued: **1 share × live NOW (~$142) × FX (~94.5) ≈ ₹13,422**, exactly what printed.
Any consumer must use latest-per-source, never a fixed date.

**GOTCHA — `pnpm seed` writes can vanish silently via the pooler.** Three seed runs against
`aws-0-ap-south-1.pooler.supabase.com:6543` (transaction-mode pgbouncer + postgres-js
`max:2`) printed "Seeded snapshot <id>" yet persisted nothing; a later run stuck. Verify a
seed by querying `snapshots where source='manual-seed'` for the expected date rather than
trusting the printed id. The digest itself is fine (reads only), but a manual re-seed that
"cheerfully" failed is what fooled us this session. Read + write share the same pooler.

**Fidelity Telegram flow — dead end diagnosed this morning, SHIPPED this evening** (see
`§ Fidelity RSU flow` above). The 78 shares did NOT come through Telegram; they were hardcoded
into `SEED_HOLDINGS` (`seed-data.ts:116`) from numbers the owner pasted in chat.

**Stale test surfaced, decision needed (2026-09-05 evening).** Since commit `30b47d3`
moved digest.yml from a fixed cron to `workflow_run` on sync success, the shared `cronOf()`
in `tests/jobs/workflow-schedule.test.ts` throws "no cron in digest.yml" — the suite's one
persistent red test. `digest.yml` intentionally has no cron. Do not silently edit the test's
assertion; the owner decides whether digest freshness is still gated by a workflow (then the
test is updated to assert the `workflow_run` shape) or the assertion is dropped.

**Digest gating (commit `30b47d3`).** `digest.yml` no longer has a fixed cron; it fires on
`workflow_run` of `sync`, gated `conclusion == 'success'`. Sync cron `30 13 * * *` (19:00 IST
since 2026-09-15 — must run AFTER NSE publishes the whole-market file ~18:00 IST, or `prices_eod`
stays empty every day). Trade-off accepted: failed/missing sync ⇒ no digest that day.

**Cleanups (commit `472d801`).** `.claude/`, `.serena/`, `zoox_finalTEMP_MPY_wvf_snd.mp4`
were swept into `bc728b4`; untracked + gitignored. Temp `check-*.ts` / `test-insert.ts`
scripts deleted. Working tree clean apart from intended changes.

---

## Phase 1 kickoff — 2026-09-05 (late session)

Plan written: `docs/superpowers/plans/2026-09-05-sentinel-phase-1.md` — 13 tasks, mirrors the
Phase 0 plan shape (Goal / Global constraints / **Scope Calls** / File structure / tasks with
interfaces + acceptance criteria, deliberately near-zero reference code — Phase 0's snippets
shipped defects 4×). **13 tasks**: Sammaan maturity (1, time-boxed — bond matures 26-Sep-2026
~3 weeks out) → schema 0007/0008 (2) → bhavcopy + index series (3) → AMFI NAV (4) → staleness
extension w/ blocked-by-stale **DoD proof** (5) → watchlist + screener importer (6) → signal
engine (7) → alloc engine (8) → sell triggers (9) → FR-11 recommendations + paper mode (10) →
weekly report + narration + schedule re-derive (11) → scoring harness (12) → workflows/env/
README/provisioning (13). DoD from PRD §14: first weekly report ≥1 fully-formed FR-11 paper
recommendation with all timestamps, and a deliberately stale price provably blocks a
recommendation.

**Owner decisions (2026-09-05, do not re-litigate):**
- **Watchlist is advisor-owned.** Owner curates only at setup; quarterly revision = an advisor
  *proposal* (adds from screening, removals for failed gate / red flag / sustained
  underperformance) surfaced in the weekly report for sign-off. No auto-mutation; every change
  logged in `watchlist` (source + reason).
- **Screener CSV: pinned format spec + committed fixture now; the owner's real export is the
  live test** (same pattern as the Fidelity statement). Real exports may add columns — parser
  consolidates with a warnings list shown in the weekly report.
- **Weekly-review LLM runs on the existing OpenRouter key**, not a new Anthropic API key
  (PRD §12.1 names Anthropic; OpenRouter hosts same-class models, zero new secrets). Model id
  is env-driven (`WEEKLY_LLM_MODEL`, default `anthropic/claude-sonnet-4-5`). Narration only
  (PRD 6.7); the LLM never originates a number or rank.
- **Sammaan maturity = Phase 1 Task 1.** Legacy cleanup queue + LTCG harvest calendar (FR-14)
  stay Phase 2 per owner; sell trigger 6 is the documented no-op stub.
- **Weekly cadence Sat 08:00 → Sunday 10:00 IST (PRD §12.2)** is in the plan but requires owner
  sign-off; the same step re-derives the stale `workflow-schedule` digest.yml assertion and
  reports the owner-decision, never silently.
- **Local preview UI added (Task 11A, port 8081).** PRD's real Next.js UI stays Phase 2; Phase 1
  gets a throwaway read-only `tsx`+`node:http` preview (`pnpm ui`, `tsx --env-file=.env
  src/ui/server.ts`) that renders the weekly-report sections as HTML from the same pure
  composition, reading the local PGlite DB. First slice = real data (net worth/drift/staleness/
  holdings) + "lights up in Task N" placeholders. No mutating path imported. Content functions
  carry into Phase 2's Next.js app untouched. **(SUPERSEDED 2026-09-05 (same session's later
  turn) — the owner pulled the real Next.js app forward instead; see `§ Local web app` below.**
  The 8081 preview was the trigger, not the destination.)

**Schema note:** Phase 0's 16 tables have NO `prices_eod`, `navs`, `fundamentals`,
`recommendations`, `signal_scores`, `watchlist`, or holiday calendar — that's what 0007/0008
add. `blockedInstruments` + `ipsClause` already exist and are the Phase 1 choke points.

---

## Local web app — pulled forward 2026-09-05

PRD's real Next.js product UI is built NOW, as a standalone **`web/`** app for local review
only — still no deployment, still single-user, still read-only. **No pnpm workspace** (root
CI untouched). This supersedes the "throwaway preview, UI stays Phase 2" note above.

- **Run:** `pnpm web` → `pnpm --dir web dev` (`next dev -p 3001`). 16 routes, all verified
  200 against the live Supabase pooler: `/` Overview · `/holdings` · `/allocation` ·
  `/buckets` · `/rails` · `/rsu` · `/ips` · `/freshness` · `/audit` render real data through
  the same pure domain functions the jobs use; `/watchlist` (T6) · `/signals` (T7) ·
  `/recommendations` (T10) · `/maturity` (T1) · `/narrative` (T11) · `/scoring` (T12) are
  honest "builds in Task N" shells with disabled buttons that name their reason; `/product`
  is the AREAS ledger.
- **Read-only by construction.** `web/lib/data.ts` imports only read-only readers — never
  `raiseIncidents`/`installIps`/`confirmVest`/`persistVests`/`writeSnapshot`. Buttons are
  inert `PendingButton`s with reason tooltips; there is no mutating path.
- **Env.** Next has **no `envDir` option**. `web/next.config.ts` parses repo-root `.env`
  itself (`resolve(process.cwd(), '..', '.env')`, `KEY=value` lines, skips `#` comments,
  sets `process.env` only when unset) so the Supabase pooler `DATABASE_URL` +
  `TOKEN_ENCRYPTION_KEY` + `LLM_API_KEY` (OpenRouter) reach the server bundle. Tests/jobs
  still use `loadEnv` per job; the app has its own loader and is NOT covered by
  `workflow-env.test.ts`. **Server must be restarted after `.env` changes** — env is read
  at process start and cached.
  **Never overwrite `.env` with `Set-Content`** — it's gitignored with no backup or history,
  and clobbered it wiped `DATABASE_URL` + `TOKEN_ENCRYPTION_KEY` on 2026-09-06 (only
  `LLM_API_KEY`/`KITE_*` survived). Only append or surgically edit one key at a time. GitHub
  secrets can't be read back at all, so a clobbered key is gone — **rotate, don't recover**
  (`TOKEN_ENCRYPTION_KEY` was rotated this way 2026-09-07; see § Key rotation below). A
  `recover-key.yml` workflow that echoed the secret into a run log was written and then
  deleted unrun — never reintroduce it: it converts one lost secret into a permanent leak.
- **Two webpack quirks, both solved in `web/next.config.ts`:** (1) `resolve.extensionAlias =
  {'.js': ['.ts', '.tsx', '.js', '.jsx']}` — `src/` uses ESM-style `.js` specifiers;
  (2) `src/domain/ips.ts` does `readFileSync(new URL('../config/ips-v1.md',
  import.meta.url))` at import time — webpack rewrites that `new URL` into an inert asset
  handle that dies at runtime — so the bundle swaps the module for
  `web/lib/domain-ips-shim.ts` via `NormalModuleReplacementPlugin(/\/domain\/ips\.js$/)`
  (use the real webpack constructor from the hook's context arg; `next/dist/compiled/webpack`
  does not expose it). The seed text lives in `src/config/ips-v1.md` (not repo-root
  `config/`); the shim re-exports `IPS_V1_TEXT`/`currentIps`/`ipsClause`/`renderIps`.
- **Perf:** `web/lib/data.ts` memoizes the expensive live build (RSU price + FX fetch) 60s
  so page navs are fast.
- **Layout gotcha (2026-09-06):** layout primitives are hand-rolled in `web/app/globals.css`
  (no Tailwind). Pages depend on `.grid` (2-col, 24px gap), `.two-thirds` (2fr/1fr wide+rail),
  `.stats`, `.stack`, `.one`, `.span-2`, `.legend`, `.ips-text`, `.tr-*` row tones — all defined
  there. ArenaAI reference (owner's design source): `C:\Users\Anirban\AppData\Local\Temp\opencode\arenaai`.
  Kite "auth" today = env-status card + statement upload on `/import`; real OAuth connect is
  Phase 2 (no stored passwords — human-in-loop unlock is the security model). **App Router
  gotcha:** `NextResponse.redirect()` in API route handlers (`app/api/*/route.ts`) requires
  an **absolute** URL (e.g. `${req.nextUrl.origin}/import?...`) — a bare relative path
  like `/import?...` throws `ERR_INVALID_URL` (500). Both `kite/login` and
  `kite/callback` were fixed for this (2026-09-06).
- Files: `web/lib/{ui,data,product}.ts(x)`, `web/lib/domain-ips-shim.ts`, `web/app/*/page.tsx`,
  `web/next.config.ts`. `.gitignore` gained `web/node_modules/` + `web/.next/`;
  `web/pnpm-lock.yaml` and `web/next-env.d.ts` are tracked. **Commit pending owner.**
- Known benign boot warnings: Next "inferred workspace root / multiple lockfiles" (could be
  silenced with `outputFileTracingRoot`); `web/tsconfig.json` was auto-given
  `exclude: ['node_modules']` — keep.

---

## Kite retired — INDmoney is the only portfolio source (owner decision 2026-09-07)

The web "Connect Kite" flow worked on its first real run and that is exactly how the bug
surfaced: it wrote 31 holdings worth ₹14,72,851 as a `kite` snapshot, and **INDmoney already
aggregates the same Zerodha account** (28 holdings, ₹8,07,773 — the gap is bonds, which Kite
also reports). Net worth went ₹57,12,936 → ₹71,85,786 (+26%) with no money moving.

- **Root cause is a precondition, not a defect.** `loadPositions` reconciles *seed vs live*
  only; its own comment says "Live-live rows are never merged: each source manages its own
  aggregation." Correct while INDmoney is the sole live source; adding a second live source
  over the same account silently sums. The note now lives in the docstring above
  `loadPositions` so the next source can't repeat it. Overlap also crosses account labels
  (the bonds sit under INDmoney's `indmoney` account and Kite's `zerodha`), so keying on
  `(canonical, account)` alone would not have caught it either.
- **Owner's call: drop Kite entirely rather than build a precedence rule.** Removed:
  `src/sources/kite.ts` + its tests, the `web/app/api/kite/*` routes, `web/lib/kite-auth.ts`,
  the `/import` provider card, sync + telegram-bot wiring, the four `kite*` fields on `Env`,
  `'kite'` from `KNOWN_PORTFOLIO_SOURCES`, and the workflow/`.env.example` entries. All of it
  is recoverable from git history if Kite ever returns for Phase 3 order placement.
- **Two Kite constraints that made it a poor fit anyway:** the access token expires 06:00 IST
  daily and Kite returned **no refresh token**, so an unattended daily sync was never possible
  — it needed a human click every morning. And `sync.ts` gated on the `KITE_ACCESS_TOKEN`
  **env var** while the web flow stored the token in `oauth_tokens`, so the scheduled sync
  would never have picked it up regardless.
- `'Brokerage / Kite'` upload labels and the bot's `kite`/`zerodha` caption keywords are
  KEPT — they route Zerodha *statement screenshots*, an unrelated path.
- **Removing a source means resolving its incidents in the same breath.** `raiseIncidents`
  only ever resolves a subject that `assessStaleness` still returns (`staleness.ts:167`), so
  dropping `'kite'` from `KNOWN_PORTFOLIO_SOURCES` stranded its open `STALE_DATA/BLOCK`
  forever — the precise failure the `unimplemented` state exists to prevent ("trains the owner
  to ignore the loudest safety signal"). Caught and resolved during cleanup. Any future source
  removal must do the same.
- Cleanup of the bad rows was `_retire-kite.mts` (run 2026-09-07, then deleted). **`snapshots` is APPEND-ONLY and the trigger
  lives in `0001` (lines 202–205), NOT in `0004`** — `0004` only adds RLS for it, so grepping
  `0004` alone says "deletable" and is wrong. The first cleanup attempt tried to delete the
  snapshot row and was correctly refused (`P0001: append-only table: snapshots may not be
  DELETEd`); the transaction rolled back with nothing lost. Correct move: delete the
  **holdings** (no trigger — `writeSnapshot` deletes them on every sync) and the
  `oauth_tokens` row, and KEEP the snapshot as the immutable record that a sync happened. An
  empty snapshot joins to zero holdings and contributes zero positions.
  Backup: `data/kite-snapshot-backup-2026-09-07.json`, gitignored via `data/*backup*.json`.

---

## `.env` values must be UNQUOTED (2026-09-07)

`DATABASE_URL`, `KITE_API_KEY` and `KITE_API_SECRET` were written into `.env` wrapped in
double quotes. Node's `--env-file` strips those; **a hand-rolled loader does not**, and
`web/next.config.ts` is hand-rolled. The result was a live bug: `/api/kite/login` emitted
`api_key=%22…%22` and Kite answered `{"error_type":"InputException","message":"Invalid
api_key."}`. `KITE_API_SECRET` was quoted too, which would have broken the sha256 checksum
on `/session/token` at the next leg.

- Quote-stripping was added to `next.config.ts`, but **do not rely on it** — write values
  bare. Nothing in `.env` needs quoting: every loader here takes everything after the first
  `=` to end of line, so spaces and `:/@` are all safe unquoted.
- Real Kite formats, useful as a sanity check: **api_key 16 chars, api_secret 32**.
- The file also carries a UTF-8 BOM on line 1. Harmless only because line 1 is blank — a
  BOM directly in front of the first `KEY=` would make that key silently invisible.
- **Restart the server after editing `.env`.** The running process had cached the quoted
  value, so the config fix alone changed nothing until a restart.

---

## Key rotation — `TOKEN_ENCRYPTION_KEY` (2026-09-07)

Rotated after the old value was found sitting in plaintext in this repo's own Claude Code
transcripts (`~/.claude/projects/D--Sentinel-Ollama/*.jsonl`, 6 of 11 files). Recovery was
possible and was deliberately **declined** in favour of rotation.

- **Blast radius is `oauth_tokens` only.** `oauth_clients.client_secret_enc` is NULL — the
  INDmoney OAuth client is public — so no dynamic re-registration is needed and `client_id`
  (plaintext) survives. Nothing else in the schema is encrypted.
- **Done:** new 32-byte key in `.env` (surgical one-line replace, other keys untouched) and
  pushed to the GH Actions secret via `gh secret set`. `sync.yml`/`weekly.yml` reference the
  secret by name, so they needed no edit; `.env.example`/docs carry no value.
- **Closed 2026-09-07:** `pnpm indmoney:login` re-minted the tokens against the new key and
  `loadTokens(db,'indmoney',key)` decrypts OK (scope `portfolio:read`, refresh token present).
  Re-login upserted over the dead row; no manual DELETE was needed. The existing
  `oauth_clients` registration (`82e2a319…`, 2026-08-24) was reused — dynamic re-registration
  did NOT happen, and `client_secret_enc` stays NULL.
- Had it not been re-minted, the failure degrades safely: the decrypt throws inside
  `ensureAccessToken` at `getToken()` time (not in `indmoneySource()`'s try/catch, which only
  touches the null client secret), landing in `runSync`'s `step()` as a `SYNC_FAILURE`
  incident (WARN, then BLOCK) and falling back to `FileIndmoneySource`. The job still exits 0,
  so the digest still fires.
- **Beware `.pglite` vs Supabase when spot-checking OAuth state.** The local embedded DB
  carries its own stale `oauth_clients`/`oauth_tokens` rows with a DIFFERENT `client_id`
  (`d421a08f…`). Reading one and reasoning about the other invents discrepancies.
- Transcripts are unencrypted JSONL on disk. Treat anything ever pasted into a chat as
  burned — the Telegram bot token and Supabase DB password are still un-rotated (PENDING).

---

## Owner-gated statement import via `/import` (2026-09-05, same session) + visual redesign

The local app is no longer strictly read-only: an owner-gated **statement-import flow** lives
at `/import` — upload brokerage/Kite or Fidelity RSU statements → LLM extraction into
proposals → owner confirm/reject → real DB writes through the **same platform functions the
Telegram bot uses** (FR-02/FR-03 discipline). Redesigned with an ultra-modern hand-rolled CSS
theme (near-black `#070910` base, indigo/violet radial glows, translucent glass panels/sidebar;
no Tailwind — `web/app/globals.css`).

- **Backing store = migration `0009_web_uploads.sql`** (`web_uploads` queue). Numbering is
  0009 because 0007/0008 are reserved by the Phase 1 plan. First `/import` load
  self-applies 0009 to the **live** Supabase via `ensureWebIngestion` (reads the 0009 file
  and `db.exec`s it — deliberately NOT importing `src/db/migrate.ts`, sidestepping a webpack
  `import.meta.url` risk). The file is idempotent (triggers guarded in DO blocks), so a later
  CLI `pnpm migrate` re-apply is harmless — but `schema_migrations` won't record the web-applied
  run. **The `/import` live load ALREADY applied 0009 to live Supabase** (2026-09-05 session).
- **Confirm semantics mirror the bot exactly.** Brokerage = `insertOwnerCostLot(via:'llm')`
  per proposal (skip when instrumentId null; outcomes created/superseded/unchanged). Fidelity =
  grant-exists check → PROJECTED `persistVests` → `confirmVest`. Each resolution writes an
  `audit_log` row (`entity 'web_upload'`, actor `owner`). `web_uploads` trigger allows only
  status/summary/resolved_at updates; DELETE/TRUNCATE blocked.
- **Web must not import `telegram-bot.ts`** (heavy telegram/jobs deps would break webpack).
  Shared `displayOrder`/`resolveProposalTarget` live in new `src/sources/proposal-target.ts`;
  the bot imports+re-exports them (local import for internal `/holdings`/`/cost` AND `export`
  for `tests/notify/telegram-bot-ingest.test.ts`; a bare `export … from` broke the internal
  call at runtime — fixed).
- **Verification (live, 2026-09-05):** `/import` 200 + nav renders; POST `/api/import`
  (no-key) → `unusable` + archived `data/screenshots/web-<uuid>.png`; confirm/reject on a
  terminal row → `{"error":"that upload is not pending"}`; bad index → 404 `index out of
  range`; unknown id → 404 `no such upload`. **Earlier key-state confusion:** `LLM_API_KEY`
  living only in the shell env (not `.env`) made extraction dormant for any Next server not
  started from that terminal; **fixed 2026-09-06** by moving the OpenRouter key into `.env`
  (gitignored, read by `web/next.config.ts` at startup). Python PS5.1's `Get-Process` has no
  `CommandLine` property, so the `Where-Object` filter matched nothing and the original
  key-bearing server kept port 3001. Kill by the port owner from `netstat -ano`.
- **BigInt in proposals** must be stringified (`costPaise`, `priceUsdCents`, `usdInrMicros`,
  `grossPaise`, `netPaise` as strings; convert back with `BigInt()` at confirm).
- **`web/app/api/import/[id]/confirm|reject/route.ts` import `lib/ingest` via
  `../../../../../lib/…`** (one level deeper than the other routes — they live under `[id]/`).
- **tsc/typecheck:** root `package.json` has no typecheck script; web verification is
  `pnpm --dir web exec tsc --noEmit` (clean as of 2026-09-05).
- Files added: `web/lib/{ingest,format,product}.ts`, `web/app/nav.tsx`,
  `web/app/import/{page,upload-form,review-panel}.tsx`,
  `web/app/api/import/route.ts`, `[id]/confirm/route.ts`, `[id]/reject/route.ts`,
  `migrations/0009_web_uploads.sql`, `src/sources/proposal-target.ts`.

---

## Where we are

Phase 0, 17 tasks (1–11, 11A, 11B, 12–15). Plan:
`docs/superpowers/plans/2026-08-12-sentinel-phase-0.md` (committed at `ab91f87`).
Per-task ledger: `.superpowers/sdd/2026-08-12-sentinel-phase-0/progress.md`.

| Task | Subject | Status |
|---|---|---|
| 1 | scaffold + `ASSUMPTIONS` | complete |
| 2 | Db client + migration runner | complete (2 fix rounds) |
| 3 | Phase 0 schema, 16 tables | complete (1 fix round) |
| 4 | money primitives + FX | complete |
| 5 | seed data (real balance sheet) | complete (2 fix rounds) |
| 6 | loan amortization + prepayment cascade | complete, review clean, 44/44 green |
| 7 | investable surplus curve | complete, 1 fix round (6 review issues), 61/61 green |
| 8 | RSU vest projection | complete, 1 fix round (FR-03 in SQL), 82/82 green |
| 9 | net worth + allocation drift | complete, 114/114 green |
| 10 | buckets, milestones, funded status (+ no-catch-up arch test) | complete. **The architecture test was REWRITTEN 2026-08-23 in the fix wave.** The Task 10 version enforced NOTHING (no filesystem access, no module-graph walk, no allowlist; `sizeRisk`, `riskScore` and `resolveSpec` were stubs declared inside the test file, and its own stated mutation check was false). It now walks the real `src/` tree, builds the real import graph and asserts that transitive reachers of `funded-status.ts` are exactly `buckets.ts`, `notify/digest.ts`, `jobs/digest.ts`. Proved by mutation: a direct import from a non-allowlisted module, a TWO-HOP path through an allowed one, a stale allowlist entry and an empty graph all go RED. `tests/fixtures/funded-ratio-types.ts` is still NOT in the branch and is not needed. |
| 11 | source adapters (env, Kite read-only, File INDmoney, FX, writeSnapshot) | complete — 14 new tests, 164/164 green, tsc clean. `src/config/env.ts` (loadEnv), `src/sources/types.ts` (SourceRow, Source, writeSnapshot), `src/sources/kite.ts` (read-only, method allowlist: fetch, getHoldings), `src/sources/indmoney.ts` (FileIndmoneySource — file fallback), `src/sources/fx.ts` (fetchUsdInr, frankfurter.app, sanity band 50-200). KiteSource exposes NO order methods — allowlist test + source scan for /orders, /gtt, POST/PUT/DELETE/PATCH. FileIndmoneySource reads owner-refreshed snapshot; staleness (Task 12) nags when it ages. RemoteIndmoneySource (Task 11B) implements same Source interface. writeSnapshot upserts instruments, replaces same source+date holdings, writes audit_log. Every row carries as_of + source. |
| 11A | INDmoney OAuth: DCR + PKCE + encrypted token store + `pnpm indmoney:login` | complete — 13 tests, 178/178 green, tsc clean. `migrations/0002_oauth.sql` (oauth_clients.client_secret_enc, oauth_tokens.refresh_token_enc — AES-256-GCM), `src/sources/oauth.ts` (discoverMetadata, registerClient, pkcePair, authorizeUrl, exchangeCode, refreshTokens, saveTokens, loadTokens, saveClientSecret, loadClientSecret, ensureAccessToken, ReauthRequired), `src/jobs/indmoney-login.ts` (loopback on 127.0.0.1:8765, PKCE S256, state verification, timeout cleared on success/failure), `package.json` indmoney:login script. Audit #4 FIXED (client_secret encrypted), #16 FIXED (timeout handle). |
| 11B | MCP client + `RemoteIndmoneySource` | complete, **remapped 2026-08-22** against a real capture — the Task 11B mapper was written to an invented fixture and was non-functional against the live tool. 11 tests, 198/198 green, tsc clean. See § Task 11B below. |
| 12 | staleness engine | complete — 13 tests, 211/211 green, tsc clean. `src/sources/staleness.ts` (FRESHNESS_HOURS, assessStaleness, raiseIncidents, blockedInstruments, StalenessRow). Queries `holdings` for portfolio sources and `fx_rates` for FX (fixes audit #6). Reports amfi/bhavcopy/screener as stale (no tables yet). Boundary tests at exactly 36h/48h limits + 1min past (fixes audit #19). Incidents open/resolve correctly for each source. `blockedInstruments` returns FR-31 block list. |
| 13 | IPS v1 stored / versioned / rendered | complete — 6 tests, 217/217 green, tsc clean |
| 14 | Telegram notifier + daily digest | complete — 9 digest tests, 5 Telegram tests, 235/235 green, tsc clean. `src/notify/telegram.ts` (owner-locked, dry-run; **NOT MarkdownV2-safe — corrected 2026-08-22**: it sends unescaped free text with `parse_mode: 'Markdown'`, so one stray `_`/`*`/backtick from the DB throws and the owner gets nothing), `src/notify/digest.ts` (pure `buildDigestInput` + `composeDigest`), `src/jobs/ips.ts` (CLI clause printer) |
| 15 | jobs, GitHub Actions schedules, provisioning checklist | complete — 4 sync tests, 235/235 green, tsc clean. `src/jobs/sync.ts` (failure contract PRD §8.2, loan schedules + projected vests refreshed), `src/jobs/digest.ts` (CLI, `['telegram']` env), `src/jobs/keepalive.ts` (weekly Supabase ping), `.github/workflows/sync.yml` (12:00 UTC Mon-Fri), `.github/workflows/digest.yml` (03:15 UTC Mon-Fri), `.github/workflows/keepalive.yml` (04:00 UTC Sun), `.env.example`, `data/indmoney-snapshot.example.json`, `README.md` |

After task 15: whole-branch review (most capable model) → one fix wave → scoped
re-review → delete SDD workspace → `superpowers:finishing-a-development-branch`.

## Post-fix-wave additions (2026-08-24)

- **Telegram command bot** (commit `d3e45ab`; written in an earlier session, sat untracked
  until then — no dedicated review round yet). `TelegramBot` in `src/notify/telegram-bot.ts`
  is a long-polling `getUpdates` loop answering `/sync`, `/status`, `/help`,
  owner-locked via `Telegram.isOwner`; sync sources built via exported `indmoneySource`
  + optional Kite. CLI entrypoint `src/jobs/telegram-bot.ts`, script `pnpm telegram:bot`;
  needs `['telegram']` AND `['crypto']` env (all four vars). Known wart, strike on touch:
  `notify/telegram-bot.ts` carries a redundant inline main-module entrypoint duplicating
  the jobs one.
- **Repo pushed**: private `github.com/pnanisar0806/Sentinel-Ollama`. `main` =
  plan-only `ab91f87` and IS the default branch; `phase-0` tracks origin; PR #1 open.
  Scheduled workflows run ONLY from the default branch — they stay inert until the PR
  merges. *(Stale: PR has since merged; `main` is the working line — see § Statement ingestion.)*

## Statement ingestion (2026-08-24/25, post-merge)

Owner sends brokerage/MF statement photos to the bot → archived to `data/screenshots/`
(gitignored) → optional LLM extraction proposes cost lines anchored to the numbered
`/holdings` list → **owner replies `/confirm yes`, and only then** an OPEN lot lands on
`lots`. Same approval-gate philosophy as trading; FR-02 holds upstream (unreadable cost
dropped, never inferred).

- `src/sources/owner-ingest.ts`: `parseCostCommand`, `insertOwnerCostLot` (lot +
  audit_log in ONE transaction, `source: 'owner-telegram'`), `saveStatementPhoto`.
  Cost lives on `lots`, NOT `holdings.avg_cost_paise` — holdings rows are replaced per
  sync and a cost written there dies tomorrow. Quantity defaults to 1 because aggregated
  holdings model totals.
- `src/sources/llm-extract.ts`: OpenRouter free vision chain (`LLM_MODEL_CHAIN`,
  gemma-4-31b primary, one retry then walk on 429). Multiple images = pages of ONE
  statement, buffered by `media_group_id` and sent in a single request. Output is
  proposals only: `{line|null, name, costPaise, acquiredOn, confidence}`.
- Bot commands now `/sync /status /holdings /cost /confirm /help`; env adds optional
  `LLM_API_KEY` / `LLM_MODEL` (no key = archive + manual `/cost` guidance).

### Live test 2026-08-25 — 3 defects found, all fixed & pinned by tests

The owner ran the real flow against PRODUCTION Supabase (their shell exported the
pooler DATABASE_URL over .env's pglite). It surfaced what 417 green PGlite tests could not:

1. **`/cost` wrote to the wrong instrument.** `/holdings` renders alphabetically but
   `/cost` resolved its line number against loadPositions' NATURAL order. Fixed by
   `displayOrder()` — the ONE ordering both handlers share (`notify/telegram-bot.ts`).
2. **Partial `/confirm` double-wrote lots.** Confirmed entries stayed queued; every new
   album + `/confirm all` re-wrote them. Production accumulated 89 lots for ~31
   instruments (28 duplicate groups). Fixed: written AND skipped entries leave the queue.
3. **Every audit payload stored to Supabase was double-encoded.** `JSON.stringify(x)` fed
   to `$n::jsonb` makes postgres-js store a jsonb SCALAR STRING (`jsonb_typeof='string'`),
   so `payload->>'…'` reads NULL — the whole production audit trail was SQL-opaque.
   PGlite parses either form, which is why tests passed. Fixed at ALL 8 write sites
   (rsu, ips, types/writeSnapshot, staleness, owner-ingest, seed ×2, indmoney-login):
   pass the OBJECT. Verified against the live pooler inside rolled-back transactions;
   existing rows are immutable (append-only) and stay opaque forever — content intact,
   just not queryable. **Never feed JSON.stringify to a ::jsonb placeholder.**

Methodology worth keeping: rollback-probes against production (insert inside
`withTransaction`, throw to roll back, assert 0 persisted) verify driver behavior
without polluting the append-only tables. This is the only "test" the postgres-js path
has — see deferred minor #5, vindicated twice today.

Fix-on-touch struck: the redundant inline main-module entrypoint in
`notify/telegram-bot.ts` is gone; `pnpm telegram:bot` via `jobs/telegram-bot.ts` is the
only entrypoint.

### Upload idempotency (2026-08-25, migration 0006)

`insertOwnerCostLot` is now an UPSERT-BY-VALUE: same cost open → `'unchanged'` (no-op);
different → `'superseded'` (close old via closed_on + insert new, audit names both);
none → `'created'`. Migration `0006_owner_lot_idempotency.sql` adds a partial unique
index — **at most one OPEN owner-telegram lot per (instrument, account)** — so the
invariant holds against raw SQL from any code path, FR-03 style. Bot messages speak the
outcome (Recorded / Updated ₹old→₹new / Unchanged). Production applied; a test in
networth-cost-fallback.test.ts was updated because two OPEN lots per position are no
longer representable — deliberate schema change, not a widened assertion.

### Portfolio verification (owner answers, 2026-08-25 evening)

- ICICI Nifty 50 under BOTH indmoney (₹6.57L) and zerodha Coin (₹46.7k): **both real**.
- Tata Motors dual entities: **both real** (TMCV 100u + TMPV 100u per Zerodha
  screenshot) — and the screenshot exposed that our two lots carried SWAPPED costs;
  corrected in production through the supersede path (`via: 'owner-correction'`):
  Tata Motors Ltd ← ₹18,789.88, TMPV ← ₹41,530.77.
- "US fractional basket" line was never a product: INDmoney code 118186 IS Apple Inc.
  (fixture proves it; owner screenshot shows the US book = 6 named holdings, summing
  exactly to the app's portfolio value). Fixed `INDMONEY_TO_CANONICAL['118186']`
  → `US:AAPL`; Apple had been wearing the seed basket's name and carrying the whole
  book's invested figure as its own cost.
- Reliance Power (groww, manual closure) ₹2,565: **owner-confirmed**.
- GOTCHA → FIXED STRUCTURALLY (2026-08-26): the LLM's line-anchoring flips on
  near-identical names (TMCV/TMPV) nondeterministically — it bit THREE times in one
  night, once writing TMCV's cost onto TATAPOWER's row. Fix, layered: (1)
  `src/sources/statement-tickers.ts` — owner-verified Zerodha symbol → instrument map
  (28 pairs from the owner's own statements/confirmations; nothing inferred); a ticker
  hit OVERRIDES the model's guessed line (`resolveProposalTarget`). (2) The extraction
  prompt now carries "KNOWN SYMBOL MAPPINGS" so anchoring improves at the source.
  (3) Accumulating proposals that target the same holding with DIFFERENT costs are
  flagged ⚠️ and `/confirm all` SKIPS them — only explicit `/confirm <#>` writes a
  conflict, so last-write-wins roulette is dead. New holdings must be ADDED to the map
  (owner-verified only) or they fall back to line anchoring.

---

## Whole-branch review — 2026-08-22, READ THIS BEFORE THE FIX WAVE

Four parallel reviewers over `ab91f87..3aada17`. **7 Critical, ~35 Important, none visible to the
235/235 green suite.** No reviewer voted merge. Full register:
`.superpowers/sdd/2026-08-12-sentinel-phase-0/branch-review-findings.md` — read it before touching
anything on this branch. Five MEMORY.md statements were proved false and are corrected in place above;
the register lists them.

Clean and not to be re-litigated: IPS 3.1-3.10 byte-identical to the PRD, Tasks 6-9 arithmetic
recomputed and reconciled, AES-256-GCM correct, append-only triggers on `audit_log`/`snapshots`
verified, Telegram owner-lock unbypassable.

## Plan audit — tasks 7–15 audited 2026-08-14 BEFORE implementation

**21 findings. Full register:
`.superpowers/sdd/2026-08-12-sentinel-phase-0/plan-audit-findings.md` — read it before
starting any task from 7 onward.** Do not implement a task until its findings are struck.

Five critical, in priority order:

1. **T7** reference test contradicts the plan's own derived value (₹82,124 vs a `< 82,000`
   band) — fails on first run.
2. **T10** the no-catch-up architecture test does **not** enforce the firewall. It greps for
   an import string; passing `fundedRatio: number` as a parameter from an allowed file
   defeats it entirely, as do dynamic imports, double quotes, and any file outside `src/`.
3. **T11** the Kite read-only test forbids only the literal name `placeOrder`.
   `submitOrder()` passes. Needs a full method allowlist.
4. **T11A** `oauth_clients.client_secret` is stored in plaintext while the token table beside
   it is AES-256-GCM encrypted.
5. **T13** requires PRD §3.1–§3.10 **verbatim** (shown to the owner at −20% drawdown, so a
   paraphrase is a product failure) — and §3.2–§3.10 exist in no artifact in this repo.
   **Resolved 2026-08-22** — owner supplied PRD text in `PRD_investment_agent.md`; copied verbatim into `src/config/ips-v1.md`.

Two structural ones worth holding in mind: **T15 never wires the OAuth INDmoney source**, so
11A and 11B would be built and then never used; and **T12's staleness engine reads only
`holdings`**, so it may be structurally blind to stale prices, NAVs and FX.

## Owner decisions (do not re-litigate)

- **EPF: passive, not a target (decided 2026-08-23).** The ₹13.54L is mandatory ServiceNow
  payroll EPF and ServiceNow keeps contributing. The owner adds **nothing further** — no VPF,
  no FDs. It stays in net worth and counts as DEBT per PRD §3.3 ("EPF counts as debt-like"),
  but it is **not a lever**: never propose adding to it, and never let it satisfy a debt goal.
  It is 68.7% of the debt bucket, so any debt-percentage rail is really an EPF rail.
- **Bonds are the owner's ONLY chosen debt (decided 2026-08-23).** No EPF top-ups, no FDs.
  Consequence: chosen debt is ₹6.16L = 12.9% of the portfolio, and it **halves** when
  Sammaan matures 26-Sep-2026.
- **IPS bands: DEBT floor DROPPED, cash ceiling becomes an OWNER RAIL (decided 2026-08-23).**
  PRD §3.3 says "Debt/EPF/cash: remainder", so `DEBT.min = 0.25` was an invented floor that
  would have nagged the owner to buy debt he has explicitly decided against — permanently,
  since chosen debt sits at 12.9%. `IPS_BANDS` now carries **only PRD-verbatim rails**
  (EQUITY ≤60%, GOLD 5–10%), so every IPS breach can cite a clause, as the PRD preamble
  requires. The 20% cash ceiling is kept as an explicit **owner rail in `settings_rails`**,
  reported separately from "Allocation vs IPS §3.3" and subject to the 48h cooling-off.

- **Fixture PII: accepted, repo stays private (decided 2026-08-23).**
  `tests/fixtures/indmoney-holdings-mcp.json` is a real capture — INDmoney internal user
  id, masked account tails, employer legal entity, exact balances. No credentials, so not
  a secrets violation. The owner is the only user and the repo is private, so it stays as
  captured; several tests derive their expectations from it and redacting would either
  break them or require invented values.
  **Revisit trigger: if this is ever turned into an app for anyone else.** At that point
  the whole security model changes (multi-tenancy, RLS policies with real roles, secret
  handling, this fixture) — treat it as a redesign, not a patch.

- **Runtime: TypeScript everywhere.** One package. Next.js UI + jobs as TS scripts. vitest.
- **Infra: nothing provisioned yet.** No Supabase project, no Telegram bot, no Kite app.
- **Execution: subagent-driven.**
- **INDmoney login: CLI loopback** (`pnpm indmoney:login`, 127.0.0.1 listener) for now —
  not a web button, and not a Next.js dependency in Phase 0. **Ran successfully 2026-08-22**:
  scope `portfolio:read`, refresh token stored encrypted in the local `.pglite`.

## Documented scope calls (deviations from a literal PRD reading)

1. **No Next.js UI in Phase 0.** IPS is rendered via Telegram and a `pnpm ips` CLI.
2. **INDmoney sync via OAuth refresh tokens** (revised — see Gotchas). `FileIndmoneySource`
   is demoted to fallback / test double. **NOT TRUE OF THE SHIPPED BRANCH (corrected 2026-08-22):**
   `sync.ts:81` wires `FileIndmoneySource` only; `RemoteIndmoneySource`, `McpClient`,
   `ensureAccessToken` and `fetchUsdInr` have no production caller. Tasks 11A/11B are dead code
   until the fix wave wires them.
3. **Supabase not provisioned.** PGlite locally, identical SQL.

---

## Contracts

### `Db` — `src/db/client.ts` — **THE PLAN'S BRIEFS ARE STALE ON THIS**

The briefs describe a 2-method interface. The shipped one has four. Restate this
verbatim in every subagent dispatch that touches the DB:

```ts
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Executes one or more statements over the simple protocol (DDL / migration files). */
  exec(sql: string): Promise<void>;
  /** Runs fn inside a transaction on a single pinned connection; rolls back if fn throws. */
  withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

`openDb(url?)` → PGlite when `url` is undefined or `pglite://`-prefixed, else postgres-js.
postgres-js `withTransaction` is built on `sql.begin()`. Inside the tx wrapper: `query`
passes params, `exec` passes none, `close()` is a no-op, `withTransaction` does not nest.

### Money — `src/money/paise.ts`, `src/money/fx.ts`

`Paise` / `Cents` are unique-symbol-branded `bigint`. Exports: `rupees`, `paise`,
`dollars`, `cents`, `addP`, `subP`, `mulP`, `pctOf`, `formatInr`, `rateMicros`, `usdToInr`.
`parseMinorUnits` rejects sub-paise precision. `mulP` goes through integer micros,
truncating toward zero. `formatInr` does Indian digit grouping (₹2,15,000) and compact
units (₹13.54L / ₹1.24Cr) with exact thresholds at 100000 / 10000000 whole rupees.

### Schema — `migrations/0001_phase0.sql`

16 tables: `instruments, snapshots, holdings, lots, buckets, bucket_flows, milestones,
rsu_grants, rsu_vests, loans, loan_schedule, ips_versions, fx_rates, incidents,
settings_rails, audit_log`. Money columns are `BIGINT`. `holdings.avg_cost_paise` is
deliberately NULLABLE (NULL = unknown cost). Append-only enforced on `audit_log` and
`snapshots` by four statement triggers — UPDATE/DELETE **and** TRUNCATE.

### Planning assumptions — `src/config/assumptions.ts`

Single source of truth for PRD §15.2. Equity CAGR 12% ±3%, inflation 6%, SWR 3.5%/4%,
SIP step-up 10%, **`salaryStepUp` 10% — separate key from `sipStepUp` on purpose** (equal
today; do not re-merge them), RSU refresher $20k/yr over 4 years net 70%, seed USDINR 95.3,
seed NOW price $127.54, child arrives 2028 (−₹10k/mo), FI at age 55, owner born 1995,
FI income floor ₹3L/mo, stretch ₹5L/mo.

---

## Gotchas learned the hard way (each cost a fix round)

- **PGlite returns `bigint` columns as JS numbers, not strings**, and `date` columns as
  `Date` objects. The plan's own T8 test asserted `net_paise === '900000'` and would have
  failed on that alone. Always widen through `BigInt()`; never compare a bigint column to a
  string literal. (Precision is lost above 2^53 paise ≈ ₹90,000Cr — not reachable here.)
- **PGlite is a SINGLE connection**, so a query issued on the outer `Db` while a
  `withTransaction` is open still lands *inside* that transaction. A test cannot distinguish
  "inside the tx" from "outside" that way — mutation-check transaction wrapping by removing
  `withTransaction` outright, not by moving one statement out of it.
- **Multi-statement SQL needs the simple protocol.** Neither driver accepts it through
  the parameterized/extended path. Hence `Db.exec`.
- **postgres-js is a pool.** Raw `begin`/`commit` as separate `sql.unsafe()` calls can land
  on different connections. Transactions must go through `sql.begin()`.
- **Postgres does not fire DELETE triggers on TRUNCATE.** Append-only needs its own
  `before truncate ... for each statement` trigger or the audit trail can be wiped.
- **`snapshots` refuses UPDATE and DELETE** (append-only trigger), so an upsert on it must
  be `on conflict ... do nothing` + select, never `do update ... returning`. Since `0003` it
  also carries `unique (business_date, source)` — writeSnapshot's select-then-insert was
  check-then-act, and two racing syncs would each insert and double-count the portfolio.
- **Append-only now covers four tables, and `lots` is a special case.** `audit_log`,
  `snapshots`, `ips_versions` and `bucket_flows` refuse UPDATE, DELETE and TRUNCATE.
  `lots` cannot be blanket append-only — closing a lot on disposal is a legitimate
  UPDATE of `closed_on` — so `sentinel_lots_immutable()` refuses DELETE/TRUNCATE and
  allows an UPDATE only when every column except `closed_on` is unchanged.
- **RLS is enabled on all 18 tables in `0004`, with no policies.** That denies `anon` and
  `authenticated` outright while the owner/service role bypasses, which is the right
  posture for a single-user agent. **Not** `force row level security` — that applies to
  the owner too and would lock the jobs out. `DATABASE_URL` must therefore be the
  service-role/owner string. The PRD constraint was triggers *plus* RLS, and RLS had
  existed only as a comment saying it would be added at provisioning — migrations are the
  only path to Supabase, so it would never have been applied.
- **A curated instrument row beats the payload.** `writeSnapshot`'s `on conflict (id)` used
  to `set name = excluded.name`, which overwrote the owner-verified "Sammaan Capital Limited"
  with the API's stale pre-rebrand "Indiabulls Housing Finance Ltd". It now enriches only
  columns the curated row left NULL (`isin`, `sector`, `issuer`) and never touches `name`.
- **`import.meta.url === "file://" + process.argv[1]` NEVER matches on Windows.** argv[1] is
  a drive path (`D:.ts`), the URL is `file:///D:/a/b.ts`. Every CLI entrypoint guarded
  that way was a silent no-op that exited 0 — `pnpm migrate` reported success against an
  empty database. Use `isMainModule()` from `src/util/main-module.ts`, never a hand-rolled
  comparison.
- **An unset GitHub Actions secret interpolates to `''`, not `undefined`.** `openDb` read
  that as "use the embedded PGlite" and produced a confident ₹0 net-worth digest at exit 0.
  A blank-but-present `DATABASE_URL` now throws. Apply the same reasoning to any env read
  that has a "sensible default" — in CI the default fires on a typo, not on absence.
- **`loadEnv` demands nothing by default** (it used to default to `['all']`, which crashed
  both scheduled jobs on startup over credentials neither reads). A job must name its
  purpose, which is also the only way it gets the narrowed `CryptoEnv` / `TelegramEnv` type.
  Each job module exports `ENV_PURPOSES`, and `tests/jobs/workflow-env.test.ts` derives the
  environment from the real workflow YAML and asserts the job starts under it.
- **A NOT NULL test can test nothing.** If the row omits *other* NOT NULL columns, Postgres
  rejects on those first and the test passes regardless. Use real parent fixtures, omit
  exactly one column per negative case, and include a positive control.
- **A guard-rail test that hard-codes both sides catches no regression.** Derive the actual
  side from the real data structure; mutation-check that it goes red.
- **A wide test band hides transcription slips.** An 8%-wide band let a ₹1L error through
  (`555_400` vs the correct `655_400` for SMALLCASE-RESIDUE).
- **INDmoney sync design (corrected).** The earlier reasoning — "a CI runner can't complete
  OTP + MPIN, therefore sync must be file-based" — had a true premise and a false
  conclusion. The runner never logs in; it uses a **refresh token minted once
  interactively**. Verified metadata: issuer `https://mcp.indmoney.com/`, endpoints
  `/authorize` `/token` `/register`, scopes `portfolio:read` `market:read`, grants
  `authorization_code` + `refresh_token`. Read-only is enforced by the token's scope.
- **Kite Connect:** order + account APIs free since Mar 2025; market data ₹500/mo; **static
  IP mandatory for order placement** — a Phase 3 concern only, and the deep-link bridge
  avoids it. Phase 0 is read-only.

### Task 10 gotchas (2026-08-22)

- **FundedRatio brand does NOT close parameter injection.** The brand `number & { readonly __brand: unique symbol }` is a subtype of `number`, so it is assignable to a bare `number` parameter. The architecture test documents this honestly: enforcement is via the import graph + allowlist, NOT the type system. Two routes are acceptable: (a) make the type structurally non-numeric (opaque object with `.value` unwrap — a speed bump, not a wall), or (b) drop the brand claim and state plainly that import-graph enforcement is the mechanism, with TODO(Phase 1). The project adopts approach (b) honestly.
- **Money is never a float.** Use `rupees(monthlyInr) * 12n` pattern (not `rupees(monthlyInr * 12)`) to avoid float-before-money anti-pattern. The `rupees()` wrapper then multiplies by the bigint `12n`, keeping everything in integer paise.
- **`funded_status` is unreadable by any sizing or risk function.** This task *is* that constraint. Do not weaken the architecture test to make anything pass. No catch-up behavior.
- **Architecture test enforces the funded_status firewall via a REAL import-graph walk.** `tests/architecture/no-catch-up.test.ts` reads `src/**/*.ts` off disk, extracts every relative specifier (static, side-effect and dynamic), and computes the TRANSITIVE closure of modules that reach `src/domain/funded-status.ts`. That set must equal the allowlist exactly — currently `src/domain/buckets.ts`, `src/notify/digest.ts`, `src/jobs/digest.ts` — so both an unlisted reacher AND a stale listing fail. Three further guards: no module matching `/(sizing|size|risk|recommend|rebalanc|allocat|order|trade|position)/i` may be allowlisted; no module outside the allowlist may even NAME `fundedRatio`/`fundedStatus`/`funded_status` (this is the parameter-injection path the type brand cannot close); and the graph must be non-empty, so the suite cannot pass vacuously. **The earlier note here — that the allowlist was `['src/notify/','src/jobs/','src/render/']` and needed narrowing — was false: there was no checker and no allowlist at all.**
- **Two acceptable routes for the FundedRatio brand**: (a) structurally non-numeric opaque object, or (b) honest brand with import-graph enforcement + TODO(Phase 1). Project adopts (b).
- **Architecture test no-catch-up** must assert: every relative specifier in `resolveSpec` resolves to a known key; mutation-check by breaking the assertion; funded ratio bands asserted exactly in paise (not loose `toBeCloseTo`); no `rupees(monthlyInr * 12)` float pattern.

### Task 11A/11B gotchas — the live login (2026-08-22)

- **`cmd /c start "" <url>` truncates an OAuth URL at the first `&`.** cmd.exe treats `&`
  as a command separator and the URL has no spaces, so Node never quotes it: the browser got
  `...authorize?response_type=code` with no client_id, redirect_uri, state or PKCE challenge,
  and cmd then tried to run `client_id=...` as a command. Verified directly. Use
  `rundll32 url.dll,FileProtocolHandler <url>` — the URL stays a single argv element and no
  shell parses it.
- **A callback handler must not collapse its failure modes.** The original rejected with a
  single ternary, so an OAuth error response, a missing `state`, and a stray probe all
  reported as "state mismatch (possible CSRF)" — which sent the first debugging pass at a
  phantom CSRF. Report the provider's own `error` / `error_description`.
- **One stray request must not kill the login window.** The old handler called `reject()` on
  the first non-conforming request to `/callback`, ending a five-minute window. A request
  carrying neither a code nor an error is answered 204 and the server keeps listening.
- **`loadEnv()` blocked a job on credentials it never reads.** `pnpm indmoney:login` died on
  `Missing required environment variable: TELEGRAM_BOT_TOKEN` — and no Telegram bot is
  provisioned. `loadEnv(source, purposes)` now validates per job; `['crypto']` returns a
  `CryptoEnv` whose `tokenEncryptionKey` is a plain `string`, which is what lets
  `Buffer.from(...)` typecheck without a redundant runtime guard.
- **`openDb()` with no DATABASE_URL is an IN-MEMORY PGlite.** The login would have printed
  "Refresh token stored encrypted" and then discarded the database on `close()`. `.env` sets
  `DATABASE_URL=pglite://.pglite`. Nothing in the repo loads `.env` (no dotenv dependency);
  `indmoney:login` runs `tsx --env-file=.env`, every other script still needs exported vars.
- **`TOKEN_ENCRYPTION_KEY` is durable state, not a per-run value.** It decrypts the stored
  refresh token; losing it means re-running the interactive login. It lives in gitignored
  `.env`, generated with `crypto.randomBytes(32)`.
- **DCR persists.** The client is registered once (`d421a08f-…`, public/PKCE-only,
  `has_secret: false`) and reused; a re-run does not re-register.

### Task 11 gotchas (2026-08-22)

- **Kite read-only surface is enforced by an exact method allowlist**, not a negative grep. The test at `tests/sources/kite.test.ts` asserts `Object.getOwnPropertyNames(KiteSource.prototype).filter(...)` equals `['fetch', 'getHoldings', 'name']`; a companion scan of the source file for `/orders|gtt|POST|PUT|DELETE|PATCH` must stay clean. Any mutating endpoint added is a hard failure, not a warning.
- **FileIndmoneySource is a fallback, not the production path.** It reads an owner-refreshed JSON snapshot. Staleness (Task 12) will nag when the file ages. The production `RemoteIndmoneySource` (Task 11B) implements the same `Source` interface and uses a refresh token minted once interactively (`pnpm indmoney:login`). The CI runner never completes OTP+MPIN.
- **`writeSnapshot` is the single upsert path for ALL sources.** It upserts `instruments`, replaces `holdings` for the same (source, business_date), and writes `audit_log`. Never write to `instruments`/`holdings` directly. Every row it inserts carries `as_of` (ISO string from the source) and `source` (the caller's source name).
- **FX sanity band is a data integrity guard, not a config.** `MIN_PLAUSIBLE=50`, `MAX_PLAUSIBLE=200` are hard-coded in `src/sources/fx.ts` because a bad USDINR rate silently misprices the largest single-stock position (US:NOW at ~₹1.2Cr). The band is intentionally wide enough for structural INR depreciation but narrow enough to catch API drift, missing key, or accidental `toFixed` coercion.
- **PGlite bigint columns are JS numbers.** The test in `write-snapshot.test.ts` uses `Number(result[0]!.n)` because `select count(*)` returns a `bigint` column that PGlite surfaces as a JS `number`. This is the same gotcha as Task 8 — widen through `BigInt()` when comparing to a literal, never compare to a string.

### Task 11B — MCP client & RemoteIndmoneySource contracts

**`McpClient`** — `src/sources/mcp-client.ts` is unchanged and works against the live
server (verified end-to-end 2026-08-22): Streamable HTTP POST, `Authorization: Bearer`,
`MCP-Protocol-Version: 2025-06-18`, lazy init, JSON + SSE. Endpoint `https://mcp.indmoney.com/mcp`.

**The original mapper was written against an invented fixture and never worked.** Every
field name in `tests/fixtures/indmoney-holdings-mcp.json` was made up, and the three tests
passed because they fed that invention back to themselves. The real contract, captured
2026-08-22 through the live tool:

- **`networth_holdings` REQUIRES `asset_type`.** Calling it with `{}` returns a pydantic
  `Field required` error. There is NO all-assets call — one call per asset class.
- **The reply is an envelope**: `callTool` returns `{ result: "<JSON string>" }`. Parse
  `result` to get `{ holdings: [...] }`. `payload.holdings` on the envelope is `undefined`.
- **Real row fields**: `investment_code`, `investment`, `asset_type`, `assetclass_l2`,
  `invested_amount`, `market_value`, `holding_percent`, `total_pnl`, `pnl_per`, `xirr`,
  `total_units`, `unit_price`, `broker`, `market_cap`. There is **no `issuer` field at all**
  and no `isin` field — the plan's `name`/`current_value`/`invested_value`/`isin` are fiction.
- **A row's `asset_type` is not the argument that fetched it.** Asking for `IND_STOCK`
  returns rows stamped `STOCK`.
- **`invested_amount` can be the string `'unknown'`** — it is that for **all 29** IND_STOCK
  rows. `typeof === 'number'` is the only safe test; `h.invested_value ? ...` is truthy for
  `'unknown'` and `.toFixed` then throws. Unknown cost is NULL (FR-02), never 0.
- **`investment_code` is polymorphic**: a real ISIN for bonds (`INE148I07GL3`), a numeric
  fund code for MFs (`5536`), an internal id for stocks (`INDS01338`) and US stocks
  (`118186`), and a *company name* for EPF. So ISIN-matching to the seeded bonds works only
  if the code is ISIN-shaped — `/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/`, else prefix `IND:`.
- **The same instrument arrives once per broker/folio.** ICICI Nifty 50 (`5536`) appears 3x
  and Parag Parikh (`3229`) appears 3x. They MUST be aggregated: unaggregated, the largest
  single ICICI row is ₹3.77L against a real ₹7.01L, understating a single-scheme
  concentration, and duplicate ids collide on (snapshot, instrument).
- **Rate limit: 15 calls/min per tool, `networth_holdings` costs 2** (~7 calls/min). A
  throttled call returns **successfully** with `{error: 'rate_limit_exceeded', message,
  retry_after_seconds, ...}` INSTEAD of holdings. Reading that as "no holdings" would wipe
  the portfolio, so it is fatal. The fixture keeps a captured copy as `_rateLimitedResponse`.
  `RemoteIndmoneySource` spaces calls by `spacingMs` (default 9s; tests pass 0).
- **`holding_error` / `position_error` / `is_cached_response` flags** ride on the IND_STOCK
  reply. `holding_error: true` means a partial book — refused, not synced. `is_cached_response`
  is a staleness signal for Task 12.
- **Unmapped `asset_type` throws.** The old `?? 'EQUITY'` default would silently classify an
  unknown holding as equity and feed a wrong asset class into allocation drift and the IPS
  bands. Mapped: STOCK/IND_STOCK/US_STOCK→EQUITY, ETF→ETF, MF→MF, BOND→BOND, EPF→EPF, SA→CASH.
  FD/PPF/NPS are deliberately unmapped (owner holds none — verified 0 holdings each).
- **Money values are INR for every class, US holdings included.** US rows carry
  `currency: 'USD'` on the instrument (matching the seed's `US:` ids) but INR `market_value`.

**IND_STOCK also returns the trading book** — `derivative_positions`, `drv_intra_day_positions`,
`mtf_positions`, `strategy_positions`, `commodity_positions`, `open_orders`,
`open_derivative_orders`. All are null/empty for this owner today. The mapper reads **only**
`holdings` and must keep doing so: persisting an F&O/MTF/intraday structure would build the
first half of a trading path the PRD forbids outright.

**Real capture, 2026-08-22** (52 holdings): IND_STOCK 29, MF 10, US_STOCK 6, BOND 3, EPF 2,
SA 2; FD/PPF/NPS 0 each (confirmed after a rate-limit retry, not assumed).

---

## All three loans — owner-verified 2026-08-14 from lender portals

Every loan in `SEED_LOANS` now comes from a real statement, and every field reconciles
arithmetically. **These are facts, not estimates — do not "correct" them toward the PRD.**

| | outstanding | EMI | rate | natural end |
|---|---|---|---|---|
| car1 (HDFC …7670) | ₹2,22,006 | ₹13,821 | **7.65%** | Jan 2028 |
| car2 (BoB …8366) | ₹4,68,205 | ₹17,223 | 7.95% | Mar 2029 |
| home (SBI, 2 a/cs) | ₹29,63,143 | ₹24,482 | 7.95% | Dec 2046 |
| **total** | **₹36.53L** | **₹55,526** | | |

car1's rate was wrong in the seed (7.95% → **7.65%**) and its principal was ₹6.50L against
the real ₹8,96,761 (= ₹6,74,755 paid + ₹2,22,006 outstanding, an 84-month loan from Feb
2021). car2's outstanding was ₹4.95L against the real ₹4,68,205; ₹5.50L over 36 months at
7.95% gives exactly the ₹17,223 EMI, confirming a 3-year term ending Mar 2029.

The PRD's ₹36.7L loan total is stale by ₹0.17L. The verified figures win.

**Cascade output with real data** (`runCascade(SEED_LOANS, '2026-09-01')`, re-verified by
execution 2026-08-15): car1 `2028-02-01`, car2 `2028-09-01`, home **`2033-12-01`**, interest
saved **₹19,26,308** (natural ₹31,01,145 − cascade ₹11,74,837) — against the PRD's
independently stated ~Dec 2033 and ~₹19.3L. The model never saw either figure.

**These three dates are the only correct ones.** Two other closure sets appeared in earlier
drafts of this file (Jan 2034 / ₹19.07L, and car1 2028-01 · car2 2028-10 · home 2034-03);
both predate the seed corrections and are wrong. Never write any of them as a literal —
derive from `closures`.

## Home loan detail — RESOLVED 2026-08-14 from the owner's SBI portal

The loan is **two accounts**, same rate and origination, modelled as one line (amortization
at a shared rate is linear, so the sum behaves identically):

| a/c | sanctioned | outstanding | EMI |
|---|---|---|---|
| …7807 | ₹30,00,000 | ₹29,09,463 | ₹23,988 |
| …8245 | ₹56,924 | ₹53,680 | ₹494 |
| **total** | **₹30,56,924** | **₹29,63,143** | **₹24,482** |

The seeded EMI was already right; the **outstanding was ₹60,857 too high** and the
principal was wrong. Corrected, the natural payoff lands ~Dec 2046 — so the old
`naturalEndOn` of Feb 2047 was also roughly right, and the earlier "Mar 2048" reading was
an artifact of the bad balance alone.

**The portal's "Remaining Tenure" field is stale — do not trust it.** It reads 379 months
on …7807 and 246 on …8245; neither reconciles with that account's own balance, EMI and
rate (379 months at ₹23,988 would require a ₹33.24L balance). Balance + EMI + rate are the
hard facts; derive tenure, never read it.

Corroboration that the model is sound: with real figures the cascade closes the home loan
**Dec 2033** saving **₹19.26L** of interest, against the PRD's independently-stated
~Dec 2033 and ~₹19.3L. Both within 1%, and the model never saw either number.
(An earlier "Jan 2034 / ₹19.07L" reading here was stale — see the verified block above.)

## Task 6 — resolved by review

The brief's reference `runCascade` was **defective**: it amortized sequentially (a later
loan idle until the earlier closed), which fails its own flat-outflow criterion by
construction — month 1 yields ₹13,821, not ₹55,526 (= 13,821 + 17,223 + 24,482, i.e. all
three EMIs paying at once). The implementer's concurrent rewrite is correct and required.

Verified by executing the shipped code: `freedEmi` accumulates additively (the sum of
*all* freed EMIs, not just the latest), targets the earliest-`cascadeOrder` **open** loan,
and is recomputed each month; steady-state months total exactly ₹55,526.00; closure-month
stubs are capped at `min(scheduled, balance + interest)` so nothing overpays. `openLoan`
is fixed at the *start* of the month, so redirection correctly begins the month **after** a
closure — that is why the stub months dip below ₹55,526 (₹41,707 in 2028-02, ₹42,466 in
2028-09, ₹24,307 in the final month 2033-12). **Any consumer asserting flat outflow must
exempt `closures.values()`.** The closure dates written here in an earlier draft
(2028-01 / 2028-10 / 2034-03) were stale; the verified set is in the block above.

That makes four tasks in a row (2, 3, 5, 6) where the plan's reference code contained a
real defect. **Treat the plan's implementation snippets as a sketch, not as truth** —
brief the acceptance criteria and let the implementer derive the code.

## Task 7 — surplus curve

Derived, never hardcoded: **₹82,124/month** investable at Sep 2026
(₹2,15,000 − ₹55,526 loans − ₹77,350 fixed). The PRD's ₹76,000 is *inclusive of existing
SIPs*. **The ~₹6,124 gap is NOT electricity** — the owner confirmed 2026-09-13 that the
₹10,000 `misc` bucket already includes electricity, so no separate electricity figure is
expected and none may be invented. The gap's real cause is open: the PRD may mean the
surplus *after* existing SIP contributions, but the model has no SIP block, so do not
subtract an invented SIP number under the "incl. SIPs" reading. Record as an owner true-up
and surface it — never tune the model to hit ₹76,000.

- Take-home steps up each **April** at `ASSUMPTIONS.salaryStepUp`, not `sipStepUp`, counted
  from **`BASE_TAKE_HOME_AS_OF` = '2026-09-01'** — the epoch the PRD figure is quoted at,
  NOT the caller's `from`. Anchoring to `from` made the same calendar month pay differently
  depending on when the projection started, silently rebasing salary for a later caller.
- Loan release is a consequence of the cascade (home closes 2033-12), never a date literal.
- **`projectSurplus`'s coverage guard is derived from the outflow map's OWN key range**
  (every month at or before `max(keys)` must be present), plus an outright refusal of an
  empty map when `months > 0`. `closures` is kept as an ADDITIONAL tail signal and stays in
  the interface, but **nothing may depend on it being populated**: it is returned only by
  `runCascade` and persisted NOWHERE (`loan_schedule` has no closure column), so a Task 8+
  consumer reading a schedule back from Postgres passes an empty map. Keying the guard off
  `closures` alone made it a silent no-op there and inflated surplus by the full ₹55,526.
- **Never assert the release on annual investable totals.** Take-home compounds 10%/fiscal
  year, so by 2033 two years of growth swamps a ₹55,526 release: a projection where the
  release NEVER happens still shows y2035 > y2033. Assert `loanOutflowPaise` directly.
- **Open, tied to Task 10:** the child dent (₹10k/mo from Jan 2028) has **no end
  condition**. PRD §2.2 ends it at B4 activation; B4 does not exist yet, so a `TODO(Task 10)`
  sits on `childDentFor`. Over the 300-month annual view it runs 22 years and understates
  late-horizon surplus. **Gate it when B4 lands.**
- **`AnnualSurplus.flags` carries three caveats, plus `monthCount`.** `RENT_TO_EMI_FLAG` on
  every row (rent still modelled as rent, no Hyderabad purchase date — narrow it and move
  rent into the cascade when one exists); `CHILD_DENT_NO_END_FLAG` on every year carrying a
  dent (the open-ended dent above, up to ₹1.2L/yr understated); `PARTIAL_YEAR_FLAG` where
  `monthCount < 12`. The head and tail years of a window are partial — from 2026-09 the
  2026 row holds 4 months and the 2051 row holds 8, which unflagged reads as a 3.5x jump
  and a 27% collapse that are pure artifacts. **Any new caveat goes on `flags`**: a consumer
  seeing one flag reasonably concludes it is the only one.

## Task 8 — RSU vest projection

Derived, never hardcoded: **469.375 unvested units / ₹57,05,047.56** (`570_504_756` paise)
at `asOf` 2026-09-01, at $127.54 × 95.3. Working: G2021 and G2022 have fully vested by then;
G2023 2 tranches × 10.3125, G2024 6 × 11.875, G2025 10 × 12.8125, G2026 14 × 17.8125.
**The PRD's ₹53.25L is ~7% lower — that gap is an OWNER TRUE-UP, not a modelling error**
(see the true-up list below). Asserted exactly, so it fails loudly.

- **Tranches are allocated cumulatively**: tranche k gets `floor(T·k/16) − floor(T·(k−1)/16)`
  for units, gross and net alike, so 16 parts always sum back to the whole grant. Rounding
  each tranche independently (the plan's sketch) leaves a projection whose parts need not
  add to its whole. A per-grant reconciliation test asserts parts == whole for all **six**
  seed grants, with a `checked` counter tied to `SEED_RSU_GRANTS.length`.
- **USD prices go through `dollars()`**, never `Math.round(price*100)` — `127.54*100` is
  `12753.999999999998` and `127.545*100` is `12754.500000000002`. A sub-cent price is now
  *rejected* rather than silently rounded.
- **`withRefreshers` skips any year that already carries a real grant**, derived from the
  `grants` argument. Without it `fromYear: 2026` emitted `REFRESH-2026` beside the real
  285-unit G2026 and overstated the pipeline by a whole grant.
- **`confirmVest` recomputes `gross_paise`** from the confirmed units/price/FX (the sketch
  wrote only `net_paise`, leaving the row's implied withholding rate wrong), rejects a net
  above that gross, rejects a **negative** net, units or price (the one-sided `net > gross`
  test accepted `units: 0` with a −₹5L net), rejects an unknown id, and stamps
  `source = 'owner-confirmed'`. The row update and its `audit_log` insert run in ONE
  `withTransaction` — a confirmation with no audit row cannot be back-filled, since the
  table refuses UPDATE. `confirmed_on` is derived from the injectable `asOf`, never
  `current_date`.
- **`persistVests(db, vests, {asOf?})`** — `asOf` injectable so runs are reproducible. No
  `source` override: these rows are always PROJECTED / `'model'`.
- **FR-03 is enforced in the SQL, not in control flow.** `rsu_vests` carries
  `unique (grant_id, vest_on)` (added in `0001` during the T8 fix round — nothing was
  deployed, so there was no migration to preserve), and the write is a single
  `insert ... on conflict (grant_id, vest_on) do update ... where rsu_vests.status <>
  'ACTUAL'`. The original read-then-write was **check-then-act and defeatable**: a
  `confirmVest` landing between the SELECT and the UPDATE lost, and because that UPDATE
  never touched `status` the row was left reading `status = 'ACTUAL'` while carrying the
  model's units, money and `source = 'model'`. A `Db` proxy test drives a real confirmation
  into that window. **Any future check-then-act on an owner-confirmed row is the same bug.**
- **`unvestedValue` sums exactly what it is given.** A projection window that stops short of
  the last tranche understates the pipeline silently — project the full range.
- **Refresher grants have no `rsu_grants` row**, and `rsu_vests.grant_id` is a FK, so vests
  projected from `withRefreshers` output **cannot be persisted**. Scenario input only. The
  `rsu_grants.scenario` column ('ACTUAL'|'REFRESHER') exists for the day they are;
  `RsuGrantSeed` carries no `scenario` field yet.
- **A vest ON the `asOf` date is VESTED**, not unvested: `unvestedValue` filters `vestOn >
  asOf`, strictly. Pinned by a test whose `asOf` is an actual tranche date.

## Task 9 — net worth and allocation drift

Derived, never hardcoded. **Assets ₹47,68,999.61 (`476_899_961` paise)**; liabilities at
2026-09-01 **₹36,21,975.95 (`362_197_595`)** — the cascade's closing balances after one
month, *not* the ₹36,53,354 seed outstanding. Both asserted exactly.

- **The plan's claim that the seed breaches the *Sammaan* issuer cap is FALSE.** Sammaan is
  ₹3,79,999.61 / ₹47.69L = **7.9681%**, under the 10% cap. Nothing was tuned.
- **The seed does breach the issuer cap — as `ServiceNow`, at 10.4844%.** `US:NOW` carries
  `issuer: 'ServiceNow'`, so the employer and single-issuer caps fire on the same money.
  Any consumer counting breaches must expect that pair, not double-count it as two risks.
- **Full real breach set (4):** single-stock `NSE:SMALLCASE-RESIDUE` **13.7429%**,
  single-stock `US:NOW` **10.4844%**, employer `US:NOW` 10.4844%, issuer `ServiceNow`
  10.4844%. No MF-scheme breach (top scheme `MF:ICICI-NIFTY50-IDX` 14.59% vs a 35% cap), no
  sector breach (Technology 10.48% vs 25%).
- **Allocation:** EQUITY 53.95%, DEBT 41.31%, CASH 3.42% all inside band; **GOLD 1.32% is
  UNDER its 5% floor — ₹1,75,449.98 of gold to buy.** The only IPS drift the seed produces.
- **`instruments.kind` admits `'LOAN'`; the plan's `InstrumentKind` omitted it**, so a LOAN
  row fell through `classify` to EQUITY and would be summed into *assets*. `classify` now
  throws on LOAN. Keep the union in step with the schema check constraint.
- **`outstandingLiabilities` falls back to `loans.outstanding_paise`** via a lateral join.
  A plain `where period_month <= $1` returns no row for a month before the schedule starts
  and reported **zero** liabilities against a real ₹36.53L.
- **`allocationDrift(byAssetClass, total?)` derives `total` and rejects an inconsistent
  one.** Two arguments describing one portfolio is a silent-wrong-answer hazard.
- `driftPaise` goes through `mulP` integer micros. Never `Math.round(pct * Number(total))`.
- `concentration` aggregates by instrument/issuer/scheme/sector **before** comparing to a
  cap — the same stock in two accounts is one exposure.
- **`sectorCoveragePct` + `SECTOR_COVERAGE_CAVEAT`:** only `US:NOW` and `NSE:RPOWER` carry a
  sector, so the 25% sector cap sees **10.54%** of the portfolio. It is reported, not
  silently passed. `TODO(Task 11B)` — the sync supplies the rest.
- **`NSE:SMALLCASE-RESIDUE` and `US:INDMONEY-BASKET` are baskets modelled as one EQUITY
  line**, so the residue reports as a 13.74% *single-stock* breach it may not really be.
  That is faithful reporting of the data we have; the fix is decomposition in Task 11B, not
  an exemption list. Owner true-up below.

## Owner true-up items (need real statements — do not guess)

**Gold holding changed (owner, 2026-08-25): RESOLVED same day.** "GoldCase" IS the
`IND:INDS29570` line (~₹65k) INDmoney reports as "Zerodha Gold ETF" — owner-confirmed
identity, naming only. Seed `NSE:GOLDBEES` retirement through the canonical twin is
CORRECT; no structural change.

**Dup-lot cleanup (2026-08-25): DONE.** Owner chose full cleanup, majority-cost keeper.
60 of 89 owner-telegram lots closed via UPDATE closed_on (the only permitted mutation),
each with a CLEANUP_CLOSED audit row naming its survivor and reason; 29 open remain,
exactly one per (instrument, account), 0 anomalies. Conflicting-cost groups resolved by
recurring value (Kirloskar ₹273.38 outlier closed; Tata Motors PV kept ₹18,789.88,
Tata Motors Ltd kept ₹41,530.77). Owner will re-upload statements under the fixed bot to
re-record costs authoritatively — new lots supersede via the newest-open-lot rule.

**RESOLVED 2026-08-22 from the owner's INDmoney bonds screen.** The screenshot reconciles to
the rupee with the table below, so `SEED_HOLDINGS` bond cost stands unchanged. What the live
MCP payload gets wrong, and must never be allowed to overwrite:

1. **`invested_amount` is FACE VALUE, not cost — confirmed exactly.** **ENFORCED IN CODE
   2026-08-23:** `aggregate()` in `src/sources/indmoney.ts` returns `avgCostPaise = null`
   for every `kind === 'BOND'` row. The shipped mapper wrote the face value straight into
   cost; three tests in `tests/sources/indmoney-bond-cost.test.ts` now hold the line,
   derived from the real capture. API returns 300000 /
   100000 / 220000, which is precisely units x face (300x1,000, 1x1,00,000, 220x1,000). The
   portal's Investment column is 2,84,057.70 / 95,941.91 / 2,20,000 = **₹5,99,999.61**, its own
   stated Total Investment. The two Sammaan bonds were bought below par — which is exactly why
   their YTM (11.29%, 11.70%) exceeds their coupon (9%, 9.75%). Edelweiss matches face only
   because it was bought at par. **Never map `invested_amount` to `avgCostPaise`.**
2. **`total_pnl` / `pnl_per` are also computed against FACE, not cost.** API pnl sums to
   ₹35,797.84 (= market − face). True unrealised against cost is **₹55,798.23**. The API
   understates it by ₹20,000.43. **Never use the API's P&L fields for bonds.**
3. **The issuer question is settled, and the API is the unreliable side.** The portal shows
   INE148I07GL3 and INE148I07TX1 BOTH as **SAMMAAN CAPITAL LIMITED** (same name, same logo).
   The MCP payload returns the stale pre-rebrand name *Indiabulls Housing Finance Ltd* for
   INE148I07GL3 while calling INE148I07TX1 *Sammaan Capital Ltd*. So §3.5's single-issuer cap
   **cannot** be derived from the payload's `investment` name — name-matching would see two
   issuers and miss a ₹3.80L / 63%-of-bucket concentration. Needs an explicit ISIN→issuer map
   before the sync feeds `concentration`. **TODO — not yet implemented.**
4. **"Returns Till Date" ₹1,19,480 is confirmed as exactly 2 years of coupon on face**, per
   line: ₹54,000 + ₹19,500 + ₹45,980. Cash already received, not accrued value. Do not add it
   to holding values — that part of this file was right.
5. **The PRD's ₹6.33L is NOT the coupon double-count this file claimed.** Cost + all coupons =
   **₹7,19,479.61**, not ₹6.33L; market is ₹6,55,797.84; cost is ₹5,99,999.61. ₹6.33L
   reconciles with none of them and remains **unexplained**. The earlier "roughly what the
   PRD's ₹6.33L looks like" reading is withdrawn.

**OPEN (fix wave, item 27): `milestones` has no `raised_on` column.** `daysOutstanding`
used to be counted from a hard-coded `'2026-01-01'` that appears in no assumption, no seed
row and no PRD line — a fabricated figure shown to the owner as fact. It is now `null` for
an open milestone, and the digest omits the count. To restore it, add `raised_on` to
`milestones` and seed it from the date the owner actually set each protection goal.
`daysSinceCompleted` is separate and IS derivable.

**Still open from this:** the +₹55,798.23 of unrealised mark moves Task 9's assets figure,
asserted exactly at `476_899_961` paise. Bonds are seeded at cost; the first real sync marks
them to market and that assertion moves in the same commit.

**NEAR-TERM EVENT: INE148I07GL3 matures 26-Sep-2026** — about five weeks out. ₹3,00,000 face
plus a final ₹27,000 coupon redeems to cash, retiring half the bond bucket and pushing CASH
above its band. Nothing models a maturity yet; the surplus curve and IPS drift both need it.

**OPEN (2026-08-22): the entire Indian equity book has no cost basis.** All 29 IND_STOCK
rows return `invested_amount: 'unknown'` (they are Groww/Zerodha-linked). P&L, XIRR and any
cost-based reporting are unavailable for ~₹8L of holdings until the owner supplies cost, and
FR-02 keeps them NULL rather than 0.


**OPEN (Task 9 → fix wave item 30): two IPS bands have NO PRD source.** The earlier note
here said PRD §3.3 verbatim was "still outstanding" — **stale**. The PRD is in the repo and
§3.3 reads in full: *"Debt/EPF/cash: remainder; EPF counts as debt-like."* A remainder is an
identity, not a band. So `IPS_BANDS.DEBT.min = 0.25` is an **invented floor** (it makes a
zero-debt portfolio report an UNDER breach the PRD never asks for) and `CASH.max = 0.20` has
**no source at all**. `EQUITY.max ~60%` and `GOLD 5–10%` ARE verbatim and are not in doubt.
Neither number was tuned or removed — that is the owner's call. Both are now named in
`UNSOURCED_BANDS` and the digest prints `UNSOURCED_BAND_CAVEAT` under the allocation table.
**Owner decision needed: confirm both, or set them to the PRD's residual reading.**

**OPEN (Task 9): basket decomposition.** `NSE:SMALLCASE-RESIDUE` (₹6,55,400) and
`US:INDMONEY-BASKET` (₹1,37,000) are baskets held as single EQUITY lines. Until Task 11B
supplies constituents the single-stock cap has one likely false positive and one blind spot.


- ~~Home loan~~, ~~car loan 1~~, ~~car loan 2~~, ~~loans total~~ — **all resolved
  2026-08-14** from lender portals; see the verified table above.
- ~~Bonds~~ — **resolved 2026-08-14**, see below.

**OPEN (Task 8): the RSU per-grant unit split.** The PRD never published it; the six-grant
breakdown totalling 1,105 units was *reconstructed*. The model's unvested total is
₹57,05,047.56 against the PRD's ₹53.25L — a ~7% gap that is a **data** question, not a
modelling one. **Needs the owner's Fidelity statement** (per-grant units and grant dates).
Nothing was tuned toward ₹53.25L; when the real split arrives, `SEED_RSU_GRANTS` and the
exact assertion in `tests/domain/rsu.test.ts` move in the same commit. **Expect to rework
the test, not just its expected value:** `tests/domain/rsu.test.ts:80-82` uses
`BigInt(totalUnits)`, which throws the moment any grant carries fractional units, and its
per-grant net sum holds only because every `12754 x units` product happens to end in 0.
Both fail loudly rather than silently, which is why they were left as they are.

Otherwise no open data gaps: every figure in `SEED_HOLDINGS` and `SEED_LOANS` is either
owner-verified or explicitly marked as a PRD-stated value.

## Bonds — owner-verified 2026-08-14 from the INDmoney bonds screen

| ISIN | units | coupon | YTM | invested | matures | next coupon |
|---|---|---|---|---|---|---|
| INE148I07GL3 (Sammaan) | 300 | 9.00% | 11.29% | ₹2,84,057.70 | 26-Sep-2026 | 26-Sep-2026 |
| INE148I07TX1 (Sammaan) | 1 | 9.75% | 11.70% | ₹95,941.91 | 23-Jul-2029 | 23-Jul-2027 |
| INE532F07EK1 (Edelweiss) | 220 | 10.45% | 10.44% | ₹2,20,000.00 | 26-Oct-2033 | 26-Oct-2026 |
| **total** | | | **10.86%** | **₹5,99,999.61** | | |

Sums to the portal's own stated Total Investment to the paise, so **the PRD's ₹6.33L for
this bucket is superseded**. Two things to keep straight:

- These are **invested amounts, not marks.** The screen reports cost, so `valuePaise ==
  avgCostPaise` and unrealised P&L reads as zero until Task 11B supplies real marks.
- The portal's ₹1,19,480 "Returns Till Date" is **cash already received**, not accrued
  value — it is exactly 2 years of coupon on each of the three lines, and coupons here pay
  out annually rather than compounding into the bond. **Do not add it to the holding
  values.** That double-count is roughly what the PRD's ₹6.33L looks like.
- Concentration note for §3.5: **two of three bonds are the same issuer** (Sammaan
  Capital, ₹3.80L = 63% of the bond bucket). The single-issuer cap must see them as one.

`InstrumentSeed` now carries `isin`, and `seed.ts` writes it (the schema column existed but
went unwritten). Task 11B's mapper matches on ISIN, so this is load-bearing; two tests
cover it, both mutation-checked.
- **Holdings total is exact at ₹47.69L** — EPF 13.54L, MF 11.83L, stocks/ETFs 8.32L,
  bonds 6.00L, savings 1.63L, US basket 1.37L, Fidelity NOW 5.00L.

## FI corpus band — PRD-derived, settled 2026-08-23

PRD: *"At a 3.5% safe withdrawal rate (appropriate for Indian inflation; 4% carried as
optimistic sensitivity), this implies a corpus of ₹10.3 Cr (floor) to ₹17.1 Cr (stretch)
in today's money (₹9–15 Cr at 4% SWR)."*

So the **band varies the INCOME** (floor ₹3L/mo → stretch ₹5L/mo) at one SWR, and the SWR
is a **separate sensitivity axis**. `computeFICorpusBand(swr = swrFloor)` reproduces all
four PRD figures exactly:

| swr | floor | stretch |
|---|---|---|
| 3.5% | `10_285_714_285n` (₹10.2857 Cr) | `17_142_857_142n` (₹17.1428 Cr) |
| 4.0% | `9_000_000_000n` (₹9.00 Cr) | `15_000_000_000n` (₹15.00 Cr) |

The shipped code took **one** income and varied only the SWR, so `stretch` came back as
the floor income at 4% — ₹9.00 Cr, **₹1.29 Cr below the floor target**. `stretchRatio`
therefore exceeded `floorRatio` for every possible input: the owner read as *better funded
against the harder goal*. `computeFICorpusBand` and `fundedRatio` were also duplicated
verbatim in `buckets.ts`; `buckets.ts` now re-exports them, so there is exactly one model
and an import allowlist anchored on `funded-status.ts` cannot be sidestepped through
`buckets.fundedRatio`. A test asserts the two exports are the *same function object*.

Dropped as dead: `isInBand` (hard-coded all three arguments in its only test, no production
caller) and `fiCorpusTargetPaise` (a verbatim alias of `computeFICorpusBand`).

## C-A — seed/sync double count, and the full instrument reconciliation

**Reproduced 2026-08-23 exactly:** seed alone = `476_899_961n` (₹47,68,999.61); after ONE
INDmoney sync of the real capture = `910_277_209n` (₹91,02,772.09). Inflation ₹43,33,772.48
over 47 synced rows. Matches the review's independent measurement to the paise.

Two live causes (the third, `isin` missing from the instruments insert, is **fixed** in
`8346b24`):

1. **Id namespaces do not meet.** Only the **3 bonds** carry an ISIN. Everything else uses
   INDmoney's internal code — `INDS01338`, `3229`, `118186` — or free text for EPF/savings.
   An ISIN-only reconciliation covers 3 of 47 rows.
2. **No supersession rule.** `loadPositions` does `distinct on (s.source)`, merging the
   latest snapshot from *every* source. Nothing ever retires `manual-seed`.

**Owner decision (2026-08-23):** live source wins per `(canonicalInstrumentId, account)`;
the seed still supplies what no live source can see; a holding a live source stops
reporting **falls back to the seed row** rather than vanishing (safer against a partial API
reply; staleness already flags the source).

### The reconciliation, derived by value — every bucket ties out

| seed instrument | seed ₹ | live code(s) | live ₹ |
|---|---|---|---|
| `EPF:ANIRBAN` | 13,54,000 | 2 × EPF (ServiceNow) | 13,53,592 |
| `MF:ICICI-NIFTY50-IDX` (3 rows) | 6,96,000 | `5536` | 7,01,062 |
| `MF:PPFC` | 2,41,000 | `3229` (×2 brokers) | 2,47,987 |
| `MF:ICICI-LARGECAP` | 2,03,000 | `2995` | 2,01,410 |
| `MF:HDFC-MIDCAP` | 19,000 | `3097` | 22,386 |
| `MF:BANDHAN-SMALLCAP` | 18,000 | `1005544` | 20,077 |
| `MF:MOTILAL-MIDCAP` | 6,000 | `3113` | 6,225 |
| `NSE:NIFTYBEES` | 95,000 | `INDS19182` | 94,652 |
| `NSE:GOLDBEES` | 63,000 | `INDS29570` *(named "Zerodha Gold ETF")* | 65,426 |
| `NSE:LIQUIDBEES` | 16,000 | `INDS28892` *(named "Zerodha Nifty 1D Rate Liquid ETF")* | 16,183 |
| `NSE:RPOWER` | 2,600 | `INDS01338` | 2,650 |
| `NSE:SMALLCASE-RESIDUE` | 6,55,400 | **the other 24 IND_STOCK rows** | 6,45,905 |
| `CASH:SAVINGS` | 1,63,000 | 2 × SA (Federal ₹10, HDFC 1,63,336) | 1,63,346 |
| `US:INDMONEY-BASKET` | 1,37,000 | **the 6 US_STOCK rows** | 1,37,070 |
| `BOND:*` ×3 | 5,99,999.61 | the 3 ISINs | 6,55,797.84 |
| `US:NOW` | 5,00,000 | *(none — Fidelity, invisible to INDmoney)* | — |

Bucket totals tie to MEMORY's own stated figures: MF live 11,99,148 vs seeded 11,83,000;
IND_STOCK live 8,24,816 vs seeded 8,32,000. **This is a derivation, not a guess** — but it
is the owner's balance sheet, so it needs confirmation before being hard-coded.

**Two open items this CLOSES once implemented:**
- *Basket decomposition* — `NSE:SMALLCASE-RESIDUE` decomposes into 24 named live stock
  rows, so the 13.74% "single-stock" breach it reports today is a **false positive**, and
  the largest real single-stock line is Tata Motors at ~₹47,255 (~1%). Same for
  `US:INDMONEY-BASKET` → 6 named US holdings.
- *Sector coverage* — 10.54% today; the decomposed rows are what lift it.

**Expect the exact assertions to move.** `476_899_961n` in `networth.test.ts` and the breach
set in `allocation.test.ts` are pinned to the seed at cost. Marking to market moves both, in
the same commit, as MEMORY already anticipated for bonds (+₹55,798.23).

## Production reconciliation fix (2026-08-25)

First real sync exposed two defects that kept seed/live duplicates alive (~₹35L double-count):
1. **Prefix bug**: mapper looked up `INDMONEY_TO_CANONICAL[id]` with prefixed ids (`IND:5536`)
   while keys are bare (`5536`) → every non-bond live row had NULL canonical.
2. **Account-label mismatch**: live rows were hardcoded `account='indmoney'` while seed uses
   real custodies ('zerodha'/'bank'/'epf') → (canonical,account) never collided.

Fixes, all test-backed (408/408): `resolveCanonicalId()` matches bare/prefixed/ISIN-shaped ids
plus alphanumeric-skeleton statement codes (ServiceNow EPF, `3004965*` bank rows); live rows now
carry **broker-attributed accounts** (normalized `Zerodha `→`zerodha`, blanks fall back by asset
type EPF→epf / SA→bank); aggregation groups per (instrument, broker-folio); seed retirement adds
CANONICAL-ONLY matching (account label ignored for seed; live-live never merged) and retires the
two placeholder baskets (`SMALLCASE-RESIDUE`, `US:INDMONEY-BASKET`) once unmapped live EQUITY rows
exist; an owner-verified seed cost **carries over** to its live twin when the twin reports none
(bond face-value trap). Note: INDmoney DOES report numeric invested amounts for EPF — only
IND_STOCK is 'unknown'.

## Deferred minors (tracked, not blocking)

**Fix-on-touch**: if the task you are running edits one of these files, fix the minor in
the same commit and strike it from this list. Do not let these pile up for the single
end-of-branch fix wave. The "fixes at" column is the expected home, not a hard schedule.

| # | From | Minor | Fixes at |
|---|---|---|---|
| ~~1~~ | T6 | ~~`runCascade`'s month-step duplicates `amortize`'s math — extract `stepLoan()`~~ | **fixed in Task 7** (fix-on-touch) |
| 2 | T4 | No negative-amount tests for `formatInr` / `mulP` / `usdToInr`. Verified by trace only | Task 10 (first negative flows) |
| 3 | T1 | 2 `ASSUMPTIONS` keys still untested (`fiIncomeFloor/StretchMonthlyInr`); `childMonthlyDentInr` covered in T7 | Task 10 |
| 4 | T1 | Planning INR values are plain numbers; consumers must convert to bigint paise | same |
| 5 | T2 | postgres-js path has **no** automated test — no live Postgres here | Task 15, provisioning checklist item 2 |
| 6 | T5 | `tests/seed/seed-data.test.ts` MF subtotal test *title* says "1.83L", asserts 11.83L — cosmetic, value correct | final fix wave |
| 7 | T6 | `persistSchedules` does `delete` + N sequential inserts, unwrapped (`src/domain/loans.ts:144–171`) — matches existing `seed.ts` convention, so genuinely cross-cutting | final fix wave |
| 8 | T11A | `indmoney-login.ts` calls `db.close()` only on the success path, so a failed login never closes PGlite. Survived a real crash intact, so robustness not correctness | Task 15 |
| 9 | T11B | `RemoteIndmoneySource` paces calls with a fixed 9s `spacingMs` rather than reading `retry_after_seconds` from a throttled reply | Task 15, when sync.ts wires it |

---

## Phase 1 Task 7 — signal engine (2026-09-13)

`src/domain/engine.ts` is the §6 engine: `scoreSatellite`, `sectorMedianPe`, `rankMfs`,
`persistSignalScores`, `loadEngineInputs`. Weights are PRD-fixed constants
(`SATELLITE_WEIGHTS`, `MF_WEIGHTS`, `BANDS`, `QUALITY`); the components they weight are what
the tests falsify.

- **Two different "no score" shapes, on purpose.** Blocked by a stale input (FR-31) →
  `scoreSatellite` returns **`null`**: no score exists and nothing is recorded. Quality gate
  failed → a row with `composite: null`, `components: null`, `qualityPassed: false` and the
  failure list, so the weekly report can say *why* a name was rejected. `signal_scores.composite`
  is NOT NULL, so a failed row persists `0` and `quality_passed` is what carries the meaning —
  never read a 0 composite as a score.
- **The quality gate fails closed.** A null ROCE / FCF flag / D-E / red-flag count is a
  *failure*, not a pass. Same posture as FR-02: an unreadable input is never inferred. Finance
  sectors (`FINANCE_SECTORS`) waive the D/E gate only, and the waiver is recorded in `evidence`.
- **What the engine cannot see, and says so** rather than faking: EV/EBITDA and a name's own
  5-year P/E range (the pinned screener.in export carries neither, and one upload is one point
  in time), so valuation rests on earnings yield vs the G-sec plus P/E vs the cohort median.
  Missing legs score 0 *and* push a line into `evidence`.
- **`gsecYieldPct` is a required caller input.** No ingestion source exists for the 10Y G-sec
  yield in Phase 1, and it is not a PRD §15.2 planning constant, so it does NOT go in
  `ASSUMPTIONS` — it is an owner true-up item (PENDING § Waiting on OWNER).
- **Money never becomes a float.** Returns, relative strength and the 200DMA come from `bigint`
  paise / nav micros through integer bps (`(to-from)*10_000n/from`). One MF test drives a NAV
  above 2^53 micros precisely so a float path would show up as a flat series.
- `persistSignalScores` uses `on conflict (instrument_id, score_date) do nothing` — `signal_scores`
  is append-only, so a re-run must not UPDATE. It returns how many rows actually landed.

### `screener` staleness was a stub, and the docs said otherwise (fixed 2026-09-13)

Tasks 5 and 6 recorded "staleness now checks fundamentals". It did not: `assessStaleness`
hard-coded `screener` to `unimplemented`, `getLatestFundamentalsAsOf` was computed and thrown
away, and so `blockedInstruments`'s `fundamentalsStale` branch was **unreachable** — a
fundamentals drought could never block a recommendation. The tests asserted the stub, and their
own comments contradicted their assertions ("screener NOW has ingestion so it's stale" directly
above `expect(state).toBe('unimplemented')`).

Task 6 built the ingestion path, so screener is now assessed like bhavcopy and amfi: an empty
table is a real drought, reads stale, and opens a BLOCK incident. Five test expectations moved
with it — a deliberate behaviour change, stated, not a band widened to make red go green.
**No source is in the `unimplemented` state any more.** Keep the state in the type: the next
source with no ingestion path needs it, and calling an unbuilt feature "stale" is what trains
the owner to ignore the loudest safety signal in the product.

Lesson worth keeping: a ledger entry is not evidence. Both Task 5's and Task 6's entries claimed
this check shipped; the dead local was the tell.

---

## Phase 1 Task 8 — allocation engine (2026-09-13)

`src/domain/alloc-engine.ts` — `rebalanceRec(state, monthYear)`, `sellCandidates`,
`isRebalanceTarget`, `TAX_POLICY_NOTE`.

- **`state.netWorth` is THE basis and `rebalanceRec` throws when the positions disagree with
  it.** The engine never re-derives the portfolio total: two independent numbers describing one
  portfolio is how a caller gets silently wrong percentages back (the same argument
  `allocationDrift` makes about a supplied `total`).
- **Tax awareness is one preference, deliberately not an engine.** New money before a sale
  (a load-free SIP redirection into another class dilutes an overweight one with no
  realisation); a trim only when no route can absorb the drift, ordered losses-first →
  smallest gain → **unknown cost basis last** (FR-02: its tax is unknowable from our data).
  `TAX_POLICY_NOTE` is carried in every rec's `taxNotes` and names what is NOT computed:
  holding periods, LTCG/STCG, §112A, indexation, set-off, surcharge. We hold **aggregated**
  positions, not per-lot acquisition dates — a tax figure here would be invented.
- **A trim is capped at the nearest band edge**, including the last slice, so no recommendation
  can force a sale beyond what §3.3 asks. Mutation-checked.
- Owner constraints are structural, not filters bolted on: `isRebalanceTarget` excludes **EPF**
  in both directions (mandatory payroll ballast, 68.7% of the debt bucket — a debt move that
  touched it would really be an EPF move), and the **Kolkata property is a liability line, never
  a position**, so it cannot reach the engine at all. There is nothing to exclude, which is the
  strongest form the constraint can take.
- `allocationDrift`'s `driftPaise` is the sizing for every action. Against the real seed that is
  the GOLD shortfall of ₹2,04,098.68 (1.18% against the 5% floor) — the tests derive it from the
  drift row so a seed correction or a band change moves both together.

---

## Phase 1 Task 9 — sell / exit triggers (2026-09-13)

`src/domain/sell-triggers.ts` — `evaluateExits(db, state, month)` over §6.5 triggers 1–5 and 7.
Everything it returns is a PAPER object: §6.5's "first-class" means sell candidates exist as
recommendations of kind `sell`, not that anything executes.

- **CONTRACT FOR TASK 10 — `recommendations.primary_rec` is JSON**
  `{ instrumentId, falsification: { metric, op, value } | null }`. The grammar is closed:
  `metric` ∈ `price_paise` | `roce_pct` | `de_ratio` | `red_flags`, `op` ∈ `lt` | `gt`, and
  `price_paise` carries its value as a decimal STRING (money never round-trips a float). Task 10
  must write this shape or trigger 1 goes silently inert. A condition naming a datum we do not
  hold is **untestable → `null` → no exit**; false and unknown are different answers and the
  test pins that.
- **IPS §3.7 is encoded.** The 12-month minimum hold is overridable "only by: thesis
  falsification, red-flag event, or hard-cap breach" — triggers 1, 2, 3. Triggers 4 (sustained
  underperformance) and 5 (better alternative) are NOT overrides: a candidate they raise inside
  the hold comes back with `blockedByMinimumHold: true` and `heldMonths`, not dropped. Holding
  period is the oldest OPEN lot's `acquired_on`; no lot → `null`, never an assumed date.
- **Month END is the data cutoff.** A monthly run reviews its whole month; cutting at the 1st
  judged August against July's data (this is how the first version of trigger 1 failed its own
  test). The maturity window is the month plus a fortnight from the 1st, so a monthly run cannot
  step over a mid-month redemption.
- Trigger 3 reuses Phase 0 `concentration`'s maps. The **sector cap is deliberately excluded**:
  it names a sector, not a holding, and an exit candidate must name something sellable. A sector
  breach is an allocation direction (Task 8), not a per-name exit.
- Trigger 5 is rationed to one per quarter, counted against existing `recommendations` rows of
  kind `sell` whose `engine_evidence` mentions `better-alternative` — so Task 10 must put the
  trigger name in `engine_evidence` when it persists one.
- Trigger 7 covers **maturities only**. Rating actions have no ingestion source, so IPS §3.8's
  standing reviews (Sammaan Jul-2029, Edelweiss Oct-2033) stay owner items — PENDING.

### The funded-status firewall caught a real violation (2026-09-13)

`tests/architecture/no-catch-up.test.ts` went red the moment `sell-triggers.ts` landed:
sell-triggers → `maturities.ts` → `buckets.ts` → `funded-status.ts`. A sizing/risk module was
one import away from learning how funded the owner is, which is exactly the catch-up behaviour
the PRD forbids — and nothing else in the suite would have noticed.

Fixed **structurally, not by widening the allowlist**: the redemption READER moved to
`src/domain/redemptions.ts` (instruments query, no bucket concept), `maturities.ts` keeps
`maturityRoutingRec` and re-exports `listRedemptionsUntil`/`Redemption` for the reporting
surfaces that legitimately reach buckets (digest). Rule for the next task: if the arch test goes
red, the import path is the bug. Adding a line to the allowlist is only correct for a genuine
*reporting* surface.

---

## Phase 1 Task 10 — FR-11/FR-12 recommendations + paper mode (2026-09-13)

`src/domain/recommendations.ts`. A recommendation is a PAPER object: logged and scored, surfaced
in the weekly report, never executed.

- **FR-11 shape, enforced in both directions.** Exactly 2 alternates. A1 shares the primary's
  intent and must name a *different* instrument; with no real challenger it becomes the **index
  route** (`INDEX_ROUTE_INSTRUMENT`) — buying the market is the honest expression of "we want
  this exposure but have no edge on which name carries it", and it beats manufacturing a second
  single-name idea to fill a slot. A2 must carry a *different* intent and defaults to
  **do-nothing**, which is a real option and is written as one.
- **Every `ips_clause_refs` entry is validated against `getIpsClauseIndex(IPS_V1_TEXT)`.** The
  PRD preamble binds every recommendation to cite the clause it serves; a citation the owner
  cannot look up is worse than no citation. `buildRecommendation` throws on an unknown clause.
- **FR-12 caps LOG, they do not drop.** ≤4 recommendations per calendar month, and no repeat BUY
  on a name inside 12 months of the prior one, overridable only by `ips-spec-change`,
  `material-adverse-falsification` or `owner-directive`. A capped action goes to
  `suppressed_actions` with its reason — what the engine wanted and policy refused is exactly
  what the owner needs to see. `suppressed_actions` is keyed `(logged_on, action)`, so the action
  string carries kind + action + instrument to keep same-day suppressions apart.
- **Paper mode defaults TRUE when `settings_rails.paper_mode` is absent.** Phase 1 has no
  execution path at all, so the safe reading of a missing switch is "do not act".
  `scanForExecutionPaths(dir)` walks the source for order-like calls; it skips the file carrying
  `ORDER_LIKE_PATTERNS = [` because the file defining the ban necessarily spells out the names.
- **`primary_rec` is written as the `RecLeg` object**, which already carries `instrumentId` and
  `falsification` — the exact shape `sell-triggers.evaluateExits` reads. A test persists a
  recommendation here and fires Task 9's trigger 1 on it, so the contract is proven live rather
  than merely written down.
- `announceMaturity` takes the routing decision as DATA instead of calling `maturityRoutingRec`,
  keeping this sizing module clear of `buckets.ts` → `funded-status.ts`. Same firewall lesson as
  Task 9, applied before the architecture test had to catch it.

---

## Phase 1 Task 11 — weekly deep report + narration + Sunday cadence (2026-09-13)

`src/notify/report.ts` (gather + pure compose, same split as `digest.ts`), `src/jobs/report.ts`
(`pnpm report [--as-of YYYY-MM-DD]`), `src/sources/llm-narration.ts`. **The Phase 1 DoD is met**
— see the ledger entry for the proof.

- **OWNER DECISION 2026-09-13: the weekly deep report moved Sat 08:00 IST → SUNDAY 10:00 IST**
  (`30 4 * * 0`, PRD §12.2). Signed off explicitly; do not re-litigate.
  `tests/jobs/workflow-schedule.test.ts` is re-derived from the YAML — it converts the cron to
  IST and reads back Sunday 10:00 — and now also pins the digest's `workflow_run` gating, which
  is the replacement for the assertion deleted back when the digest lost its fixed cron.
- **`src/jobs/weekly.ts` and `pnpm weekly` are RETIRED.** `pnpm report` is the only weekly
  entrypoint; it also writes `docs/dashboard.html` for the Pages step. Two entrypoints for one
  job is how they drift.
- **FR-31 covers yesterday's recommendations too.** An open recommendation whose instrument is
  blocked *today* moves to `pipeline.withheld` and is shown under staleness: you cannot act on a
  recommendation you cannot value. Withheld, never deleted.
- **Narration cannot corrupt a number.** `narrate` gets the finished engine output and returns
  prose; **nothing feeds back**. No key, non-200 or throw → `null` → the report ships its
  deterministic bullets. A missing narrative must never cost the owner the report.
- **`GSEC_YIELD_PCT` blank means NOT CONFIGURED, never 0.** `Number('')` is 0, and an unset
  GitHub Actions var interpolates to `''` — a 0% risk-free rate would score every name as cheap.
  `parseGsecYield` rejects blank/non-finite/≤0, and the report states the signal review did not
  run. Same class of bug as the blank `DATABASE_URL` that produced a confident ₹0 digest.
- **Firewall, third time:** `jobs/report.ts` took `jobs/weekly.ts`'s place on the funded-status
  allowlist (a reporting entrypoint; it reaches funded status only via maturity routing), and a
  new assertion keeps **`notify/report.ts` permanently OFF** that list — that module drives the
  signal, allocation and exit engines, and is where the firewall actually has to hold.

---

## Phase 1 Task 12 — scoring harness §13 (2026-09-13)

`src/domain/scoring.ts` + migration `0012_benchmark_evals.sql`.

- **The creation snapshot cannot be rewritten — enforced in SQL.** `sentinel_benchmarks_immutable()`
  allows UPDATE on `benchmarks` only when `recommendation_id`, `benchmark_as_of` and
  `benchmark_jsonb` are unchanged, so evals accrue while the point of comparison stays fixed.
  Blanket append-only (the 0008 default) made the eval columns unwritable; simply dropping the
  trigger would let a bad week be re-based after the fact, which is the one thing §13 exists to
  prevent. Same pattern as `sentinel_lots_immutable`.
- **Nothing is scored early**, and an **unscoreable call is never a miss**: a missing close at
  creation or at the eval date is recorded with its reason and excluded from the hit-rate.
- **`MIN_EVALS_FOR_CALIBRATION = 20` is a stake in the ground, not a derived number** — at the
  FR-12 cap of 4 recommendations/month it is roughly half a year of output per conviction
  bucket. Below it the table prints "insufficient data" rather than a percentage. OWNER TRUE-UP.
- Excess return is `instrument bps − benchmark bps`, integer throughout.
- No separate job: the weekly report runs `runDueEvals` and renders the calibration section.
  Evals fall due on their own clock and the weekly run is where they land.

---

## Phase 1 COMPLETE — Task 13 + the state of the pipeline (2026-09-13)

Tasks 1–13 shipped (11A superseded by `web/`). Suite **576 passed**, `tsc` clean.

- **`runSync` now takes `fetchPrices`/`fetchNavs`**, wired to NSE bhavcopy + index and AMFI in
  the entrypoint, ordered after the portfolio sources and before anything that reads a price.
  **A missing fetcher is an explicit stderr skip, never a step that reports success.**
- **Task 3 shipped two functions that did not work.** `downloadBhavcopy` always threw
  ('Zip parsing not implemented') and `downloadIndexSeries` never existed, yet both were
  recorded as delivered. The sync step that "ran" bhavcopy had its download commented out and
  reported success. **Second instance this phase of a ledger entry describing code that was not
  there** (the first: screener staleness, Task 5/6). Treat a ledger claim as a lead, never as
  evidence — grep for the symbol.
- **NSE `.csv.zip` is unpacked with stdlib `node:zlib`** (`unzipFirstEntry`, stored + deflate,
  scans for the central directory when the header carries no size). No dependency added to a
  two-dependency repo.
- **Unverified by design, now written down:** the `holidays` table is EMPTY so only weekends are
  skipped — don't guess; it is in PENDING as a provisioning item.
- **NSE bhavcopy URL verified live and found BROKEN for 2026 (2026-09-15).** The archive host
  (`archives.nseindia.com/content/historical/EQUITIES/<YYYY>/<MON>/cm…bhav.csv.zip`) still
  serves 2019–2024 (2024-03-05 → 200, 1790 rows) but returns **404 for every 2026 date** —
  equity prices had silently stopped landing in June. `downloadBhavcopy` is now archive-`first`
  (it is the only shape with an ISIN column) and on NOT_FOUND falls back to the whole-market
  `sec_bhavdata_full_<DDMMYYYY>.csv` (`nsearchives.nseindia.com/products/content`). **Month is
  NUMERIC** (`11092026`) — the archive's `11SEP2026`-style name 404s there; `formatNseDateNumeric`.
  Both sources 404 → `{rows: [], report}`, still reported honestly, no incident.
- **Full-market rows carry no ISIN — resolution by id.** The full-market schema is
  `SYMBOL,SERIES,DATE1,PREV_CLOSE,…,CLOSE_PRICE` (DATE1 is the trade date, feeds `as_of`);
  `ingestPrices` resolves its ISIN-less rows through the `NSE:<SYMBOL>` id that seeded
  instruments already carry (an ISIN row is matched by ISIN first). Unknown symbols are reported,
  never created. ETFs appear with SERIES=EQ.
- **Fetch posture:** NSE expects a browser-ish `Referer: https://www.nseindia.com/` + UA header,
  now sent by `downloadBhavcopy`; `fetchWithRetry` grew an optional `headers` arg.
- **ISIN backfill is fill-only, never clobber** (`backfillInstrumentIsins` from `EQUITY_L.csv`,
  2306 EQ symbols; `pnpm backfill:isin`). Only `NSE:%` ids with NULL/empty `isin` are filled.
  ETFs are absent from EQUITY_L (GOLDBEES/LIQUIDBEES verified missing); backfilling cannot create
  an instrument. **Caveat: re-seeding overwrites backfilled values** — `seed-data.ts` still
  carries the RPOWER placeholder ISIN (`seed.ts` upserts `isin = excluded.isin`). `IND:INDSxxxxx`
  cohort placeholders have no symbol derivable from their id and stay ISIN-less until screener
  cohort promotion.
- **Known timing gap:** today's `sec_bhavdata_full_<DDMMYYYY>.csv` appears only after ~18:00 IST,
  so a before-close run reports empty until the file lands — environmental, not a bug. Closed for
  the daily job by moving `sync.yml` to 19:00 IST (`30 13 * * *`), 2026-09-15.
- README carries the Phase 1 handoff: the data-flow diagram, how a recommendation is built, the
  two ways it is stopped (FR-31 staleness, IPS §3.7 policy), what the engine will not invent,
  and the §15.1 provisioning table with real statuses.

---

## NSE trading calendar — seeded, second-hand (2026-09-13)

`src/seed/seed-holidays.ts` + migration `0013`. `isTradingDay(db, date)` replaces the
weekend-only rule in `runSync`'s EOD steps.

- **The weekend rule was wrong in BOTH directions.** It asked NSE for a bhavcopy on ~15 holidays
  a year (a loud failed step), and it would have **skipped Sunday 2026-11-08 Muhurat trading**,
  when the exchange IS open — silently missing a day that does have data. Hence
  `holidays.is_special_session`: a weekend the calendar marks OPEN is a trading day.
- **PROVENANCE IS SECOND-HAND.** NSE's `/api/holiday-master` blocks non-browser clients
  (timeout), so the 2026 list was cross-checked against Groww and Upstox, which agreed **exactly**
  on all 15 forward dates. Groww carries one extra (2026-01-15 Maharashtra municipal election),
  which is the 15-vs-16 count discrepancy and is already past. **Owner true-up: confirm against
  NSE's own circular.**
- **The asymmetry that sets the bar for adding a date:** a MISSING holiday costs one loud failed
  sync step; a WRONG holiday silently skips a real trading day and starves every price-dependent
  engine. When in doubt, leave it out.
- 2026-09-14 (Ganesh Chaturthi) is a holiday, which is why the first live bhavcopy verification
  lands on Tuesday 2026-09-15.

## The starter watchlist has an LLM-origination problem (noted 2026-09-13)

All 40 rows in `src/seed/seed-watchlist.ts` are `source: 'advisor'`, but **nothing curates them
at runtime**. They are a static file whose names and one-line theses were written by an LLM in
the Task 6 coding session from training recall, with no market data. The engine scores only what
sits in that table, so the LLM originated the *universe* even though it never originates a score
— which is in tension with "the LLM never originates a number or rank" (PRD 6.7). Preferred fix:
regenerate the universe from a real screener.in cohort once the owner imports one, with his
pruning on top. Until then, treat the list as a placeholder, not as advice.

---

## Owner decisions 2026-09-13 — one model family, LLM shortlisting, verified calendar

**ONE MODEL FOR THE PROJECT (owner, explicit).** `inclusionai/ling-3.0-flash-fin:free` on the
existing OpenRouter key does every LLM job. Chosen ids live in ONE place, `src/config/models.ts`.

- **The finance model is TEXT-ONLY** — verified against OpenRouter's own catalogue
  (`input_modalities: ["text"]`, 262k ctx). It physically cannot read a statement screenshot;
  an earlier probe of the same model on opencode Zen returned `No endpoints found that support
  image input`. Its sibling **`inclusionai/ling-3.0-flash-vl:free`** takes `text,image,video`;
  it was **tried as the `VISION_MODEL_CHAIN` leader and retired the same day** (see the
  refinement below). Same family, split by capability. Do not put `-fin` in front of an image —
  it 400s on every upload.
- Tests assert the wiring by DERIVING from the constants (`LLM_MODEL_CHAIN[0]`), never by
  restating a model id — the two that hard-coded `gemma-4-31b` went red on this swap.

**REFINED THE SAME DAY (owner, explicit):** `-fin` stays for every TEXT job, but statement
extraction **reverted** to the previously-tuned vision chain. `VISION_MODEL_CHAIN` is again led
by `google/gemma-4-31b:free`; the `ling-3.0-flash-vl:free` trial as its leader was retired
(the free pool saturates and gemma was the proven extraction model). The text-only rule is
unchanged — `TEXT_MODEL` (-fin) is still kept out of `VISION_MODEL_CHAIN` and the test asserts
it.

**THE LLM SHORTLISTS THE WATCHLIST (owner, explicit — supersedes my §6.7 concern).**
`src/sources/llm-watchlist.ts` + `pnpm watchlist:propose`. The division that keeps §6.7 intact:
the model proposes **names and one sentence of reasoning**; the engine still decides everything
carrying a number. Enforced in code, not trusted to the prompt: a pick must already exist in
`instruments` (an invented ticker is dropped, never created), held names are excluded (§6.1),
and rows land as `source: 'llm-advisor'` PROPOSALS the weekly report shows as awaiting sign-off.
Pool quality is the limit — it can only choose from instruments we already know, so this gets
useful after a real screener import.

**NSE 2026 holiday calendar VERIFIED at source.** Read from nseindia.com in a real browser (the
API blocks non-browser clients). All 16 dates match, including 15-Jan, which two broker mirrors
disagreed on — so the cross-check was right and is now first-hand.

### The screener column spec is wrong (confirmed against the owner's live account 2026-09-13)

A real screen renders `S.No. | Company | CMP Rs. | P/E | Mar Cap Rs.Cr. | Div Yld % | NP Qtr
Rs.Cr. | Qtr Profit Var % | Sales Qtr Rs.Cr. | Qtr Sales Var % | ROCE % | Debt / Eq`.
`SCREENER_COLUMNS` overlaps on **`P/E` alone**, so a real export parses to zero usable rows.
EDIT COLUMNS can add ROE / P/B / EPS / 5y CAGRs / promoter holding, but **`Symbol`, `Industry`,
`FCF 5Y` and `Red Flags` have no native column** — and the §6 quality gate reads FCF and red
flags, while `importScreener` maps rows by TICKER, which screener does not export (it identifies
a row by company name). Deliberately NOT patched by guessing a second mapping: it needs one real
exported file plus an owner decision on the two missing gate inputs.

**Pattern worth naming: four artifacts in this project were written from imagination and
presented as spec** — the 40 watchlist names, `SCREENER_COLUMNS`, the "shipped" screener
staleness check, and the "shipped" bhavcopy downloader. Anything describing an EXTERNAL format
or universe is a hypothesis until it has touched the real thing.

### Live screener run (2026-09-14) — three real defects, now fixed

The first "live" run of `pnpm screener:import --screen` was **silently fake**: the package
script ran bare `tsx src/jobs/screener-import.ts` with no `--env-file=.env`, so `DATABASE_URL`
was unset and `openDb()` fell back to an empty in-memory PGlite — every "0 records" result
was meaningless. Fixed: `"screener:import": "tsx --env-file=.env ..."`. **Any job that must
touch the real DB needs `--env-file=.env`; verify against prod before trusting an import.**

Two real defects surfaced once against the real Supabase:
- **`/company/id/<n>/` rows (companies without a slug) parsed to slug `"ID"`**, and
  `slugToInstrumentId`'s last-resort `id LIKE '%slug%'` then substring-matched
  `NSE:LIQUIDBEES` (contains "ID"). Multiple such rows resolved to one instrument →
  mid-upload PK violation with no transaction → partial upload left in `screener_uploads`.
  Fixed: LIKE fallback guarded to `slug.length >= 3`, and `importScreenRows` dedupes
  same-instrument rows with a warning instead of crashing.
- The owner's sentinel screen renders **tooltip-less headers** (`Debt / Eq` visible text), so
  `COLUMN_MAP` (keyed on `data-tooltip`) never fired and `de_ratio` was silently null. Fixed:
  `TEXT_ALIAS` in `normalizeHeader` maps `Debt / Eq` → `D/E`.

Prod facts: the live `instruments` table uses **`BSE:`-prefixed ids** for most equities (74
equity/ETF total) plus `NSE:` for a few (LICI, TECHM, TMCV, LIQUIDBEES). Seed ids are `NSE:` —
both map fine, but never assume which prefix. The sentinel cohort (410 records) overlaps the
local universe by only 12 → only those 12 landed. Universe widening is now the screener cohort
promotion (next section).

### Screener cohort promotion (2026-09-15) — screen rows become instruments

Every `importScreenRows` now promotes rows whose company is NOT yet in `instruments`
(`ensureScreenInstrument`): id `NSE:<slug>`, kind `EQUITY`, currency INR, exchange NSE,
`metadata = {"source":"screener-cohort"}` (screen slug derived, not ticker — screener exports
no ticker). This is the "regenerate the universe from a real screener.in cohort" fix: it is not
a one-time backfill but happens on every import, so re-running the owner's sentinel screen
3963033 promotes its ~398 skipped companies and the next `watchlist:propose` draws from a real
pool. (Importer's old 10-page cap truncated the 17-page screen to ~230 — fixed 2026-09-16: the
default page budget is now a 100-page safety valve; screener serves 25 rows/page to the paged
URL, so the short page is the real terminator.)

- **Identity is an inference, not a fact.** `NSE:<slug>` is trusted only to be internally
  consistent with bhavcopy resolution; the human-readable `name` comes from the screen (the one
  column it renders that maps to a company). Nothing else is guessed — **ISIN is deliberately
  left NULL** and filled later by `pnpm backfill:isin` from `EQUITY_L.csv`; never invent one.
- **Known simplification (scope note):** screen rows for ETFs/funds would be mis-kinded as
  EQUITY. Asteroid-screen ETFs will land EQ with bogus fundamentals; the screener `kind`/exchange
  fields on the source row are dropped at promotion. Low severity, one screen type; noted rather
  than built around.
- **Degenerate `/company/id/<n>/` rows** (companies without a slug) still resolve to `"ID"` and
  are refused (len < 3) — the LIKE-guard fix stays. Unknown rows that can't be promoted still
  warn `Unknown instrument (not created)`.
- `importScreenRows` return shape is now `{ uploadedId, inserted, createdInstruments, warnings }`;
  the screen-job CLI prints `Promoted N new companies into the instruments universe`. The legacy
  `screenerImportCsv` path (unverified spec, `TICKER` mapping) only ever runs on the pinned CSV
  fixture and never promotes.
- **The IND cross-listing hole is untouched:** `IND:INDSxxxxx` ids resolve to NSE physical
  symbols only via the `bhavcopySymbols` map; the rest of the ~10k IND ids have no slug and are
  silently dropped by slugToInstrumentId — the 40 seeded `'advisor'` watchlist rows pointing at
  `IND:` names are the live example. Separate track from cohort promotion.
- 4 new tests (existence/kind/metadata mutation-checked, derived exact-set using synthetic
  COHORTD1/COHORTD2, re-import idempotence = created 0, degenerate refusal). 618→622 passed,
  tsc clean. Owner's earlier line "not yet run live + not pushed" is now stale for the *cohort*
  portion: it promotes on the next live import, no extra flag.
