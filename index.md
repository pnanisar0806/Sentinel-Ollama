# Sentinel — repo map

Read at session start (see `CLAUDE.md`). Update when files are added, moved, or their
exports change. Files marked *(planned)* do not exist yet.

## Layout

```
CLAUDE.md      agent operating instructions + hard PRD constraints
PENDING.md     one-screen open items + watch list — read FIRST, updated every session
MEMORY.md      durable state: decisions, contracts, gotchas, open questions
index.md       this file
migrations/    numbered .sql, applied in name order
src/           implementation
web/           local product app (Next.js 15) — pulled forward 2026-09-05; read-only, port 3001
tests/         vitest, mirrors src/ layout
docs/superpowers/plans/2026-08-12-sentinel-phase-0.md   the ~4,700-line plan (do not read whole)
docs/superpowers/plans/2026-09-05-sentinel-phase-1.md   Phase 1 ("Think") plan — 13 tasks, written 2026-09-05; tasks 1-11 executed (11A superseded by `web/`), 12-13 open
docs/SETUP.md   step-by-step deploy guide (Supabase, Telegram, secrets, workflows)
.superpowers/sdd/2026-08-12-sentinel-phase-0/           SDD workspace: briefs, review diffs, progress.md
```

## Source

| File | Exports / role |
|---|---|
| `src/config/models.ts` | `TEXT_MODEL` (`inclusionai/ling-3.0-flash-fin:free`), `VISION_MODEL_CHAIN` (led by `google/gemma-4-31b:free`), `OPENROUTER_CHAT_URL` — **the one place a model id is chosen** (owner decision 2026-09-13: finance-tuned `-fin` for TEXT jobs; extraction reverted the same day to the proven gemma-led vision chain; the Ling VL leader trial retired). The text model is TEXT-ONLY per OpenRouter's catalogue — never in front of an image |
| `src/config/assumptions.ts` | `ASSUMPTIONS` — the only place PRD §15.2 planning constants live |
| `src/config/env.ts` | `loadEnv(source?, purposes?)`, `Purpose`, `CryptoEnv` — validates **per job**: `['crypto']` demands only TOKEN_ENCRYPTION_KEY (and narrows it to `string`), `['telegram']` only the two TELEGRAM vars, **default `[]` — demand nothing** (the old `['all']` default crashed both scheduled jobs on startup over credentials neither reads); `['all']` still demands everything when asked. Each job module exports `ENV_PURPOSES` |
| `src/db/client.ts` | `Db` interface (4 methods), `openDb(url?)` — PGlite or postgres-js. A **blank-but-present** `DATABASE_URL` throws rather than silently falling back to embedded PGlite (an unset GitHub secret interpolates to `''`) |
| `src/db/migrate.ts` | `runMigrations(db, dir?)` — each unapplied file in one transaction; also a CLI |
| `src/util/main-module.ts` | `isMainModule(metaUrl, argv1?)` — routes argv[1] through `pathToFileURL`. The hand-rolled `import.meta.url === 'file://' + argv[1]` guard NEVER matched on Windows, so every CLI entrypoint was a silent no-op that exited 0 |
| `src/money/paise.ts` | `Paise`, `Cents`, `rupees`, `paise`, `dollars`, `cents`, `addP`, `subP`, `mulP`, `pctOf`, `formatInr` |
| `src/money/fx.ts` | `rateMicros`, `usdToInr` |
| `src/seed/seed-data.ts` | `SEED_INSTRUMENTS`, `SEED_HOLDINGS`, `SEED_LOANS`, `SEED_BUCKETS`, `SEED_MILESTONES`, `SEED_RSU_GRANTS` — the owner's real balance sheet. All loan and bond figures are owner-verified against lender/broker portals; see `MEMORY.md`. `InstrumentSeed` carries optional `isin` (populated for the three bonds; Task 11B matches on it) |
| `src/seed/seed-holidays.ts` | `SEED_HOLIDAYS_2026`, `seedHolidays(db)`, `isTradingDay(db, date)` — the NSE trading calendar. A weekday is open unless the calendar closes it; a weekend is closed unless the calendar OPENS it (Muhurat). **Second-hand provenance — see the docstring**; with an empty table it degrades to the weekend rule, which is wrong in the loud direction |
| `src/seed/seed.ts` | `seed(db, opts?)` — idempotent; one snapshot per (business_date, source); writes `instruments.isin` |
| `src/sources/types.ts` | `SourceRow`, `Source` interface, `writeSnapshot(db, source, businessDate, rows, asOf)` — single upsert path for all sources; every row carries as_of + source. **The whole write is ONE transaction** (the holdings delete precedes the inserts, so an unwrapped failure destroyed the source's holdings under an unattended daily job). Writes `isin` + `canonical_id`; on instrument conflict the **curated row wins** — only NULL fields are enriched from the payload, never `name`/`issuer` |
| `src/sources/indmoney.ts` | `FileIndmoneySource` — reads owner-refreshed JSON snapshot (fallback / test double). `RemoteIndmoneySource`, `ASSET_TYPES` — live MCP, same `Source` interface. **Rewritten against a real capture 2026-08-22**: one `networth_holdings` call per asset class (the tool requires `asset_type`), unwraps the `{result: "<json string>"}` envelope, aggregates an instrument held across brokers, ISIN-detected instrumentId, `invested_amount` `'unknown'`/0/absent → null (FR-02), and **BOND cost is always null** because for bonds `invested_amount` is FACE VALUE, not cost (owner-verified). Throws on a rate-limit body, `holding_error`, or an unmapped `asset_type`. Staleness (Task 12) nags when file ages. Both sources emit `canonicalId` via the INDmoney→canonical map |
| `src/sources/mcp-client.ts` | `McpClient` — Streamable HTTP (JSON-RPC 2.0) over MCP. `callTool<T>(name, args)` — **`allowedTools` is a REQUIRED, non-empty constructor arg** and is checked before any request leaves the process; without it a URL change reached `place_order` on a broker's MCP. Handles JSON + SSE responses, lazy init (protocolVersion 2025-06-18), `Mcp-Session-Id`, injectable `fetchImpl` |
| `src/sources/fx.ts` | `fetchUsdInr(opts?)` — frankfurter.app endpoint, sanity band 50-200. Returns `{rate, asOf, source: 'frankfurter'}` |
| `src/sources/staleness.ts` | `FRESHNESS_HOURS`, `assessStaleness(db, now)`, `raiseIncidents(db, rows)`, `blockedInstruments(rows, positions)`, `StalenessRow`, `SourceState` — checks holdings + fx_rates + prices_eod + navs + fundamentals. **`unimplemented` is kept for the next source with no ingestion path; as of Phase 1 Task 6 none is left, so bhavcopy/amfi/screener are assessed like any other and an empty table reads as stale.** Each source appears exactly once. `blockedInstruments` blocks on **valuation inputs** — the position's own portfolio source, plus FX for any non-INR position — not just portfolio sources |
| `src/sources/owner-ingest.ts` | `parseCostCommand(text, positionCount, now?)`, `insertOwnerCostLot(db, opts)` → `{lotId, outcome, previousCostPaise?}`, `saveStatementPhoto(deps)` — owner-supplied cost basis, IDEMPOTENT BY VALUE: same cost open → `unchanged` (no-op), different → `superseded` (close old + insert new; migration 0006's partial unique index makes "one open owner lot per position" hold against raw SQL too), none → `created`. Cost lands as an OPEN LOT on `lots`, `source: 'owner-telegram'`, audit_log insert in the SAME transaction. Quantity defaults to 1 (aggregated-holdings convention). Photos archive to `data/screenshots/<updateId>.<ext>` (gitignored); `saveStatementPhoto` short-circuits when the local file already exists, so the callback path never re-fetches Telegram. **Audit payloads go in as OBJECTS, never JSON.stringify** — a pre-stringified param becomes an opaque jsonb scalar string under postgres-js |
| `src/sources/llm-extract.ts` | `extractJsonFromImage(deps)`, `extractHoldingsFromImage(deps)`, `LlmProposal`, `LLM_MODEL_CHAIN`, `DEFAULT_LLM_MODEL` — vision extraction via OpenRouter free models, PROPOSAL-ONLY (nothing writes until the owner confirms in Telegram). `extractJsonFromImage` is the shared raw-JSON pass and returns ANY shape (brokerage `{items:[…]}`, Fidelity `{vests:[…]}`, …); `extractHoldingsFromImage` maps the brokerage schema, anchored against the current numbered `/holdings` list with `KNOWN SYMBOL MAPPINGS` overriding line-guess anchoring. Multiple images = pages of ONE statement, sent in a single request. Primary model retries once on 429 then the chain walks. Unreadable/non-positive costs are DROPPED, never guessed (FR-02). Optional env: `LLM_API_KEY`, `LLM_MODEL` |
| `src/sources/fidelity-ingest.ts` | `FIDELITY_EXTRACTION_PROMPT`, `FidelityRsuVest`, `FidelityProposal`, `extractRsuVestsFromImage(deps)`, `fidelityVestsToProposals(vests, usdInrRate)`, `checkFidelityVestExists(db, grantId, vestOn)` — Fidelity RSU vest extraction. Parses `{vests:[…]}` via the shared `extractJsonFromImage` and prices it using the **same `UNITS_SCALE` / `toUnitsMicros` that `rsu.ts` exports**, so proposal gross literally equals `confirmVest`'s recomputed gross (net ≤ gross by construction). `extractRsuVestsFromImage` drops a vest unless grantId/date/units/price/withholding are sane. Production caller: the bot's fidelity queue → `/confirm` writes ACTUAL rows |
| `src/sources/proposal-target.ts` | `displayOrder(positions)`, `resolveProposalTarget(proposals, positions)` — shared proposal-line numbering + ticker-anchored target resolution. Single source of truth for bot + web (avoids importing telegram-bot from web, which would pull in heavy deps). Bot re-exports these; web imports directly |
| `src/domain/ips.ts` | `IPS_V1_TEXT`, `installIps(db, opts?)`, `currentIps(db)`, `ipsClause(text, clause)`, `renderIps(text, clause?)` — PRD §3.1–3.10 verbatim in `src/config/ips-v1.md`, versioned storage in `ips_versions`, idempotent install, clause extraction for FR-10 citations |
| `src/domain/loans.ts` | `amortize`, `runCascade`, `interestPaid`, `nextMonth`, `persistSchedules`. Both schedules share the private `stepLoan()` month step |
| `src/domain/surplus.ts` | `FIXED_OUTFLOWS`, `BASE_TAKE_HOME`, `BASE_TAKE_HOME_AS_OF`, `RENT_TO_EMI_FLAG`, `CHILD_DENT_NO_END_FLAG`, `PARTIAL_YEAR_FLAG`, `SurplusMonth`, `AnnualSurplus` (carries `monthCount` + `flags`), `loanOutflowByMonth`, `projectSurplus`, `projectAnnualSurplus`. `projectSurplus`'s coverage guard is derived from the outflow map's own key range, never from `closures` alone — see `MEMORY.md` |
| `src/domain/rsu.ts` | `UNITS_SCALE`, `toUnitsMicros`, `VestEvent`, `PROJECTED_SOURCE`, `CONFIRMED_SOURCE`, `projectVests`, `withRefreshers`, `unvestedValue`, `persistVests(db, vests, {asOf?})`, `confirmVest(db, id, actual, {asOf?})`. `UNITS_SCALE` (1e6) and `toUnitsMicros` are the micros source of truth, now shared by fidelity pricing. Tranches are allocated cumulatively so 16 parts always sum to the whole grant; `confirmVest` RECOMPUTES `gross_paise` and runs its update + audit insert in one transaction; `withRefreshers` skips years that already carry a real grant. FR-03 lives in the SQL — one `insert ... on conflict (grant_id, vest_on) do update ... where rsu_vests.status <> 'ACTUAL'`, backed by the unique constraint in `0001` |
| `src/domain/networth.ts` | `InstrumentKind` (mirrors the schema check constraint, `'LOAN'` included), `AssetClass`, `Position` (carries `name`, `sector`, `currency`), `NetWorth`, `classify` (throws on LOAN — a liability must never be summed into assets), `loadPositions(db, businessDate?)` (latest snapshot per source, C-A reconciliation: seed retires when live shares its key, its canonical id alone, or it is a placeholder basket whose decomposition now reports; verified seed cost carries over to a cost-null live twin; missing cost falls back to the newest OPEN owner lot), `netWorth`, `outstandingLiabilities(db, asOfMonth)` (lateral join; falls back to `loans.outstanding_paise` for a month before the schedule starts) |
| `src/domain/funded-status.ts` | `computeFICorpusBand(swr?)`, `fundedRatio`, `reportFundedStatus`, `fundedStatus` — the ONE FI corpus model. The band varies **income** (₹3L→₹5L/mo) at one SWR; the SWR is a separate sensitivity axis. Reproduces all four PRD figures (10.29/17.14 Cr at 3.5%, 9.00/15.00 Cr at 4%). `buckets.ts` re-exports these rather than copying them |
| `src/domain/allocation.ts` | `IPS_BANDS`, `CAPS` (all five enforced), `SECTOR_COVERAGE_CAVEAT`, `DriftRow`, `Concentration`, `allocationDrift(byAssetClass, total?)` (derives the total, rejects an inconsistent one; drift via `mulP`, never a float), `concentration` (aggregates by instrument/issuer/scheme/sector before applying a cap; reports `sectorCoveragePct`). See `MEMORY.md` for the seed's real breach set |
| `src/notify/telegram.ts` | `Telegram` class — owner-locked client (PRD §4.1, §12.3). `isOwner(chatId)`, `send(markdown)`, `escapeMarkdown(text)`. **NOT MarkdownV2** — legacy `parse_mode: 'Markdown'`, with DB-derived text escaped by the digest and a **plain-text retry** if Telegram still rejects the markup, so a formatting error can never cost the owner the message. Any non-parse failure stays loud. The chunker hard-splits a single line longer than 4096 (it used to emit an empty chunk AND an oversized one) |
| `src/notify/digest.ts` | `buildDigestInput(db, now)`, `composeDigest(input)`, `DigestInput` — pure daily digest composer (FR-50). **`previousNetPaise` is computed** from the latest snapshot before today (it was hard-coded `null`, so "day-over-day starts tomorrow" printed forever). An unallocated bucket renders **"not yet allocated", never ₹0**. **Confirmed-ACTUAL vests are filtered** out of the RSU section (`nextVest` = first unconfirmed; the confirmed key normalizes `vest_on` like `granted_on` — PGlite DATE→Date gotcha, see MEMORY). All DB-derived names go through `escapeMarkdown` |
| `src/jobs/sync.ts` | `runSync(db, {now, sources, fetchFx?, fetchPrices?, fetchNavs?})`, `FxFetcher`, `PriceFetcher`, `NavFetcher`, `ENV_PURPOSES` — EOD quotes (bhavcopy + index + AMFI) run **after** the portfolio sources and before anything that reads a price. A missing fetcher is an explicit skip on stderr, never a step that reports success having done nothing (the placeholder it replaced did exactly that). — writes snapshots, **writes `fx_rates`** (nothing did, so `frankfurter` was permanently stale and held an open BLOCK incident), persists loan schedules + projected RSU vests, raises staleness incidents. Every input — sources AND FX — goes through one `step()` carrying the PRD §8.2 contract. The entrypoint prefers **`RemoteIndmoneySource` over MCP+OAuth** (client id read from `oauth_clients`, `allowedTools: ['networth_holdings']`) and falls back to `FileIndmoneySource` loudly on stderr |
| `src/jobs/digest.ts` | CLI entrypoint — `pnpm digest`. Loads `['telegram']` env, runs migrations + IPS install, composes pure digest, sends via Telegram (dry-run supported) |
| `src/jobs/telegram-bot.ts` | CLI entrypoint — `pnpm telegram:bot`. Loads `['telegram','crypto']` env, runs migrations + IPS install, starts the polling bot |
| `src/notify/telegram-bot.ts` | `TelegramBot`, `displayOrder(positions)`, `resolveProposalTarget(proposals, positions)` — long-polling command bot (`/sync`, `/status`, `/holdings`, `/cost`, `/confirm`, `/reject`, `/fidelity`, `/help`), owner-locked; builds sync sources from the exported `indmoneySource`. Statement photos: single images extract immediately; **albums buffer by `media_group_id`** and flush as one multi-page LLM pass after a short silence. Cost proposals queue until the owner replies `/confirm`; confirmed AND skipped entries leave the queue (a repeat confirm used to double-write). `/holdings` and `/cost` share `displayOrder` — two divergent orderings once wrote a cost to the wrong instrument. Without `LLM_API_KEY` photos are archived and the bot walks the owner through manual `/cost`. **Fidelity RSU path (2026-09-05):** `/fidelity` or an upload hitting `handleFidelity` → `extractRsuVestsFromImage` → `fidelityVestsToProposals` priced at live FX → queued in `fidelityPending`; `/confirm <#>|all` dispatches to the fidelity queue first and writes ACTUAL `rsu_vests` via a PROJECTED `persistVests` ensure + `confirmVest` (grants never auto-created; missing-grant and confirmed entries are consumed so later cost confirms are never blocked); `/reject` clears both queues. Entrypoint is `jobs/telegram-bot.ts` only |
| `src/jobs/keepalive.ts` | CLI entrypoint — weekly `audit_log` insert to keep the Supabase free tier awake (it is a DB write, not an HTTP ping) |
| `src/jobs/ips.ts` | CLI entrypoint — `pnpm ips <clause>` prints the requested IPS clause verbatim |


## Web app (`web/` — Next.js 15, pulled forward 2026-09-05)

Standalone app, **no workspace** (root CI untouched). Run `pnpm web` → `next dev -p 3001`.
Owner asked for the real product after the 8081 preview; this supersedes Task 11A's shell.
Read-only for all portfolio views (imports only read-only domain readers; mutating buttons
are disabled `PendingButton`s). `/import` is the owner-gated write path for statement
ingestion (upload → LLM extraction → owner confirm/reject → real DB writes via existing
platform functions). Details/gotchas in `MEMORY.md § Local web app`.

| File | Exports / role |
|---|---|
| `web/next.config.ts` | three things: parses repo-root `.env` itself (`KEY=value`, skips `#`, sets env only if unset) — **Next has no `envDir`**; `resolve.extensionAlias {'.js':['.ts','.tsx','.js']}` for src's ESM `.js` specifiers; swaps `src/domain/ips.js` for `web/lib/domain-ips-shim.js` via `NormalModuleReplacementPlugin` (webpack rewrites its `new URL(…, import.meta.url)` readFileSync into an inert asset handle that fails at runtime) |
| `web/lib/data.ts` | memoized (60s) live readers: `buildDigestInput` for net worth/drift/staleness/holdings, `getRsu` (live price+FX), `getIps` (`currentIps(await db())`), `getRails`/`getGovernance`/`getMilestones`/`getLoans`/`getAuditRows`/`getFreshness` — DB via one per-process pool; `db()` exported for import routes; alongside optional `Db` for tests |
| `web/lib/ui.tsx` | RSC primitives: `Page`, `PageHeader`, `Stat`, `StatGrid`, `Card`, `Section`, `Table`, `Badge`, `Bar`, `PendingButton` (disabled + reason tooltip), `NotYetBuild` ("Builds in Phase 1 — Task N") |
| `web/lib/product.ts` | `AREAS` ledger of the product map (name/phase/task/status) rendered at `/product` |
| `web/lib/domain-ips-shim.ts` | webpack-safe stand-in for `src/domain/ips.ts` (see next.config); reads the same immutable `src/config/ips-v1.md` and re-exports `IPS_V1_TEXT`, `currentIps`, `ipsClause`, `renderIps` |
| `web/app/{page,holdings,allocation,buckets,rails,rsu,ips,freshness,audit}/page.tsx` | live Phase 0 views via the pure domain functions |
| `web/app/{watchlist,signals,recommendations,maturity,narrative,scoring}/page.tsx` | honest shells ("builds in Task N") |
| `web/app/product/page.tsx` | AREAS map |
| `web/lib/ingest.ts` | server-only import helpers: `ensureWebIngestion` (applies migration 0009 on first `/import` load), `archiveFiles`, `insertUpload`, `extractBrokerage` (displayOrder + knownTickers + LLM + conflict detection), `extractFidelity` (LLM + FX + grant dedupe), `listUploads`, `confirmUpload` (brokerage via `insertOwnerCostLot`, fidelity via `persistVests`+`confirmVest`), `rejectUpload`, `resolveUpload` (status + audit_log) |
| `web/lib/format.ts` | client-safe helpers: `fmtDate`, `fmtDateTime`, `relTime`, `rupees`, `unitsStr` |
| `web/app/nav.tsx` | client nav: Portfolio / Intake (Import statements) / Governance / Phase 1 «soon» chips / System |
| `web/app/import/page.tsx` | `/import` — pending + history sections; LLM-configured notice |
| `web/app/import/upload-form.tsx` | multi-file upload: kind toggle (brokerage/fidelity), file picker, submit, refresh |
| `web/app/import/review-panel.tsx` | per-proposal review: status badges, selectable subset confirm, reject-all, conflict badge |
| `web/app/api/import/route.ts` | POST multipart → archive + extract (or `unusable` when `LLM_API_KEY` absent) |
| `web/app/api/import/[id]/confirm/route.ts` | POST `{indexes?}` → write via existing platform functions + audit |
| `web/app/api/import/[id]/reject/route.ts` | POST → mark rejected + audit |

## Migrations

| File | Contents |
|---|---|
| `migrations/0000_bootstrap.sql` | `schema_migrations` bookkeeping table (single statement) |
| `migrations/0001_phase0.sql` | 16 Phase 0 tables + append-only triggers (~30 statements). `rsu_vests` carries `unique (grant_id, vest_on)` — load-bearing for FR-03's ON CONFLICT |
| `migrations/0002_oauth.sql` | `oauth_clients` (provider, issuer, client_id, client_secret_enc, redirect_uri, registered_on), `oauth_tokens` (provider, access_token_enc, refresh_token_enc, scope, expires_at, rotated_at). AES-256-GCM encryption; client_secret_enc + refresh_token_enc never stored plaintext |
| `migrations/0003_snapshot_uniqueness.sql` | `unique (business_date, source)` on `snapshots` — without it writeSnapshot's select-then-insert is check-then-act and two racing syncs double-count the portfolio |
| `migrations/0004_immutability_and_rls.sql` | append-only triggers on `ips_versions` + `bucket_flows`; `sentinel_lots_immutable()` on `lots` (DELETE/TRUNCATE refused, UPDATE allowed **only** for `closed_on` — closing a lot is the FIFO disposal lifecycle); **RLS enabled on all 18 tables**, no policies, so anon/authenticated are denied and the owner role bypasses |
| `migrations/0005_canonical_instrument.sql` | `instruments.canonical_id` column + index — the C-A reconciliation key. Live source wins per `(canonical_id, account)`; seed fills gaps; seed fallback when live stops reporting |
| `migrations/0007_bond_maturity.sql` | adds `maturity_date`, `face_value_paise`, `coupon_rate_bps` to `instruments` for bond maturity tracking |
| `migrations/0008_bond_units.sql` | adds `units` column to `instruments` for bond unit counts |
| `migrations/0009_amfi_scheme_code.sql` | adds `scheme_code` column to `instruments` for AMFI MF scheme code mapping |
| `migrations/0009_web_uploads.sql` | `web_uploads` queue (uuid pk, kind check, status check, proposals jsonb, summary, error, resolved_at). `sentinel_web_uploads_immutable()` trigger allows only status/summary/resolved_at updates. DELETE/TRUNCATE blocked via `sentinel_append_only()`. RLS enabled. Idempotent — triggers guarded in DO blocks (pg_trigger name checks), safe to re-apply |
| `migrations/0010_phase1_quotes.sql` | `prices_eod`, `index_prices_eod`, `navs`, `holidays` — Phase 1 quote tables. prices_eod/index_prices_eod allow corrections; navs append-only. RLS on all. |
| `migrations/0008_phase1_intel.sql` | `watchlist`, `screener_uploads`, `fundamentals`, `signal_scores`, `recommendations`, `suppressed_actions`, `benchmarks` — Phase 1 intel tables. All append-only + RLS. |
| `migrations/0011_fundamentals_as_of.sql` | `fundamentals.as_of` + drops its append-only UPDATE trigger (re-import must be able to correct a row) |
| `migrations/0013_holiday_special_sessions.sql` | `holidays.is_special_session` — the exchange is OPEN on a day the weekend rule would skip |
| `migrations/0012_benchmark_evals.sql` | `sentinel_benchmarks_immutable()` — UPDATE allowed on `benchmarks` **only** for the eval columns; the creation snapshot (`benchmark_as_of`, `benchmark_jsonb`) can never be rewritten, DELETE/TRUNCATE still refused. Same shape as `sentinel_lots_immutable` |

## Phase 1 (planned — see `2026-09-05-sentinel-phase-1.md`)

| File | Role |
|---|---|
| `src/sources/bhavcopy.ts` | `downloadBhavcopy`, `downloadIndexSeries`, `parseEquityBhavcopy`, `parseIndexBhavcopy`, `ingestPrices`, `unzipFirstEntry` — NSE EQ + index bhavcopy → `prices_eod`, `index_prices_eod` (watchlist+holdings only; unknown symbols logged, never created). NSE serves `.csv.zip`, unpacked with stdlib `node:zlib` — no dependency. A 404 is a non-trading day: zero rows, no incident; anything else is a loud `SYNC_FAILURE`. **URL/columns are unverified against live NSE — see the README provisioning table** — **download implemented 2026-09-13** |
| `src/sources/amfi.ts` | AMFI daily + historical NAV → `navs` (`nav_micros`, BIGINT) — **implemented 2026-09-11** |
| `src/sources/screener.ts` | screener.in CSV → `fundamentals` (versioned per upload batch; real CSV = live test) — **implemented 2026-09-11** |
| `src/sources/screener-screen.ts` | screener.in **screen HTML** → `fundamentals` — `parseScreenHtml(html)` (data-row-company-id rows; header tooltips → canonical keys; `<span>` units stripped; per-column normalization), `fetchScreen(url)` (paginated via `URL.searchParams.set('page', n)` **so query-bearing `/screen/raw/?query=...` URLs page correctly** — the old `base + '?page=N'` stripped queries on page 2; 25/page, stops on short page), `slugToInstrumentId(db, slug)`, `importScreenRows(db, rows, {asOf?, screenUrl})` — idempotent per `(as_of, filename)`, deletes prior batch on re-import because `screener_uploads` is append-only. Built because the CSV export is paywalled; a plain screen URL is public. Requires a screen whose columns carry the §6 gate inputs — **implemented 2026-09-13** |
| `src/sources/llm-watchlist.ts` | `WATCHLIST_PROMPT`, `watchlistCandidates(db, asOf)`, `proposeWatchlist(deps)`, `applyWatchlistProposals(db, proposals, addedOn)` — LLM watchlist shortlisting (owner decision 2026-09-13). The model picks **names only, from a pool it is given**; a ticker it invents is dropped, never created. Held and already-watched names are excluded (§6.1). Rows land as `source: 'llm-advisor'` proposals awaiting sign-off; the engine still gates every one on real data |
| `src/sources/llm-narration.ts` | `NARRATION_PROMPT`, `DEFAULT_NARRATION_MODEL`, `narrate(deps)` — PRD 6.7 narration over OpenRouter. Receives the finished engine output and rewrites it; **nothing it returns feeds back**, so a hallucinated figure can never move a score or a size. Returns `null` (never throws) with no key or on any failure, and the report falls back to its deterministic bullets — **implemented 2026-09-13** |
| `src/domain/engine.ts` | `SATELLITE_WEIGHTS`, `MF_WEIGHTS`, `BANDS`, `QUALITY`, `FINANCE_SECTORS`, `scoreSatellite`, `sectorMedianPe`, `rankMfs`, `persistSignalScores`, `loadEngineInputs` — §6 satellite composite (quality gate → valuation 30 / trend 30 / earnings 20 / fit 20) + MF ranking (consistency 40 / expense 20 / tenure 15 / AUM 15 / style 10). `scoreSatellite` returns **null when the name is blocked by a stale input** (FR-31) and a row with `composite: null, qualityPassed: false` when the gate fails. Returns derive from `bigint` paise / nav micros through integer bps, never a float. `gsecYieldPct` is a **required caller input** — no ingestion source exists for it — **implemented 2026-09-13** |
| `src/domain/alloc-engine.ts` | `TAX_POLICY_NOTE`, `isRebalanceTarget`, `sellCandidates`, `rebalanceRec(state, monthYear)` — §6.4 monthly drift as a *recommendation* + the April annual proposal (FR-13). Takes the Phase 0 `NetWorth` as its basis and **throws if the positions disagree with it**; sizes every move at the drift to the nearest band edge, never past it. Tax preference is one rule — new money before a sale, trims ordered losses-first, unknown cost basis last — and `TAX_POLICY_NOTE` states what it does *not* compute. EPF is never a target in either direction (owner decision); the Kolkata property is a liability line, so it cannot reach the engine — **implemented 2026-09-13** |
| `src/domain/sell-triggers.ts` | `evaluateExits(db, state, month)`, `ExitCandidate`, `FalsificationCondition`, `MINIMUM_HOLD_MONTHS`, `BETTER_ALTERNATIVE_MARGIN`, `LEGACY_QUEUE_STUB` — §6.5 triggers 1–5 and 7 evaluated monthly (FR-15); trigger 6 is the documented Phase 2 stub. Data is cut at **month END**, so a run reviews the whole month. Falsification conditions are read out of `recommendations.primary_rec` JSON (`{instrumentId, falsification:{metric,op,value}}`) and an **untestable condition is never an exit**. Only triggers 1–3 override IPS §3.7's 12-month hold; 4 and 5 surface with `blockedByMinimumHold` rather than being dropped. Blocked instruments (FR-31) produce nothing — **implemented 2026-09-13** |
| `src/domain/redemptions.ts` | `Redemption`, `listRedemptionsUntil(db, horizonDays, referenceDate?)` — the bond redemption reader, split out of `maturities.ts` so `sell-triggers.ts` can use it without transitively importing `buckets.ts` (which re-exports `funded-status`). `maturities.ts` re-exports both |
| `src/domain/maturities.ts` | `maturityRoutingRec` + a re-export of `listRedemptionsUntil`/`Redemption` from `redemptions.ts`; 14-day digest alert (Sammaan Task 1) — **implemented 2026-09-11, reader split out 2026-09-13** |
| `src/domain/recommendations.ts` | `buildRecommendation`, `validateRecommendation`, `announceMaturity`, `gateRecommendation`, `persistRecommendation`, `isPaperMode`, `scanForExecutionPaths`, `MAX_THESIS_WORDS`/`MAX_RECS_PER_MONTH`/`MIN_HOLD_MONTHS`/`OVERRIDE_EVENTS`/`INDEX_ROUTE_INSTRUMENT` — FR-11 objects (primary + **exactly 2** alternates: A1 same intent/different instrument or the index route, A2 a different intent defaulting to do-nothing; ≤150-word theses; every `ips_clause_refs` entry checked against `getIpsClauseIndex`). FR-12 caps (≤4/month, 12-month repeat-BUY hold, 3 override events) **log to `suppressed_actions` rather than dropping**. Paper mode defaults TRUE when the rail is absent. `primary_rec` is written in the shape `sell-triggers` reads back — **implemented 2026-09-13** |
| `src/domain/scoring.ts` | `snapshotBenchmark`, `dueEvals`, `evaluateRec`, `runDueEvals`, `calibration`, `addMonths`, `EVAL_HORIZONS`, `MIN_EVALS_FOR_CALIBRATION` — §13 harness. The creation snapshot (instrument close + index close + conviction) is captured once and **migration 0012 refuses to rewrite it**; 3/6/12-month evals accrue onto the same row. Excess return is integer bps. A bucket under the minimum reads **"insufficient data"**, never a percentage; an unscoreable call is never counted as a miss — **implemented 2026-09-13** |
| `src/notify/report.ts` | `buildReportInput(db, asOf, opts)` + pure `composeReport`/`reportBullets`, `MAX_LIST_ITEMS`, `REDEMPTION_HORIZON_DAYS` — FR-51's five sections (signal review / watchlist changes / recommendation pipeline / staleness / narrative). Runs the week's pipeline: scores, sizes, gates and persists. **Withholds an open recommendation whose instrument is blocked today** into `pipeline.withheld`. Same impure-gather / pure-compose split as `digest.ts`, and deliberately NOT on the funded-status allowlist — **implemented 2026-09-13** |
| `src/jobs/report.ts` | CLI entrypoint — `pnpm report [--as-of YYYY-MM-DD]`. Replaces the retired `pnpm weekly`. Assembles maturity ROUTING recommendations (the one thing that reads bucket status) and hands them to `buildReportInput` as data, writes `docs/dashboard.html`, sends via Telegram. `parseGsecYield` treats a blank env var as unconfigured, never 0% — **implemented 2026-09-13** |
| `src/jobs/screener-import.ts` | CLI — `pnpm screener:import <csv>` (screener.in export) **or** `pnpm screener:import --screen <url>` (public screen HTML). The `--screen` path validates each row's slug against `instruments` and uploads the batch |
| `migrations/0014_widen_screener_source.sql` | widens the `fundamentals.source` CHECK back on `'screener-screen'` (0013 had narrowed it to `'screener-in'` only) — ships with `screener-screen.ts` |
| `migrations/0007_phase1_quotes.sql`, `0008_phase1_intel.sql` | prices_eod / index_prices_eod / navs / holidays; watchlist / screener_uploads / fundamentals / signal_scores / recommendations / suppressed_actions — all append-only + RLS |

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

`tests/sources/fidelity-ingest.test.ts` (6 tests) and `tests/notify/telegram-bot-fidelity.test.ts`
(5 tests) drive the Fidelity RSU flow against real PGlite + a seeded `rsu_grants` table and a
stubbed Telegram (only `fx.js` mocked; screenshots pre-written so `saveStatementPhoto`
short-circuits); `tests/notify/digest.test.ts` carries the ACTUAL-filter guard "no double
forecast" and maturity alert tests. `tests/sources/bhavcopy.test.ts` (8 tests) covers
parsing + ingestion with mutation checks. `tests/sources/amfi.test.ts` (6 tests) covers
parsing + ingestion with mutation checks. `tests/sources/screener.test.ts` (8 tests) covers
parsing + ingestion with mutation checks. `tests/domain/engine.test.ts` (19 tests) covers the
§6 quality gate, composite banding, relative strength, MF ranking and the `signal_scores`
round-trip; its FR-31 case composes the real `assessStaleness` → `blockedInstruments` chain.
`tests/domain/alloc-engine.test.ts` (11 tests) covers in-band reporting, the seed's real gold
shortfall, the tax preference and the April proposal. `tests/domain/sell-triggers.test.ts`
(17 tests) drives all six live §6.5 triggers against real PGlite, including the falsification
round-trip through an appended `recommendations` row. `tests/domain/recommendations.test.ts`
(17 tests) asserts both the acceptance and the rejection path of the FR-11 validator, the FR-12
caps against stored rows, and a cross-task round-trip proving Task 9 reads what Task 10 writes.
`tests/notify/report.test.ts` (13 tests) carries the **Phase 1 DoD**: a fully-formed paper
recommendation with every timestamp shown, and a diff proving a deliberately stale price keeps
a name out of every live recommendation. `tests/domain/scoring.test.ts` (15 tests) covers the
§13 harness, including the database-level refusal to rewrite a creation snapshot.
Suite: **590 passed** across 70 files.

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
| `.github/workflows/digest.yml` | `workflow_run` on **sync success** — no fixed cron | Daily digest (FR-50), now runs after the day's sync completes so it never reads stale snapshots; a failed sync = no digest that day. Manual `workflow_dispatch` remains |
| `.github/workflows/weekly.yml` | `30 4 * * 0` — **Sun 10:00 IST** | Weekly deep report (FR-51) via `pnpm report`. Moved from Sat 08:00 per PRD 12.2 with owner sign-off 2026-09-13 |
| `.github/workflows/keepalive.yml` | `0 4 * * 0` | Largely subsumed by the daily sync; kept as a belt-and-braces Supabase ping |

None of them pin a pnpm `version:` — `package.json`'s `packageManager` is the single
source of truth, and specifying both makes `pnpm/action-setup` fail at setup.

## Scripts

`pnpm test` · `test:watch` · `migrate` · `seed` · `sync` · `digest` · `report` · `ips` · `watchlist:propose` ·
`telegram:bot` · `indmoney:login` · `ui` (phase-1 preview server, 8081) · `web` (`web/` Next.js app, 3001)

`indmoney:login` runs `tsx --env-file=.env`; `web/next.config.ts` parses the root `.env`
itself. No dotenv dep — every other script still needs its vars exported. `.env` is
gitignored and holds `DATABASE_URL=pglite://.pglite` and `TOKEN_ENCRYPTION_KEY`; without
the former the refresh token lands in an in-memory PGlite and is discarded on exit.
