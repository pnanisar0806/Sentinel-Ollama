# Graph Report - Sentinel-Ollama  (2026-09-13)

## Corpus Check
- 183 files · ~153,372 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1400 nodes · 3377 edges · 93 communities (84 shown, 8 thin omitted)
- Extraction: 95% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 151 edges (avg confidence: 0.85)
- Token cost: 592,350 input · 0 output

## Community Hubs (Navigation)
- INDmoney Source Adapter
- Repo Docs & Web Pages
- Telegram & Dashboard Output
- DB Client, Migrate, Seed
- INDmoney OAuth Login
- Root Package Manifest
- Statement Import Web Flow
- Env & Secrets Loading
- Buckets & Planning Assumptions
- Source Adapters & MCP
- Phase 0 Core Schema
- RSU Vest Engine
- Surplus & Fixed Outflows
- IPS Clause Machinery
- Loan Amortization & Cascade
- Ingestion Defect History
- Phase 1 Intel Schema
- FX & Fidelity RSU Ingest
- NSE Bhavcopy Pipeline
- Cost Basis & Lot Rules
- Owner-Confirm Write Safety
- Allocation Drift & Caps
- Digest Contract & DoD
- Local Preview UI Render
- Funded Status & FI Band
- Web Review Panel UI
- Web TypeScript Config
- Web Data Access Layer
- Digest Input Assembly
- Bond Face Value Handling
- Phase 1 Plan & Screener
- Rails & Bucket Status
- IPS Discipline Clauses
- Staleness Engine
- FX Source & Vest Tranches
- IPS Allocation Clauses
- Audit & As-Of Provenance
- AMFI NAV Pipeline
- Screener.in Importer
- Assumptions & Loan Caveats
- Fixture & Secret Handling
- Digest Gating & Webpack Shims
- Instruments & Lots Schema
- Sync Cron & Data Honesty
- LLM Extraction Defects
- Net Worth & Asset Class
- FI Corpus & Milestones
- RSU Vest Rules
- Concentration Breach Set
- Web Package Manifest
- Money Primitives & Live Price
- Root TypeScript Config
- Branch Review & IPS Verbatim
- Domain Type Contracts
- Keepalive & Secrets Policy
- LLM Provider Config Fixes
- Sync Job & Snapshots
- Immutability & RLS Migration
- Prepayment Cascade Model
- Db Interface & PGlite
- Phase 1 Quote Schema
- Funded Status Arch Test
- No-Catch-Up Firewall
- Recommendation Contracts
- Guard-Rail Test Discipline
- Token Store & Dry Run
- Phase 1 DoD & LLM Boundary
- Web Layout & Nav
- CI Test & Typecheck Gate
- Sync/Digest Workflow Chain
- Weekly Report Workflow
- MF Ranking & Score Split
- Provisioning Secrets Policy
- Money Primitives Task
- Workflow Schedule Test
- Telegram Provisioning
- Project Overview & Layout
- Web Uploads Migration
- Web Dev Dependencies
- Web NPM Scripts
- Weekly Cadence & FX Defect
- Tax Engine & Legacy Cleanup
- Session Protocols
- Telegram Bot Commands
- Node & pnpm Toolchain
- Subagent Execution Model
- Null Cost & Blank DB URL
- Bootstrap Migration
- Fundamentals As-Of Migration
- Next Env Types
- FR-01 Kite Daily Sync
- IPS Trading Discipline

## God Nodes (most connected - your core abstractions)
1. `Db` - 65 edges
2. `vitest` - 63 edges
3. `paise` - 58 edges
4. `openDb()` - 48 edges
5. `runMigrations()` - 44 edges
6. `rupees()` - 32 edges
7. `TelegramBot` - 32 edges
8. `formatInr()` - 31 edges
9. `loadPositions()` - 29 edges
10. `buildDigestInput()` - 28 edges

## Surprising Connections (you probably didn't know these)
- `buckets.ts — buckets, milestones, funded status (Task 10)` --implements--> `B2 House fund bucket (Hyderabad purchase 2033-35)`  [INFERRED]
  MEMORY.md → PRD_investment_agent.md
- `invested_amount is FACE VALUE, not cost — avgCostPaise null for BOND rows` --references--> `FR-02 INDmoney sync; unknown invested amounts never shown as ₹0`  [INFERRED]
  MEMORY.md → PRD_investment_agent.md
- `Open defect — FX BLOCKs every weekend (48h limit vs ECB weekday publication)` --semantically_similar_to--> `Scope call 6 — weekly cadence Sat 08:00 → Sunday 10:00 IST (§12.2)`  [INFERRED] [semantically similar]
  PENDING.md → docs/superpowers/plans/2026-09-05-sentinel-phase-1.md
- `Scheduled job times in IST (sync 17:30, digest 08:45, keepalive Sun 09:30)` --references--> `Digest Workflow`  [AMBIGUOUS]
  docs/SETUP.md → .github/workflows/digest.yml
- `Unknown cost basis is NULL, never 0` --semantically_similar_to--> `Blank DATABASE_URL is refused rather than silently falling back to PGlite`  [INFERRED] [semantically similar]
  CLAUDE.md → docs/SETUP.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Source adapters implementing the one Source contract** — docs_superpowers_plans_2026_08_12_sentinel_phase_0_source_interface, docs_superpowers_plans_2026_08_12_sentinel_phase_0_kite_source_class, docs_superpowers_plans_2026_08_12_sentinel_phase_0_file_indmoney_source, docs_superpowers_plans_2026_08_12_sentinel_phase_0_remote_indmoney_source, docs_superpowers_plans_2026_08_12_sentinel_phase_0_src_sources_fx [EXTRACTED 1.00]
- **Staleness detection flow (as_of/source to blocked instruments)** — docs_superpowers_plans_2026_08_12_sentinel_phase_0_as_of_and_source_on_every_row, docs_superpowers_plans_2026_08_12_sentinel_phase_0_freshness_policy, docs_superpowers_plans_2026_08_12_sentinel_phase_0_assess_staleness, docs_superpowers_plans_2026_08_12_sentinel_phase_0_raise_incidents, docs_superpowers_plans_2026_08_12_sentinel_phase_0_blocked_instruments, docs_superpowers_plans_2026_08_12_sentinel_phase_0_table_incidents [EXTRACTED 1.00]
- **Inputs composing the daily Telegram digest** — docs_superpowers_plans_2026_08_12_sentinel_phase_0_net_worth_fn, docs_superpowers_plans_2026_08_12_sentinel_phase_0_allocation_drift_fn, docs_superpowers_plans_2026_08_12_sentinel_phase_0_concentration_fn, docs_superpowers_plans_2026_08_12_sentinel_phase_0_bucket_statuses, docs_superpowers_plans_2026_08_12_sentinel_phase_0_milestone_statuses, docs_superpowers_plans_2026_08_12_sentinel_phase_0_assess_staleness, docs_superpowers_plans_2026_08_12_sentinel_phase_0_project_vests, docs_superpowers_plans_2026_08_12_sentinel_phase_0_funded_status_fn, docs_superpowers_plans_2026_08_12_sentinel_phase_0_compose_digest [EXTRACTED 1.00]
- **The no-catch-up firewall (PRD rail, FR, architecture test, allowlisted consumers)** — prd_investment_agent_no_catch_up_rail, prd_investment_agent_fr_16, prd_investment_agent_ips_objective_function, memory_funded_status_firewall, memory_fi_corpus_band, memory_buckets_module, memory_digest [EXTRACTED 0.95]
- **Owner-confirm statement ingestion flow (photo → LLM proposal → confirm → lot/vest + audit)** — memory_owner_ingest, memory_llm_extract, memory_statement_tickers, memory_display_order, memory_upload_idempotency, memory_fidelity_ingest, memory_web_import_flow, prd_investment_agent_fr_02, prd_investment_agent_fr_03 [EXTRACTED 0.90]
- **Seed vs live portfolio reconciliation (double-count cause, fix, and open true-ups)** — memory_seed_sync_double_count, memory_load_positions, memory_resolve_canonical_id, memory_seed_holdings, memory_basket_decomposition_open, memory_kite_retired, memory_latest_per_source_rule [EXTRACTED 0.90]
- **Phase 1 free-source data pipeline gated by the staleness choke point** — src_sources_bhavcopy, src_sources_amfi, src_sources_screener, src_sources_staleness, src_domain_engine, migrations_0010_phase1_quotes [EXTRACTED 1.00]
- **FR-11 paper recommendation flow — candidates to weekly report** — src_domain_engine, src_domain_alloc_engine, src_domain_sell_triggers, src_domain_maturities, src_domain_recommendations, src_notify_report, src_domain_scoring [EXTRACTED 1.00]
- **Owner statement ingestion — extract, propose, confirm, write (bot + web surfaces)** — src_sources_llm_extract, src_sources_fidelity_ingest, src_sources_owner_ingest, src_sources_proposal_target, src_notify_telegram_bot, web_lib_ingest, src_domain_rsu [EXTRACTED 1.00]
- **Scheduled GitHub Actions job fleet (sync, digest, weekly, keepalive, CI)** — _github_workflows_sync_workflow, _github_workflows_digest_workflow, _github_workflows_weekly_workflow, _github_workflows_keepalive_workflow, _github_workflows_ci_workflow, docs_setup_schedule_table [EXTRACTED 0.95]
- **IPS 3.5 machine-enforced concentration rails** — src_config_ips_v1_single_stock_cap_10, src_config_ips_v1_single_issuer_cap_10, src_config_ips_v1_single_mf_scheme_cap_35, src_config_ips_v1_single_sector_cap_25, src_config_ips_v1_employer_stock_cap_10 [EXTRACTED 1.00]
- **PRD hard constraints (never violate, never soften)** — claude_no_trading_paths, claude_no_autonomous_execution, claude_single_user, claude_no_stored_broker_credentials, claude_secrets_outside_repo, claude_telegram_owner_lock, claude_audit_immutability, claude_kolkata_property_excluded, claude_funded_status_isolation [EXTRACTED 1.00]

## Communities (93 total, 8 thin omitted)

### Community 0 - "INDmoney Source Adapter"
Cohesion: 0.05
Nodes (41): Kite 500 root cause — relative URLs passed to NextResponse.redirect, Kite retired — INDmoney is the only portfolio source (double-count found), InstrumentSeed, aggregate(), ALNUM(), ASSET_TYPES, brokerAccountFor(), CURRENCY_BY_ASSET_TYPE (+33 more)

### Community 1 - "Repo Docs & Web Pages"
Cohesion: 0.08
Nodes (37): Phase 0 SDD progress ledger, Sentinel Phase 1 ("Think") implementation plan, Reference code is deliberately sparse — Phase 0 snippets shipped 4 real defects, Sentinel repo map (index.md), Derive the actual side of an assertion from real data, never hard-code both, PENDING.md — open items + watch list, Web redesign v2 — undefined CSS grid classes were the root cause, tests/domain/allocation.test.ts — seed-backed breach-set assertions (+29 more)

### Community 2 - "Telegram & Dashboard Output"
Cohesion: 0.09
Nodes (24): TelegramEnv, ENV_PURPOSES, formatInr(), groupIndian(), breachFlag(), driftClass(), formatInrCompact(), formatInrFull() (+16 more)

### Community 3 - "DB Client, Migrate, Seed"
Cohesion: 0.16
Nodes (19): Gotcha — pnpm seed printed a snapshot id but persisted nothing (pooler 6543 churn), vitest, Db, openDb(), DEFAULT_DIR, runMigrations(), seed(), SEED_WATCHLIST (+11 more)

### Community 4 - "INDmoney OAuth Login"
Cohesion: 0.09
Nodes (35): RFC-7591, OAuth dynamic client registration + PKCE loopback flow, env, existing, key, SCOPES, state, url (+27 more)

### Community 5 - "Root Package Manifest"
Cohesion: 0.06
Nodes (35): author, dependencies, @electric-sql/pglite, postgres, description, devDependencies, tsx, @types/node (+27 more)

### Community 6 - "Statement Import Web Flow"
Cohesion: 0.10
Nodes (28): dynamic, POST(), dynamic, POST(), dynamic, ImportPage(), UploadForm(), ArchivedPage (+20 more)

### Community 7 - "Env & Secrets Loading"
Cohesion: 0.12
Nodes (22): Watch item — digest triggers on workflow_run of sync success (no fixed cron), Watch item — TOKEN_ENCRYPTION_KEY rotated 2026-09-07, login re-verified, CryptoEnv, demanded(), Env, KEYS, loadEnv(), Purpose (+14 more)

### Community 8 - "Buckets & Planning Assumptions"
Cohesion: 0.16
Nodes (20): Bucket B2: House fund (Hyderabad, 2033-35), Bucket B3: Emergency fund (Rs 6L), Bucket B4: Education corpus (Rs 1 Cr, activates ~2028), Assumptions, Bucket, BucketId, BUCKETS, bucketStatus (+12 more)

### Community 9 - "Source Adapters & MCP"
Cohesion: 0.12
Nodes (25): Absent code paths, not toggles (no orders, F&O, leverage), blockedInstruments, ensureAccessToken, FileIndmoneySource, Fixture honesty: capture real payloads before writing mappers, KiteSource, McpClient, MCP over Streamable HTTP (JSON or SSE) (+17 more)

### Community 10 - "Phase 0 Core Schema"
Cohesion: 0.11
Nodes (24): IST business dates as YYYY-MM-DD strings, audit_log, audit_log_entity_idx, audit_log_truncate_only, bucket_flows, buckets, fx_rates, holdings (+16 more)

### Community 11 - "RSU Vest Engine"
Cohesion: 0.12
Nodes (18): Bug — digest double-announced confirmed vests (PGlite DATE→Date key), allocate(), CONFIRMED_SOURCE, confirmVest(), persistVests(), PROJECTED_SOURCE, projectVests(), NOTE: the returned refresher grants are hypothetical and have no `rsu_grants`… (+10 more)

### Community 12 - "Surplus & Fixed Outflows"
Cohesion: 0.13
Nodes (21): FIXED_OUTFLOWS (rent, mother, wife, maid, misc), Mother's support never terminates, Task 8 — Allocation engine: monthly drift + April rebalance, Owner true-ups — milestone raised_on dates, monthly electricity figure, src/domain/alloc-engine.ts — §6.4 drift + tax-aware rebalance rec, BASE_TAKE_HOME, BASE_TAKE_HOME_AS_OF, CHILD_DENT_NO_END_FLAG (+13 more)

### Community 13 - "IPS Clause Machinery"
Cohesion: 0.17
Nodes (11): FR-10 — every recommendation cites ≥1 real IPS v1 clause id, Task 1 — Sammaan bond maturity: model, route, alert, currentIps(), getIpsClauseIndex(), installIps(), IPS_V1_TEXT, ipsClause(), renderIps() (+3 more)

### Community 14 - "Loan Amortization & Cascade"
Cohesion: 0.18
Nodes (16): amortize(), interestPaid(), LoanInput, LoanRow, monthlyInterest(), nextMonth(), persistSchedules(), runCascade() (+8 more)

### Community 15 - "Ingestion Defect History"
Cohesion: 0.14
Nodes (17): Defect — /cost line-number/order mismatch (fixed by shared displayOrder), Defect — partial /confirm double-writes (queue removal fix), Defect — jsonb double-encoding of audit payloads (8 write sites), Watch item — corrections go through supersede, never UPDATE-of-cost or DELETE, Command, COMMANDS, TelegramUpdate, CostCommand (+9 more)

### Community 16 - "Phase 1 Intel Schema"
Cohesion: 0.16
Nodes (21): Advisor-owned watchlist — owner curates at setup, quarterly revision is a proposal, audit_log_append_only, sentinel_append_only(), benchmarks, benchmarks_append_only, benchmarks_truncate_only, fundamentals_append_only, fundamentals_truncate_only (+13 more)

### Community 17 - "FX & Fidelity RSU Ingest"
Cohesion: 0.20
Nodes (12): Awaiting owner — real Fidelity statement as the live test + RSU split true-up, toUnitsMicros(), UNITS_SCALE, rateMicros(), usdToInr(), mulP(), checkFidelityVestExists(), FIDELITY_EXTRACTION_PROMPT (+4 more)

### Community 18 - "NSE Bhavcopy Pipeline"
Cohesion: 0.15
Nodes (17): Task 3 — NSE EOD price pipeline (EQ bhavcopy + index series), BhavcopyReport, BhavcopyRow, buildEquityUrl(), buildIndexUrl(), downloadBhavcopy(), fetchWithRetry(), formatNseDate() (+9 more)

### Community 19 - "Cost Basis & Lot Rules"
Cohesion: 0.12
Nodes (20): Append-only statement triggers (UPDATE/DELETE/TRUNCATE) on audit_log, snapshots, ips_versions, bucket_flows, Cost lives on lots, never holdings.avg_cost_paise (holdings are replaced per sync), A curated instrument row beats the payload (name never overwritten), Db interface contract (query/exec/withTransaction/close), Deferred minors ledger + fix-on-touch rule, TODO: explicit ISIN→issuer map (payload returns stale pre-rebrand Indiabulls name), Never feed JSON.stringify to a ::jsonb placeholder (double-encoded audit payloads), Money is never a float (rupees(x) * 12n pattern) (+12 more)

### Community 20 - "Owner-Confirm Write Safety"
Cohesion: 0.13
Nodes (20): Check-then-act on an owner-confirmed row is the recurring bug class, confirmVest — recomputes gross, rejects net>gross, one transaction with audit, displayOrder / resolveProposalTarget — the one ordering both handlers share, sources/fidelity-ingest.ts — extractRsuVestsFromImage → FidelityProposal[], Grants are never auto-created (FR-02 discipline on vests), OPEN: entire Indian equity book has no cost basis (invested_amount 'unknown'), src/sources/llm-extract.ts — OpenRouter vision chain producing proposals only, sentinel_lots_immutable — lots allow only closed_on UPDATE (+12 more)

### Community 21 - "Allocation Drift & Caps"
Cohesion: 0.19
Nodes (15): ALL_CLASSES, allocationDrift(), CAPS, concentration, DriftRow, isDirectStock(), pct(), SECTOR_COVERAGE_CAVEAT (+7 more)

### Community 22 - "Digest Contract & DoD"
Cohesion: 0.17
Nodes (19): composeDigest (pure), Digest contract (FR-50), GitHub Actions workflows (sync, digest, keepalive), installIps, IPS clause citation machinery (FR-10 in Phase 1), ipsClause, Phase 0 Definition of Done, Sentinel Phase 0 Implementation Plan (+11 more)

### Community 23 - "Local Preview UI Render"
Cohesion: 0.22
Nodes (18): Scope call 8 — a local read-only preview UI is added to Phase 1 (port 8081), Task 11A — Local preview UI (pnpm ui, 127.0.0.1:8081), composeDigest(), pct(), compact(), digestPage(), escapeHtml(), full() (+10 more)

### Community 24 - "Funded Status & FI Band"
Cohesion: 0.13
Nodes (18): buckets.ts — buckets, milestones, funded status (Task 10), Open: child dent has no end condition until B4 lands, computeFICorpusBand — band varies income, SWR is a separate axis, FundedRatio brand does not close parameter injection, funded_status firewall — no-catch-up architecture test (real import-graph walk), Kite read-only surface enforced by an exact method allowlist, not a negative grep, Mapper reads only holdings — persisting F&O/MTF rows would build a forbidden trading path, Plan audit — 21 findings on tasks 7-15 before implementation (+10 more)

### Community 25 - "Web Review Panel UI"
Cohesion: 0.19
Nodes (14): brokerageRow(), fidelityRow(), ProposalTable(), PropRow, ReviewPanel(), STATUS_LABEL, toggle(), fmtDateTime() (+6 more)

### Community 26 - "Web TypeScript Config"
Cohesion: 0.11
Nodes (17): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+9 more)

### Community 27 - "Web Data Access Layer"
Cohesion: 0.30
Nodes (16): Owner decision — "this is a dashboard, build the real app" (web/ pulled forward), loadPositions(), blockedInstruments(), StalenessRow, gold(), AuditRow, db(), FreshnessData (+8 more)

### Community 28 - "Digest Input Assembly"
Cohesion: 0.15
Nodes (17): allocationDrift, assessStaleness, bucketStatuses, buildDigestInput, Concentration caps (PRD 3.5): single stock, employer, issuer, concentration, Employer concentration cap 10% on NOW, Freshness policy (prices 24h, NAVs 48h, FX 48h, portfolio 36h, fundamentals 1 quarter) (+9 more)

### Community 29 - "Bond Face Value Handling"
Cohesion: 0.13
Nodes (17): allocationDrift — derives total, rejects an inconsistent one, invested_amount is FACE VALUE, not cost — avgCostPaise null for BOND rows, Owner decision: bonds are the only chosen debt (12.9%, halves at Sammaan maturity), Bonds verified from INDmoney bonds screen — ₹5,99,999.61 invested, 20% cash ceiling kept as an owner rail in settings_rails, Owner decision: EPF is passive, not a lever (68.7% of the debt bucket), GOLD 1.32% under its 5% floor — the only IPS drift the seed produces, IPS_BANDS — only PRD-verbatim rails after the DEBT floor was dropped (+9 more)

### Community 30 - "Phase 1 Plan & Screener"
Cohesion: 0.14
Nodes (17): Phase 1 plan — 13 tasks (Sammaan maturity → schema 0007/0008 → feeds → engines → weekly report), Owner decision: pinned screener CSV format spec + fixture; the real export is the live test, Owner decision: watchlist is advisor-owned, quarterly revision is a proposal, AMFI daily NAV feed, Approval workflow state machine, FR-11 recommendation payload (primary + 2 alternates, thesis, falsification, conviction), Zerodha / Kite Connect Personal integration (full loop), No autonomous execution (fresh human approval per order) (+9 more)

### Community 31 - "Rails & Bucket Status"
Cohesion: 0.25
Nodes (13): IPS_BANDS, bucketStatuses(), milestoneStatuses(), listRedemptionsUntil(), netWorth, DEFAULT_OWNER_RAILS, evaluateRails(), loadOwnerRails() (+5 more)

### Community 32 - "IPS Discipline Clauses"
Cohesion: 0.14
Nodes (15): No autonomous execution (fresh human approval per order), IPS 3.1 Philosophy — the default action is no action, IPS 3.4 Core-satellite 75/25 equity structure, IPS 3.7 Trading discipline, IPS 3.9 Legacy cleanup mandate, Core: index instruments (Nifty 50, Next 50, PPFC-type flexi-cap, US index), <=4 recommended actions per month, Micro-orphans (<5k) consolidated first; Groww Reliance Power manual closure (+7 more)

### Community 33 - "Staleness Engine"
Cohesion: 0.18
Nodes (14): FR-31 — stale is blocked, visibly, Staleness engine is the choke point, not the adapters, assessStaleness(), FX_SOURCE_NAMES, getLatestFundamentalsAsOf(), getLatestFxAsOf(), getLatestHoldingsAsOf(), getLatestNavsAsOf() (+6 more)

### Community 34 - "FX Source & Vest Tranches"
Cohesion: 0.15
Nodes (15): Cumulative tranche allocation (parts always sum to the whole grant), fetchUsdInr — frankfurter.app with hard-coded 50-200 sanity band, Removing a source must resolve its incidents in the same breath, Kite retired — INDmoney is the only portfolio source (2026-09-07), OPEN: milestones has no raised_on column, daysOutstanding is null, Never invent a number to close a gap — discrepancies go to the owner true-up list, RSU vest projection — 469.375 unvested units / ₹57,05,047.56, OPEN true-up: RSU per-grant unit split (₹57.05L model vs PRD ₹53.25L) (+7 more)

### Community 35 - "IPS Allocation Clauses"
Cohesion: 0.15
Nodes (14): Kolkata property is not an optimization target, Local quickstart (migrate, seed, DRY_RUN digest), IPS 3.3 Strategic asset allocation, IPS 3.5 Hard concentration caps (machine-enforced), IPS 3.8 Credit rule (must beat 7.95% loan rate post-tax, post-haircut), B2 house fund: 100% capital-preservation once seeded, Employer stock (NOW) cap: <=10%, sell-on-vest of excess, Debt/EPF/cash remainder; EPF counts as debt-like (+6 more)

### Community 36 - "Audit & As-Of Provenance"
Cohesion: 0.19
Nodes (14): Append-only audit (FR-07) via UPDATE/DELETE triggers, Every externally-sourced row carries as_of + source, Known thin spots the implementer must not paper over, NSE:SMALLCASE-RESIDUE placeholder position, src/seed/seed.ts (idempotent seeding job), src/seed/seed-data.ts (SEED_* constants), audit_log table, holdings table (+6 more)

### Community 37 - "AMFI NAV Pipeline"
Cohesion: 0.20
Nodes (11): Task 4 — AMFI NAV pipeline (daily + historical), AmfiReport, downloadDailyNav(), downloadHistory(), fetchWithRetry(), ingestNavs(), NavHistoryRow, NavRow (+3 more)

### Community 38 - "Screener.in Importer"
Cohesion: 0.21
Nodes (11): Task 6 — Starter watchlist + screener.in importer, ENV_PURPOSES, screenerImport(), importScreener(), parseBool(), parseNumber(), parseScreenerCsv(), SCREENER_COLUMNS (+3 more)

### Community 39 - "Assumptions & Loan Caveats"
Cohesion: 0.16
Nodes (14): AnnualSurplus.flags caveats (RENT_TO_EMI, CHILD_DENT_NO_END, PARTIAL_YEAR), src/config/assumptions.ts — single source of truth for PRD §15.2, SBI home loan is two accounts modelled as one line (₹29,63,143), projectSurplus — surplus curve, ₹82,124/month at Sep 2026, runCascade — concurrent amortization + prepayment cascade, SEED_LOANS — three owner-verified loans (₹36.53L, ₹55,526 EMI), Car loan 1 (HDFC, ₹13,821 EMI, ends Jan 2028), Car loan 2 (Bank of Baroda, ₹17,223 EMI, 7.95%) (+6 more)

### Community 40 - "Fixture & Secret Handling"
Cohesion: 0.15
Nodes (14): An unset GitHub Actions secret interpolates to '' — a blank DATABASE_URL now throws, FileIndmoneySource — owner-refreshed JSON snapshot fallback, Owner decision: fixture PII accepted, repo stays private (revisit if multi-user), INDmoney OAuth — DCR + PKCE + AES-256-GCM token store, pnpm indmoney:login, McpClient — Streamable HTTP client against mcp.indmoney.com, A rate-limited MCP reply returns 200 with an error body — must be fatal, not empty holdings, indmoney:login gotchas (cmd truncates OAuth URL at &, callback failure modes, in-memory PGlite), RemoteIndmoneySource — live MCP mapper, remapped against a real capture (+6 more)

### Community 41 - "Digest Gating & Webpack Shims"
Cohesion: 0.15
Nodes (14): src/notify/digest.ts — pure buildDigestInput + composeDigest, Digest gating — digest.yml fires on workflow_run of sync, no fixed cron, web/lib/domain-ips-shim.ts — webpack NormalModuleReplacementPlugin for ips.ts readFileSync, .env values must be UNQUOTED (hand-rolled loaders don't strip quotes), isMainModule() — import.meta.url comparison never matches on Windows, loadEnv(source, purposes) — a job must name its purpose, Net worth — assets ₹47,68,999.61, liabilities from cascade closing balances, Documented scope calls (no Next.js UI in Phase 0, OAuth sync, Supabase not provisioned) (+6 more)

### Community 42 - "Instruments & Lots Schema"
Cohesion: 0.14
Nodes (12): instruments, lots, lots_fifo_idx, instruments_canonical_id_idx, lots_one_open_owner_per_position, fundamentals, fundamentals_instrument_idx, screener_uploads (+4 more)

### Community 43 - "Sync Cron & Data Honesty"
Cohesion: 0.15
Nodes (13): Daily 12:00 UTC sync cron, Weekday-only sync caused false staleness alarms, Every externally-sourced row carries as_of and source, Never silently absorb a data discrepancy, Never invent a number to close a gap, Never widen a test band to make a red test green, No trading paths (absent code paths, no override flag), blockedInstruments from the staleness engine feeds FR-31 refusal (+5 more)

### Community 44 - "LLM Extraction Defects"
Cohesion: 0.18
Nodes (10): Fidelity Telegram flow diagnosed as a dead end ({items} vs {vests} schema mismatch), Gotcha — LLM line-anchor swap on near-identical names (TMCV/TMPV/TATAPOWER), extractRsuVestsFromImage(), DEFAULT_LLM_MODEL, extractHoldingsFromImage(), extractJsonFromImage(), LLM_MODEL_CHAIN, LlmProposal (+2 more)

### Community 45 - "Net Worth & Asset Class"
Cohesion: 0.19
Nodes (12): Asset-class mapping (EQUITY/DEBT/GOLD/CASH), EPF counts as debt-like ballast, not equity, classify(), DEBT_INSTRUMENTS, HoldingRow, InstrumentKind, LiabilityRow, outstandingLiabilities() (+4 more)

### Community 46 - "FI Corpus & Milestones"
Cohesion: 0.17
Nodes (13): Bucket B1: FI corpus (10.3-17.1 Cr real at age 55), FI corpus band (SWR 3.5% floor / 4% optimistic), fundedStatus / fiCorpusBand, Milestone M1: Rs 2 Cr term life cover, Milestone M2: ~Rs 50L health super top-up, milestoneStatuses, FR-16 no-catch-up property: funded status unreadable by risk code, PRD 15.2 planning assumptions, single source of truth (+5 more)

### Community 47 - "RSU Vest Rules"
Cohesion: 0.19
Nodes (13): confirmVest, Net-of-withholding factor 0.70 on RSU vests, persistVests, projectVests, PROJECTED never overwrites owner-confirmed ACTUAL, Quarterly vests on the 15th of Feb/May/Aug/Nov over 4 years, raiseIncidents, RSU refresher scenario: $20,000/yr grants (+5 more)

### Community 48 - "Concentration Breach Set"
Cohesion: 0.17
Nodes (13): OPEN: basket decomposition (SMALLCASE-RESIDUE, US:INDMONEY-BASKET), Real breach set (SMALLCASE-RESIDUE 13.74%, US:NOW 10.48%, employer, issuer ServiceNow), concentration — aggregates by instrument/issuer/scheme/sector before capping, SECTOR_COVERAGE_CAVEAT — sector cap sees only 10.54% of the portfolio, Employer concentration risk (salary + RSU + insurance all ServiceNow), FR-15 sell logic is first-class, FR-32 /freeze kill switch, FR-33 circuit breaker (3 falsifications → report-only) (+5 more)

### Community 49 - "Web Package Manifest"
Cohesion: 0.15
Nodes (12): react-dom, @types/react, @types/react-dom, dependencies, next, react, react-dom, @types/node (+4 more)

### Community 50 - "Money Primitives & Live Price"
Cohesion: 0.26
Nodes (8): cents, dollars(), parseMinorUnits(), FidelityProposal, fetchUsdInr(), fetchNowPrice(), LivePrice, LiveRsuInputs

### Community 51 - "Root TypeScript Config"
Cohesion: 0.15
Nodes (12): compilerOptions, exactOptionalPropertyTypes, module, moduleResolution, noUncheckedIndexedAccess, outDir, skipLibCheck, strict (+4 more)

### Community 52 - "Branch Review & IPS Verbatim"
Cohesion: 0.18
Nodes (12): Whole-branch review 2026-08-22 (7 Critical, ~35 Important, none visible to the green suite), src/config/ips-v1.md — PRD §3.1-§3.10 copied verbatim, The plan's reference code is a sketch, not truth (defects in tasks 2, 3, 5, 6), NEAR-TERM EVENT: INE148I07GL3 matures 26-Sep-2026 (₹3L face + ₹27k coupon), B3 Emergency fund bucket (₹6L liquid by Dec 2026), 30% drawdown tolerance / revealed behavioural profile, Investment Policy Statement (IPS), IPS §3.10 Behavioral protocol (−20% drawdown typed-reason gate) (+4 more)

### Community 53 - "Domain Type Contracts"
Cohesion: 0.23
Nodes (12): MilestoneStatus, ScheduleRow, Redemption, RailBreach, VestEvent, AnnualSurplus, SurplusMonth, paise (+4 more)

### Community 54 - "Keepalive & Secrets Policy"
Cohesion: 0.22
Nodes (11): src/jobs/keepalive.ts invocation, keepalive job (weekly Sunday cron), Keepalive Workflow, Audit immutability (append-only triggers + RLS), Secrets live only in GitHub Actions / Vercel env, DATABASE_URL secret, Setup and Deployment Guide, RLS verification (every table rowsecurity = t) (+3 more)

### Community 55 - "LLM Provider Config Fixes"
Cohesion: 0.22
Nodes (8): opencode Zen LLM swap investigated then reverted to OpenRouter free, Webpack gotchas — .js→.ts alias, ips shim, no envDir, 60s memo, LLM extraction fixed — OpenRouter key moved from shell env into repo-root .env, next, IPS_V1_TEXT, ipsClause(), renderIps(), config

### Community 56 - "Sync Job & Snapshots"
Cohesion: 0.20
Nodes (5): runSync(), FileIndmoneySource, raiseIncidents(), Source, writeSnapshot()

### Community 57 - "Immutability & RLS Migration"
Cohesion: 0.22
Nodes (9): Production repair — 89 lots → 29 open via audited closed_on cleanup, bucket_flows_append_only, bucket_flows_truncate_only, ips_versions_append_only, ips_versions_truncate_only, lots_immutable_delete, lots_immutable_update, lots_truncate_only (+1 more)

### Community 58 - "Prepayment Cascade Model"
Cohesion: 0.29
Nodes (10): amortize, Take-home steps up 10% each April (fiscal-year start), Child dent of Rs 10,000/month from Jan 2028, Total loan outflow stays flat at ~Rs 55,526/month, Prepayment cascade: freed EMIs roll into the next loan, projectAnnualSurplus, projectSurplus, runCascade (+2 more)

### Community 59 - "Db Interface & PGlite"
Cohesion: 0.24
Nodes (9): Db interface (query/close), PGlite locally, Supabase in prod, identical SQL, Scope Call: Supabase not provisioned yet, src/db/client.ts (Db, openDb), src/db/migrate.ts (runMigrations), src/jobs/keepalive.ts (weekly Supabase keep-alive), Task 2: Database client and migration runner, oauth_clients (+1 more)

### Community 60 - "Phase 1 Quote Schema"
Cohesion: 0.27
Nodes (9): Task 2 — Phase 1 schema migrations 0007 + 0008, holidays, index_prices_eod, index_prices_eod_series_date_idx, navs, navs_instrument_date_idx, prices_eod, prices_eod_instrument_date_idx (+1 more)

### Community 61 - "Funded Status Arch Test"
Cohesion: 0.29
Nodes (9): ALLOWED, dependencies(), graph, reachers(), reachersOf(), rel(), REPO, sourceFiles() (+1 more)

### Community 62 - "No-Catch-Up Firewall"
Cohesion: 0.31
Nodes (9): funded_status unreadable by sizing/risk functions, renderIps: IPS text stored verbatim, never paraphrased, IPS 3.10 Behavioral protocol at -20% drawdown, IPS 3.2 Objective function, Catch-up behavior prohibited by construction, 48-hour cooling-off for IPS changes (Section 11), Equity ceiling ~60% of investable assets, Investment Policy Statement v1 (+1 more)

### Community 63 - "Recommendation Contracts"
Cohesion: 0.22
Nodes (9): FR-11 — primary + exactly 2 alternates, stored payload contract, FR-12 — ≤4 recs/month, 12-month min-hold, 3 override events, FR-55 paper mode — pipeline runs, execution structurally impossible, Task 10 — Recommendation objects, FR-11/FR-12 + paper mode, Task 12 — Scoring harness (§13) + calibration shell, Task 9 — Sell / exit triggers, monthly evaluation (FR-15), src/domain/recommendations.ts — FR-11 builders, FR-12 caps, suppressions, src/domain/scoring.ts — §13 benchmark-at-creation + eval snapshots (+1 more)

### Community 64 - "Guard-Rail Test Discipline"
Cohesion: 0.25
Nodes (9): A guard-rail test that hard-codes both sides tests nothing; mutation-check it, investment_code is polymorphic (ISIN / fund code / internal id / company name), Any consumer must use latest-per-source, never a fixed date, loadPositions — seed vs live reconciliation; live-live rows are never merged, resolveCanonicalId + broker-attributed accounts — production reconciliation fix, SEED_HOLDINGS — holdings total exact at ₹47.69L, C-A seed/sync double count (₹47.69L seed → ₹91.03L after one sync), A wide test band hides transcription slips (₹1L error through an 8% band) (+1 more)

### Community 65 - "Token Store & Dry Run"
Cohesion: 0.25
Nodes (8): DRY_RUN=1 compose-but-do-not-send mode, AES-256-GCM encrypted refresh-token store, Telegram owner-chat-ID guard, Provisioning Checklist, src/config/env.ts (loadEnv, Env), src/jobs/indmoney-login.ts (one-time loopback login), oauth_tokens / oauth_clients tables, Telegram notifier class

### Community 66 - "Phase 1 DoD & LLM Boundary"
Cohesion: 0.32
Nodes (8): Phase 1 Definition of Done (§14) — fully-formed rec + stale price provably blocks, 6.7 LLM boundary — narration never originates or re-ranks a number, Scope call 1 — weekly LLM channel is OpenRouter, not the Anthropic API, Task 11 — Weekly deep report job (FR-51) + narrative + schedule, Task 5 — Staleness extension + blocked-by-stale proof, src/jobs/report.ts — pnpm report weekly entrypoint, src/notify/report.ts — weekly deep report composition (FR-51), src/sources/llm-narration.ts — OpenRouter narrative step (PRD 6.7)

### Community 67 - "Web Layout & Nav"
Cohesion: 0.32
Nodes (5): react, metadata, GROUPS, Nav(), resolve()

### Community 68 - "CI Test & Typecheck Gate"
Cohesion: 0.29
Nodes (7): Green suite + clean tsc is the whole safety argument, pnpm test (vitest suite), CI test job, tsc --noEmit typecheck gate, CI Workflow, PGlite (WASM Postgres) test environment, TDD with verified-failing tests and mutation-checked guard rails

### Community 69 - "Sync/Digest Workflow Chain"
Cohesion: 0.33
Nodes (7): deploy-dashboard job (GitHub Pages), digest job, Upload dashboard.html as Pages artifact, Digest Workflow, workflow_run gating on successful sync, sync job, Sync Workflow

### Community 70 - "Weekly Report Workflow"
Cohesion: 0.33
Nodes (7): Live INDmoney path decrypts stored OAuth refresh token, weekly deploy-dashboard job, pnpm weekly entrypoint, weekly job (Saturday 08:00 IST), Weekly Report Workflow, Sync falls back to the INDmoney file snapshot, TOKEN_ENCRYPTION_KEY secret (one key everywhere)

### Community 71 - "MF Ranking & Score Split"
Cohesion: 0.29
Nodes (7): Held instruments never enter the satellite BUY set (§6.1), MF ranking — consistency 40 / expense 20 / tenure 15 / AUM 15 / style 10, Money-vs-scores separation — BIGINT currency, unitless [0,100] float scores, Quality gate — ROCE>15%, 4/5y positive FCF, D/E<1, zero red flags, Satellite composite — valuation 30 / trend 30 / earnings 20 / fit 20, Task 7 — Signal engine: satellite composite + MF ranking, src/domain/engine.ts — §6 satellite composite + MF ranking

### Community 72 - "Provisioning Secrets Policy"
Cohesion: 0.33
Nodes (6): pnpm sync entrypoint, No stored broker passwords or TOTP secrets, Nothing auto-loads .env (no dotenv dependency), INDmoney one-time OAuth login (pnpm indmoney:login), Kite Connect credentials (optional in Phase 0), pnpm script table (test, migrate, seed, sync, digest, ips, indmoney:login)

### Community 73 - "Money Primitives Task"
Cohesion: 0.47
Nodes (6): Money is branded bigint paise/cents, never float, Global Constraints (Phase 0), src/money/fx.ts (usdToInr, rateMicros), src/money/paise.ts (Paise/Cents branded bigints), Task 4: Money primitives, usdToInr

### Community 74 - "Workflow Schedule Test"
Cohesion: 0.40
Nodes (4): FRESHNESS_HOURS, cronOf(), dir, read()

### Community 75 - "Telegram Provisioning"
Cohesion: 0.60
Nodes (5): pnpm digest entrypoint, Telegram bot locked to owner chat ID, Telegram bot provisioning (BotFather, getUpdates chat id), TELEGRAM_BOT_TOKEN secret, TELEGRAM_OWNER_CHAT_ID secret

### Community 76 - "Project Overview & Layout"
Cohesion: 0.40
Nodes (5): Money is never a float (branded bigint paise/cents), Single user, no multi-tenancy or sharing, src/ module layout (config, db, money, seed, sources, domain, notify, jobs), Provisioning checklist, Sentinel (project overview)

### Community 77 - "Web Uploads Migration"
Cohesion: 0.50
Nodes (3): web_uploads, web_uploads_created_idx, web_uploads_truncate_only

### Community 78 - "Web Dev Dependencies"
Cohesion: 0.40
Nodes (5): devDependencies, @types/node, @types/react, @types/react-dom, typescript

### Community 79 - "Web NPM Scripts"
Cohesion: 0.40
Nodes (5): scripts, build, dev, start, typecheck

### Community 80 - "Weekly Cadence & FX Defect"
Cohesion: 0.50
Nodes (4): Scope call 6 — weekly cadence Sat 08:00 → Sunday 10:00 IST (§12.2), Task 13 — Workflows, env, provisioning verification, README, Open defect — FX BLOCKs every weekend (48h limit vs ECB weekday publication), Awaiting owner — Phase 1 plan review + sign-off (cadence, starter watchlist)

### Community 81 - "Tax Engine & Legacy Cleanup"
Cohesion: 0.50
Nodes (4): Build-time verification items §15.1, FR-14 legacy cleanup queue + multi-year LTCG harvest calendar, IPS §3.9 Legacy cleanup mandate (smallcase wind-down, micro-orphans, LTCG-aware), Tax engine (FIFO lots, STCG/LTCG, Schedule FA, ClearTax exports)

### Community 82 - "Session Protocols"
Cohesion: 0.67
Nodes (3): Fix-on-touch for deferred minors, Session end protocol (ledger + memory updates), Session start protocol (PENDING, MEMORY, index, progress)

### Community 83 - "Telegram Bot Commands"
Cohesion: 1.00
Nodes (3): TelegramBot — long-polling command bot (/sync /status /holdings /cost /confirm), src/notify/telegram.ts — owner-locked notifier, not MarkdownV2-safe, Telegram bot channel (owner chat ID locked)

## Ambiguous Edges - Review These
- `Digest Workflow` → `Scheduled job times in IST (sync 17:30, digest 08:45, keepalive Sun 09:30)`  [AMBIGUOUS]
  docs/SETUP.md · relation: references
- `Kolkata property is not an optimization target` → `B2 house fund: 100% capital-preservation once seeded`  [AMBIGUOUS]
  CLAUDE.md · relation: conceptually_related_to

## Knowledge Gaps
- **316 isolated node(s):** `schema_migrations`, `milestones`, `ips_versions`, `fx_rates`, `settings_rails` (+311 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 431 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **8 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Digest Workflow` and `Scheduled job times in IST (sync 17:30, digest 08:45, keepalive Sun 09:30)`?**
  _Edge tagged AMBIGUOUS (relation: references) - confidence is low._
- **What is the exact relationship between `Kolkata property is not an optimization target` and `B2 house fund: 100% capital-preservation once seeded`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `Db` connect `DB Client, Migrate, Seed` to `Telegram & Dashboard Output`, `INDmoney OAuth Login`, `Statement Import Web Flow`, `Env & Secrets Loading`, `Buckets & Planning Assumptions`, `RSU Vest Engine`, `IPS Clause Machinery`, `Loan Amortization & Cascade`, `Ingestion Defect History`, `FX & Fidelity RSU Ingest`, `NSE Bhavcopy Pipeline`, `Allocation Drift & Caps`, `Local Preview UI Render`, `Web Data Access Layer`, `Rails & Bucket Status`, `Staleness Engine`, `AMFI NAV Pipeline`, `Screener.in Importer`, `Net Worth & Asset Class`, `LLM Provider Config Fixes`, `Sync Job & Snapshots`?**
  _High betweenness centrality (0.068) - this node is a cross-community bridge._
- **Why does `vitest` connect `DB Client, Migrate, Seed` to `INDmoney Source Adapter`, `Telegram & Dashboard Output`, `INDmoney OAuth Login`, `Root Package Manifest`, `Env & Secrets Loading`, `Buckets & Planning Assumptions`, `RSU Vest Engine`, `Surplus & Fixed Outflows`, `IPS Clause Machinery`, `Loan Amortization & Cascade`, `Ingestion Defect History`, `FX & Fidelity RSU Ingest`, `NSE Bhavcopy Pipeline`, `Allocation Drift & Caps`, `Rails & Bucket Status`, `LLM Extraction Defects`, `Money Primitives & Live Price`, `Funded Status Arch Test`, `Workflow Schedule Test`?**
  _High betweenness centrality (0.059) - this node is a cross-community bridge._
- **Why does `paise` connect `Domain Type Contracts` to `INDmoney Source Adapter`, `Repo Docs & Web Pages`, `Telegram & Dashboard Output`, `DB Client, Migrate, Seed`, `Statement Import Web Flow`, `Buckets & Planning Assumptions`, `RSU Vest Engine`, `Surplus & Fixed Outflows`, `IPS Clause Machinery`, `Loan Amortization & Cascade`, `Ingestion Defect History`, `FX & Fidelity RSU Ingest`, `Allocation Drift & Caps`, `Local Preview UI Render`, `Web Data Access Layer`, `Rails & Bucket Status`, `LLM Extraction Defects`, `Net Worth & Asset Class`, `Money Primitives & Live Price`, `Sync Job & Snapshots`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `runMigrations()` (e.g. with `.query()` and `.withTransaction()`) actually correct?**
  _`runMigrations()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `schema_migrations`, `milestones`, `ips_versions` to the rest of the system?**
  _316 weakly-connected nodes found - possible documentation gaps or missing edges._