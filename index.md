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
| `src/sources/types.ts` | `SourceRow`, `Source` interface, `writeSnapshot(db, source, businessDate, rows, asOf)` — single upsert path for all sources; every row carries as_of + source. **The whole write is ONE transaction** (the holdings delete precedes the inserts, so an unwrapped failure destroyed the source's holdings under an unattended daily job). Writes `isin`. On instrument conflict the **curated row wins** — only NULL fields are enriched from the payload, never `name`/`issuer` |
| `src/sources/kite.ts` | `KiteSource` — read-only (method allowlist: `fetch`, `getHoldings` only). Requires `KITE_API_KEY` + `KITE_ACCESS_TOKEN`. NO order/GT methods — allowlist test + source scan for mutating endpoints/verbs |
| `src/sources/indmoney.ts` | `FileIndmoneySource` — reads owner-refreshed JSON snapshot (fallback / test double). `RemoteIndmoneySource`, `ASSET_TYPES` — live MCP, same `Source` interface. **Rewritten against a real capture 2026-08-22**: one `networth_holdings` call per asset class (the tool requires `asset_type`), unwraps the `{result: "<json string>"}` envelope, aggregates an instrument held across brokers, ISIN-detected instrumentId, `invested_amount` `'unknown'`/0/absent → null (FR-02). Throws on a rate-limit body, `holding_error`, or an unmapped `asset_type`. Staleness (Task 12) nags when file ages |
| `src/sources/mcp-client.ts` | `McpClient` — Streamable HTTP (JSON-RPC 2.0) over MCP. `callTool<T>(name, args)`. Handles JSON + SSE responses, lazy init (protocolVersion 2025-06-18), `Mcp-Session-Id`, injectable `fetchImpl` |
| `src/sources/fx.ts` | `fetchUsdInr(opts?)` — frankfurter.app endpoint, sanity band 50-200. Returns `{rate, asOf, source: 'frankfurter'}` |
| `src/sources/staleness.ts` | `FRESHNESS_HOURS`, `assessStaleness(db, now)`, `raiseIncidents(db, rows)`, `blockedInstruments(rows, positions)`, `StalenessRow` — checks holdings + fx_rates, reports amfi/bhavcopy/screener as stale (no tables yet), boundary tests at 36h/48h limits |
| `src/domain/ips.ts` | `IPS_V1_TEXT`, `installIps(db, opts?)`, `currentIps(db)`, `ipsClause(text, clause)`, `renderIps(text, clause?)` — PRD §3.1–3.10 verbatim in `src/config/ips-v1.md`, versioned storage in `ips_versions`, idempotent install, clause extraction for FR-10 citations |
| `src/domain/loans.ts` | `amortize`, `runCascade`, `interestPaid`, `nextMonth`, `persistSchedules`. Both schedules share the private `stepLoan()` month step |
| `src/domain/surplus.ts` | `FIXED_OUTFLOWS`, `BASE_TAKE_HOME`, `BASE_TAKE_HOME_AS_OF`, `RENT_TO_EMI_FLAG`, `CHILD_DENT_NO_END_FLAG`, `PARTIAL_YEAR_FLAG`, `SurplusMonth`, `AnnualSurplus` (carries `monthCount` + `flags`), `loanOutflowByMonth`, `projectSurplus`, `projectAnnualSurplus`. `projectSurplus`'s coverage guard is derived from the outflow map's own key range, never from `closures` alone — see `MEMORY.md` |
| `src/domain/rsu.ts` | `VestEvent`, `PROJECTED_SOURCE`, `CONFIRMED_SOURCE`, `projectVests`, `withRefreshers`, `unvestedValue`, `persistVests(db, vests, {asOf?})`, `confirmVest(db, id, actual, {asOf?})`. Tranches are allocated cumulatively so 16 parts always sum to the whole grant; `confirmVest` RECOMPUTES `gross_paise` and runs its update + audit insert in one transaction; `withRefreshers` skips years that already carry a real grant. FR-03 lives in the SQL — one `insert ... on conflict (grant_id, vest_on) do update ... where rsu_vests.status <> 'ACTUAL'`, backed by the unique constraint in `0001` |
| `src/domain/networth.ts` | `InstrumentKind` (mirrors the schema check constraint, `'LOAN'` included), `AssetClass`, `Position` (carries `sector`), `NetWorth`, `classify` (throws on LOAN — a liability must never be summed into assets), `loadPositions(db, businessDate?)` (latest snapshot per source, merged), `netWorth`, `outstandingLiabilities(db, asOfMonth)` (lateral join; falls back to `loans.outstanding_paise` for a month before the schedule starts) |
| `src/domain/allocation.ts` | `IPS_BANDS`, `CAPS` (all five enforced), `SECTOR_COVERAGE_CAVEAT`, `DriftRow`, `Concentration`, `allocationDrift(byAssetClass, total?)` (derives the total, rejects an inconsistent one; drift via `mulP`, never a float), `concentration` (aggregates by instrument/issuer/scheme/sector before applying a cap; reports `sectorCoveragePct`). See `MEMORY.md` for the seed's real breach set |
| `src/notify/telegram.ts` | `Telegram` class — owner-locked client (PRD §4.1, §12.3). `isOwner(chatId)`, `send(markdown)` with 4096-char chunking, dry-run mode, error surfacing. MarkdownV2-safe output (parse_mode: 'Markdown'). |
| `src/notify/digest.ts` | `buildDigestInput(db, now)`, `composeDigest(input)`, `DigestInput` interface — pure daily digest composer (FR-50). Net worth incl. NOW/EPF, day-change, 4 buckets + 2 milestones, IPS drift + concentration breaches, staleness badges, next RSU vest, funded status. |
| `src/jobs/sync.ts` | `runSync(db, now)` — syncs INDmoney (OAuth/file), Kite (read-only), FX; writes snapshots, persists loan schedules + projected RSU vests, raises staleness incidents per PRD §8.2 failure contract (records failing source, does not abort healthy ones, escalates to BLOCK after 2 consecutive failures) |
| `src/jobs/digest.ts` | CLI entrypoint — `pnpm digest`. Loads `['telegram']` env, runs migrations + IPS install, composes pure digest, sends via Telegram (dry-run supported) |
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

## Tests

One file per source module under `tests/`, same relative path. Plus:
`tests/db/schema.test.ts` (constraints, `as_of`/`source` NOT NULL, append-only incl.
TRUNCATE) and `tests/domain/loans.persist.test.ts` (schedule persistence).

`tests/sources/mcp-client.test.ts` (5 tests), `tests/sources/indmoney-remote.test.ts` (11 tests),
`tests/sources/staleness.test.ts` (13 tests), `tests/fixtures/indmoney-holdings-mcp.json` — **a real capture** (52 holdings across 6 asset
classes, plus the rate-limit body), taken 2026-08-22 through the live MCP. 211 tests.

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

## Scripts

`pnpm test` · `test:watch` · `migrate` · `seed` · `sync` · `digest` · `ips` · `indmoney:login`

`indmoney:login` runs `tsx --env-file=.env` — nothing else loads `.env` (no dotenv dep), so
every other script still needs its vars exported. `.env` is gitignored and holds
`DATABASE_URL=pglite://.pglite` and `TOKEN_ENCRYPTION_KEY`; without the former the refresh
token lands in an in-memory PGlite and is discarded on exit.
