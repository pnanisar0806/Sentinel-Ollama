# Sentinel — durable project memory

Last updated: 2026-08-25. Phase 0 complete + fix wave + re-review; branch merged to `main`.
Post-merge: Supabase provisioned (secrets in GH Actions), production double-count fixed,
statement-ingestion workstream (photo → LLM proposal → owner confirm → owner lot). 417/417
green. Read this at session start (see `CLAUDE.md`). Update it when a durable fact changes.

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
SIPs*; the ~₹6,100 gap is its unquantified "+ electricity" line. **Do not tune the model to
hit ₹76,000** — when the owner supplies an electricity figure it goes into
`FIXED_OUTFLOWS.misc` and the test's expected value moves in the same commit.

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
