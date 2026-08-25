# Sentinel — repo map

Read at session start (see `CLAUDE.md`). Update when files are added, moved, or their
exports change. Files marked *(planned)* do not exist yet.

## Layout

```
CLAUDE.md      agent operating instructions + hard PRD constraints
MEMORY.md      durable state: decisions, contracts, gotchas, open questions
index.md       this file
migrations/    numbered .sql, applied in name order
src/           implementation
tests/         vitest, mirrors src/ layout
docs/superpowers/plans/2026-08-12-sentinel-phase-0.md   the ~4,700-line plan (do not read whole)
docs/SETUP.md   step-by-step deploy guide (Supabase, Telegram, secrets, workflows)
.superpowers/sdd/2026-08-12-sentinel-phase-0/           SDD workspace: briefs, review diffs, progress.md
```

## Source

| File | Exports / role |
|---|---|
| `src/config/assumptions.ts` | `ASSUMPTIONS` — the only place PRD §15.2 planning constants live |
| `src/config/env.ts` | `loadEnv(source?, purposes?)`, `Purpose`, `CryptoEnv` — validates **per job**: `['crypto']` demands only TOKEN_ENCRYPTION_KEY (and narrows it to `string`), `['telegram']` only the two TELEGRAM vars, **default `[]` — demand nothing** (the old `['all']` default crashed both scheduled jobs on startup over credentials neither reads); `['all']` still demands everything when asked. Each job module exports `ENV_PURPOSES` |
| `src/db/client.ts` | `Db` interface (4 methods), `openDb(url?)` — PGlite or postgres-js. A **blank-but-present** `DATABASE_URL` throws rather than silently falling back to embedded PGlite (an unset GitHub secret interpolates to `''`) |
| `src/db/migrate.ts` | `runMigrations(db, dir?)` — each unapplied file in one transaction; also a CLI |
| `src/util/main-module.ts` | `isMainModule(metaUrl, argv1?)` — routes argv[1] through `pathToFileURL`. The hand-rolled `import.meta.url === 'file://' + argv[1]` guard NEVER matched on Windows, so every CLI entrypoint was a silent no-op that exited 0 |
| `src/money/paise.ts` | `Paise`, `Cents`, `rupees`, `paise`, `dollars`, `cents`, `addP`, `subP`, `mulP`, `pctOf`, `formatInr` |
| `src/money/fx.ts` | `rateMicros`, `usdToInr` |
| `src/seed/seed-data.ts` | `SEED_INSTRUMENTS`, `SEED_HOLDINGS`, `SEED_LOANS`, `SEED_BUCKETS`, `SEED_MILESTONES`, `SEED_RSU_GRANTS` — the owner's real balance sheet. All loan and bond figures are owner-verified against lender/broker portals; see `MEMORY.md`. `InstrumentSeed` carries optional `isin` (populated for the three bonds; Task 11B matches on it) |
| `src/seed/seed.ts` | `seed(db, opts?)` — idempotent; one snapshot per (business_date, source); writes `instruments.isin` |
| `src/sources/types.ts` | `SourceRow`, `Source` interface, `writeSnapshot(db, source, businessDate, rows, asOf)` — single upsert path for all sources; every row carries as_of + source. **The whole write is ONE transaction** (the holdings delete precedes the inserts, so an unwrapped failure destroyed the source's holdings under an unattended daily job). Writes `isin` + `canonical_id`; on instrument conflict the **curated row wins** — only NULL fields are enriched from the payload, never `name`/`issuer` |
| `src/sources/kite.ts` | `KiteSource` — read-only (allowlist covers the prototype **and instance fields**; endpoint allowlist = `/portfolio/holdings` only). `GOLDBEES` maps to GOLD (it used to fall through to EQUITY). `avgCostPaise` is the **total** (`quantity x average_price`), matching INDmoney and the seed — writing `average_price` alone understated 380 NIFTYBEES units by 380x. A holding with no usable price **throws** rather than valuing at Rs 0. Requires `KITE_API_KEY` + `KITE_ACCESS_TOKEN`. NO order/GT methods — allowlist test + source scan for mutating endpoints/verbs. Emits `canonicalId` (map or ISIN) |
| `src/sources/indmoney.ts` | `FileIndmoneySource` — reads owner-refreshed JSON snapshot (fallback / test double). `RemoteIndmoneySource`, `ASSET_TYPES` — live MCP, same `Source` interface. **Rewritten against a real capture 2026-08-22**: one `networth_holdings` call per asset class (the tool requires `asset_type`), unwraps the `{result: "<json string>"}` envelope, aggregates an instrument held across brokers, ISIN-detected instrumentId, `invested_amount` `'unknown'`/0/absent → null (FR-02), and **BOND cost is always null** because for bonds `invested_amount` is FACE VALUE, not cost (owner-verified). Throws on a rate-limit body, `holding_error`, or an unmapped `asset_type`. Staleness (Task 12) nags when file ages. Both sources emit `canonicalId` via the INDmoney→canonical map |
| `src/sources/mcp-client.ts` | `McpClient` — Streamable HTTP (JSON-RPC 2.0) over MCP. `callTool<T>(name, args)` — **`allowedTools` is a REQUIRED, non-empty constructor arg** and is checked before any request leaves the process; without it a URL change reached `place_order` on a broker's MCP. Handles JSON + SSE responses, lazy init (protocolVersion 2025-06-18), `Mcp-Session-Id`, injectable `fetchImpl` |
| `src/sources/fx.ts` | `fetchUsdInr(opts?)` — frankfurter.app endpoint, sanity band 50-200. Returns `{rate, asOf, source: 'frankfurter'}` |
| `src/sources/staleness.ts` | `FRESHNESS_HOURS`, `assessStaleness(db, now)`, `raiseIncidents(db, rows)`, `blockedInstruments(rows, positions)`, `StalenessRow`, `SourceState` — checks holdings + fx_rates. **amfi/bhavcopy/screener report `state: 'unimplemented'`, NOT stale** (no ingestion path exists; calling them stale kept a BLOCK incident open forever and printed red after a *successful* sync). Each source appears exactly once. `blockedInstruments` blocks on **valuation inputs** — the position's own portfolio source, plus FX for any non-INR position — not just portfolio sources |
| `src/sources/owner-ingest.ts` | `parseCostCommand(text, positionCount, now?)`, `insertOwnerCostLot(db, opts)`, `saveStatementPhoto(deps)` — owner-supplied cost basis. Cost lands as an OPEN LOT on `lots` (the only durable home; holdings rows are replaced per sync), `source: 'owner-telegram'`, audit_log insert in the SAME transaction. Quantity defaults to 1 (aggregated-holdings convention). Photos archive to `data/screenshots/<updateId>.<ext>` (gitignored). **Audit payloads go in as OBJECTS, never JSON.stringify** — a pre-stringified param becomes an opaque jsonb scalar string under postgres-js |
| `src/sources/llm-extract.ts` | `extractHoldingsFromImage(deps)`, `LlmProposal`, `LLM_MODEL_CHAIN`, `DEFAULT_LLM_MODEL` — vision extraction via OpenRouter free models, PROPOSAL-ONLY (nothing writes until the owner confirms in Telegram). Prompt anchors against the current numbered `/holdings` list so the model maps rows instead of inventing identities; multiple images = pages of ONE statement, sent in a single request. Primary model retries once on 429 then the chain walks (~1.5s between models). Unreadable/non-positive cost is DROPPED, never guessed (FR-02). Optional env: `LLM_API_KEY`, `LLM_MODEL` |
| `src/domain/ips.ts` | `IPS_V1_TEXT`, `installIps(db, opts?)`, `currentIps(db)`, `ipsClause(text, clause)`, `renderIps(text, clause?)` — PRD §3.1–3.10 verbatim in `src/config/ips-v1.md`, versioned storage in `ips_versions`, idempotent install, clause extraction for FR-10 citations |
| `src/domain/loans.ts` | `amortize`, `runCascade`, `interestPaid`, `nextMonth`, `persistSchedules`. Both schedules share the private `stepLoan()` month step |
| `src/domain/surplus.ts` | `FIXED_OUTFLOWS`, `BASE_TAKE_HOME`, `BASE_TAKE_HOME_AS_OF`, `RENT_TO_EMI_FLAG`, `CHILD_DENT_NO_END_FLAG`, `PARTIAL_YEAR_FLAG`, `SurplusMonth`, `AnnualSurplus` (carries `monthCount` + `flags`), `loanOutflowByMonth`, `projectSurplus`, `projectAnnualSurplus`. `projectSurplus`'s coverage guard is derived from the outflow map's own key range, never from `closures` alone — see `MEMORY.md` |
| `src/domain/rsu.ts` | `VestEvent`, `PROJECTED_SOURCE`, `CONFIRMED_SOURCE`, `projectVests`, `withRefreshers`, `unvestedValue`, `persistVests(db, vests, {asOf?})`, `confirmVest(db, id, actual, {asOf?})`. Tranches are allocated cumulatively so 16 parts always sum to the whole grant; `confirmVest` RECOMPUTES `gross_paise` and runs its update + audit insert in one transaction; `withRefreshers` skips years that already carry a real grant. FR-03 lives in the SQL — one `insert ... on conflict (grant_id, vest_on) do update ... where rsu_vests.status <> 'ACTUAL'`, backed by the unique constraint in `0001` |
| `src/domain/networth.ts` | `InstrumentKind` (mirrors the schema check constraint, `'LOAN'` included), `AssetClass`, `Position` (carries `name`, `sector`, `currency`), `NetWorth`, `classify` (throws on LOAN — a liability must never be summed into assets), `loadPositions(db, businessDate?)` (latest snapshot per source, C-A reconciliation: seed retires when live shares its key, its canonical id alone, or it is a placeholder basket whose decomposition now reports; verified seed cost carries over to a cost-null live twin; missing cost falls back to the newest OPEN owner lot), `netWorth`, `outstandingLiabilities(db, asOfMonth)` (lateral join; falls back to `loans.outstanding_paise` for a month before the schedule starts) |
| `src/domain/funded-status.ts` | `computeFICorpusBand(swr?)`, `fundedRatio`, `reportFundedStatus`, `fundedStatus` — the ONE FI corpus model. The band varies **income** (₹3L→₹5L/mo) at one SWR; the SWR is a separate sensitivity axis. Reproduces all four PRD figures (10.29/17.14 Cr at 3.5%, 9.00/15.00 Cr at 4%). `buckets.ts` re-exports these rather than copying them |
| `src/domain/allocation.ts` | `IPS_BANDS`, `CAPS` (all five enforced), `SECTOR_COVERAGE_CAVEAT`, `DriftRow`, `Concentration`, `allocationDrift(byAssetClass, total?)` (derives the total, rejects an inconsistent one; drift via `mulP`, never a float), `concentration` (aggregates by instrument/issuer/scheme/sector before applying a cap; reports `sectorCoveragePct`). See `MEMORY.md` for the seed's real breach set |
| `src/notify/telegram.ts` | `Telegram` class — owner-locked client (PRD §4.1, §12.3). `isOwner(chatId)`, `send(markdown)`, `escapeMarkdown(text)`. **NOT MarkdownV2** — legacy `parse_mode: 'Markdown'`, with DB-derived text escaped by the digest and a **plain-text retry** if Telegram still rejects the markup, so a formatting error can never cost the owner the message. Any non-parse failure stays loud. The chunker hard-splits a single line longer than 4096 (it used to emit an empty chunk AND an oversized one) |
| `src/notify/digest.ts` | `buildDigestInput(db, now)`, `composeDigest(input)`, `DigestInput` — pure daily digest composer (FR-50). **`previousNetPaise` is computed** from the latest snapshot before today (it was hard-coded `null`, so "day-over-day starts tomorrow" printed forever). An unallocated bucket renders **"not yet allocated", never ₹0**. All DB-derived names go through `escapeMarkdown` |
| `src/jobs/sync.ts` | `runSync(db, {now, sources, fetchFx?})`, `FxFetcher`, `ENV_PURPOSES` — writes snapshots, **writes `fx_rates`** (nothing did, so `frankfurter` was permanently stale and held an open BLOCK incident), persists loan schedules + projected RSU vests, raises staleness incidents. Every input — sources AND FX — goes through one `step()` carrying the PRD §8.2 contract. The entrypoint prefers **`RemoteIndmoneySource` over MCP+OAuth** (client id read from `oauth_clients`, `allowedTools: ['networth_holdings']`) and falls back to `FileIndmoneySource` loudly on stderr |
| `src/jobs/digest.ts` | CLI entrypoint — `pnpm digest`. Loads `['telegram']` env, runs migrations + IPS install, composes pure digest, sends via Telegram (dry-run supported) |
| `src/jobs/telegram-bot.ts` | CLI entrypoint — `pnpm telegram:bot`. Loads `['telegram','crypto']` env, runs migrations + IPS install, starts the polling bot |
| `src/notify/telegram-bot.ts` | `TelegramBot`, `displayOrder(positions)` — long-polling command bot (`/sync`, `/status`, `/holdings`, `/cost`, `/confirm`, `/reject`, `/help`), owner-locked; builds sync sources from exported `indmoneySource` + optional Kite. Statement photos: single images extract immediately; **albums buffer by `media_group_id`** and flush as one multi-page LLM pass after a short silence. LLM proposals queue until the owner replies `/confirm`; confirmed AND skipped entries leave the queue (a repeat confirm used to double-write). `/holdings` and `/cost` share `displayOrder` — two divergent orderings once wrote a cost to the wrong instrument. Without `LLM_API_KEY` photos are archived and the bot walks the owner through manual `/cost`. Entrypoint is `jobs/telegram-bot.ts` only |
| `src/jobs/keepalive.ts` | CLI entrypoint — weekly `audit_log` insert to keep the Supabase free tier awake (it is a DB write, not an HTTP ping) |
| `src/jobs/ips.ts` | CLI entrypoint — `pnpm ips <clause>` prints the requested IPS clause verbatim |

## Migrations

| File | Contents |
|---|---|
| `migrations/0000_bootstrap.sql` | `schema_migrations` bookkeeping table (single statement) |
| `migrations/0001_phase0.sql` | 16 Phase 0 tables + append-only triggers (~30 statements). `rsu_vests` carries `unique (grant_id, vest_on)` — load-bearing for FR-03's ON CONFLICT |
| `migrations/0002_oauth.sql` | `oauth_clients` (provider, issuer, client_id, client_secret_enc, redirect_uri, registered_on), `oauth_tokens` (provider, access_token_enc, refresh_token_enc, scope, expires_at, rotated_at). AES-256-GCM encryption; client_secret_enc + refresh_token_enc never stored plaintext |
| `migrations/0003_snapshot_uniqueness.sql` | `unique (business_date, source)` on `snapshots` — without it writeSnapshot's select-then-insert is check-then-act and two racing syncs double-count the portfolio |
| `migrations/0004_immutability_and_rls.sql` | append-only triggers on `ips_versions` + `bucket_flows`; `sentinel_lots_immutable()` on `lots` (DELETE/TRUNCATE refused, UPDATE allowed **only** for `closed_on` — closing a lot is the FIFO disposal lifecycle); **RLS enabled on all 18 tables**, no policies, so anon/authenticated are denied and the owner role bypasses |
| `migrations/0005_canonical_instrument.sql` | `instruments.canonical_id` column + index — the C-A reconciliation key. Live source wins per `(canonical_id, account)`; seed fills gaps; seed fallback when live stops reporting |

## Tests

One file per source module under `tests/`, same relative path. Plus:
`tests/db/schema.test.ts` (constraints, `as_of`/`source` NOT NULL, append-only incl.
TRUNCATE) and `tests/domain/loans.persist.test.ts` (schedule persistence).

`tests/sources/mcp-client.test.ts` (5 tests), `tests/sources/indmoney-remote.test.ts` (11 tests),
`tests/sources/staleness.test.ts` (13 tests), `tests/fixtures/indmoney-holdings-mcp.json` — **a real capture** (52 holdings across 6 asset
classes, plus the rate-limit body), taken 2026-08-22 through the live MCP. Suite at
421/421 across 55 files (2026-08-25). `tests/notify/telegram-bot-ingest.test.ts` drives the
REAL bot class through a stub Telegram + substring-dispatching fake Db — the wiring test
that caught the /cost line-number mismatch and the partial-confirm double-write.

`tests/domain/allocation.test.ts` ends with a **seed-backed** block: it loads the real
portfolio and asserts the exact breach set, drift rows and gold shortfall. Synthetic
round numbers alone are how the plan's false "the seed breaches the Sammaan cap" survived.

Two conventions worth preserving, both learned from tests that caught nothing:
derive the *actual* side of an assertion from the real data structure rather than
hard-coding both sides, and never hard-code a literal (a month, a total) that is
downstream of seed data — it goes stale silently the moment the seed is corrected.

One deliberate exception: `tests/domain/surplus.test.ts` asserts ₹82,124 / ₹55,526
exactly. A stale literal there fails **loudly**, which is the point — the rule exists to
stop literals that make a test *vacuous*, not ones that make it break when the seed moves.

### Architecture test

`tests/architecture/no-catch-up.test.ts` is the `funded_status` firewall and it is a REAL
checker: it walks `src/**/*.ts` off disk, builds the import graph, and asserts the transitive
reachers of `src/domain/funded-status.ts` are exactly `domain/buckets.ts`, `notify/digest.ts`
and `jobs/digest.ts`. Adding a fourth reader of funded status is a deliberate act — put it on
the allowlist there, or the suite goes red.

### Workflows

| File | Schedule (UTC) | Notes |
|---|---|---|
| `.github/workflows/ci.yml` | on push + PR | `tsc --noEmit` then `pnpm test`. Nothing enforced the suite before |
| `.github/workflows/sync.yml` | `0 12 * * *` — **daily** | Weekday-only left the Monday digest reading Friday's data, 63.25h against a 36h limit |
| `.github/workflows/digest.yml` | `15 3 * * 1-5` | Now at most ~15h behind a sync |
| `.github/workflows/keepalive.yml` | `0 4 * * 0` | Largely subsumed by the daily sync; kept as a belt-and-braces Supabase ping |

None of them pin a pnpm `version:` — `package.json`'s `packageManager` is the single
source of truth, and specifying both makes `pnpm/action-setup` fail at setup.

## Scripts

`pnpm test` · `test:watch` · `migrate` · `seed` · `sync` · `digest` · `ips` · `telegram:bot` · `indmoney:login`

`indmoney:login` runs `tsx --env-file=.env` — nothing else loads `.env` (no dotenv dep), so
every other script still needs its vars exported. `.env` is gitignored and holds
`DATABASE_URL=pglite://.pglite` and `TOKEN_ENCRYPTION_KEY`; without the former the refresh
token lands in an in-memory PGlite and is discarded on exit.
