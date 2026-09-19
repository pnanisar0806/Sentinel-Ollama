# Graph Report - Sentinel-Ollama  (2026-09-20)

## Corpus Check
- 120 files · ~234,139 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1792 nodes · 4400 edges · 130 communities (100 shown, 21 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 92 edges (avg confidence: 0.84)
- Token cost: 489,094 input · 0 output

## Community Hubs (Navigation)
- Rails and Staleness Gate
- INDmoney Source Adapter
- Database Client and Migrations
- Owner Ingest and Import Routes
- Environment Config Loading
- Order Approval State Machine
- OAuth PKCE Login Flow
- RSU Vest Projection
- Buckets and Funded Status
- Recommendation Objects and Gating
- Sell and Exit Triggers
- Screener Screen Scraper
- Weekly Report Builder
- Satellite Signal Engine
- Web Approval and Cleanup Pages
- Daily Sync Job
- Phase 0 Core Schema
- NSE Bhavcopy Pipeline
- Legacy Cleanup Recommendations
- Phase 0 Source Adapter Design
- Order Intents Migration
- Telegram Bot Commands
- Investable Surplus Curve
- Dashboard and Telegram Formatting
- Phase 1 Intel Schema
- Telegram Bot Handlers
- Watchlist Seeding and Screener Import
- AMFI NAV Pipeline
- LLM Model Boundary
- Scoring Harness and Calibration
- Web TypeScript Config
- IPS Clauses and Maturities
- Approval API Routes
- Allocation and Audit Pages
- Phase 0 Plan Overview
- Analysis Web Pages
- Phase 1 Durable Findings
- Concentration and Freshness Policy
- Net Worth and Asset Classification
- Allocation Drift Engine
- Package Scripts
- Allocation Bands and Caps
- Signal Engine Weights
- Overview and RSU Pages
- Phase 2 Rails Ledger
- Phase 0 Seeding and Audit
- Rails and Behavioral Protocol
- Instrument and Lot Schema
- Data Contract Gotchas
- FI Corpus and Milestones
- RSU Sync and Incidents
- Shared Row Types
- Root TypeScript Config
- Paper Orders and Audit Immutability
- Loan Amortization Cascade
- Package Metadata
- Shared Runtime Dependencies
- CI Test Gate
- Workflow Schedule and Repo Map
- Session Protocol and Money Rules
- Phase 2 Task Ledger
- Provisioning and Deploy Ledger
- Loan Cascade and Surplus Plan
- Db Interface and OAuth Schema
- Known Rails Defects
- IPS Structure and Exclusions
- Next.js App Shell
- FX and Live Price Fetch
- No-Catch-Up Architecture Test
- Keepalive and Supabase Hosting
- Driver Divergences and Fix-on-Touch
- Deployment Topology
- Quotes and Holidays Schema
- Broker Integration Posture
- Advisor LLM Boundary
- Immutability and RLS Triggers
- LLM Image Extraction
- Holdings and IPS Pages
- Owner-Locked Telegram Channel
- Weekly Report Workflow
- Secrets and Provisioning Checklist
- Replay, Scorecard and Backup
- Tax Engine and LTCG Harvest
- Seed Data Constants
- Product Stage Page
- Owner-Verified Planning Figures
- Encrypted Backup Workflow
- Money Primitives
- Phase Plan Roadmap
- Quality Gate and Data Budget
- Web Dependencies
- Digest Workflow and Pages Deploy
- Funded Status Firewall
- Web Uploads Schema
- Benchmark Evals Schema
- Backup Restore Job
- Root Dev Dependencies
- Web Dev Dependencies
- Web Build Scripts
- Screener Name Aliases Schema
- Root Runtime Dependencies
- No-Catch-Up Test Rationale
- Drawdown Rail Schema
- Node and pnpm Toolchain
- Test Band and FX Gaps
- Plan Sketch Caveat
- Phase 1 Plan Header
- Migration Bootstrap
- Next.js Type Shim
- Audit Immutability Rule
- Funded Status Read Ban
- No-Float Money Rule
- Human Approval Rule
- No Trading Paths Rule
- Secrets Location Rule
- Null Cost Basis Rule
- Holidays Table
- Education Corpus Bucket
- Health Top-Up Milestone
- Mutual Fund Switch Signals
- Screener Uploads Table

## God Nodes (most connected - your core abstractions)
1. `Db` - 85 edges
2. `vitest` - 74 edges
3. `openDb()` - 66 edges
4. `runMigrations()` - 61 edges
5. `paise` - 53 edges
6. `db()` - 39 edges
7. `seed()` - 35 edges
8. `rupees()` - 34 edges
9. `loadPositions()` - 28 edges
10. `formatInr()` - 27 edges

## Surprising Connections (you probably didn't know these)
- `Fetch Coverage Semantics` --semantically_similar_to--> `Staleness Engine`  [INFERRED] [semantically similar]
  docs/superpowers/plans/2026-09-17-sentinel-phase-2.5.md → PRD_investment_agent.md
- `keepalive workflow (Supabase free-tier ping)` --conceptually_related_to--> `Weekly backup workflow`  [INFERRED]
  docs/SETUP.md → .github/workflows/backup.yml
- `Optional LLM_API_KEY degrades loudly` --semantically_similar_to--> `Blank-but-present DATABASE_URL throws`  [INFERRED] [semantically similar]
  .github/workflows/weekly.yml → docs/SETUP.md
- `Optional LLM_API_KEY degrades loudly` --semantically_similar_to--> `GSEC_YIELD_PCT (owner-supplied, never invented)`  [INFERRED] [semantically similar]
  .github/workflows/weekly.yml → README.md
- `Blank-but-present DATABASE_URL throws` --semantically_similar_to--> `What the engine will not invent`  [INFERRED] [semantically similar]
  docs/SETUP.md → README.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Inputs composing the daily Telegram digest** — docs_superpowers_plans_2026_08_12_sentinel_phase_0_net_worth_fn, docs_superpowers_plans_2026_08_12_sentinel_phase_0_allocation_drift_fn, docs_superpowers_plans_2026_08_12_sentinel_phase_0_concentration_fn, docs_superpowers_plans_2026_08_12_sentinel_phase_0_bucket_statuses, docs_superpowers_plans_2026_08_12_sentinel_phase_0_milestone_statuses, docs_superpowers_plans_2026_08_12_sentinel_phase_0_assess_staleness, docs_superpowers_plans_2026_08_12_sentinel_phase_0_project_vests, docs_superpowers_plans_2026_08_12_sentinel_phase_0_funded_status_fn, docs_superpowers_plans_2026_08_12_sentinel_phase_0_compose_digest [EXTRACTED 1.00]
- **Source adapters implementing the one Source contract** — docs_superpowers_plans_2026_08_12_sentinel_phase_0_source_interface, docs_superpowers_plans_2026_08_12_sentinel_phase_0_kite_source_class, docs_superpowers_plans_2026_08_12_sentinel_phase_0_file_indmoney_source, docs_superpowers_plans_2026_08_12_sentinel_phase_0_remote_indmoney_source, docs_superpowers_plans_2026_08_12_sentinel_phase_0_src_sources_fx [EXTRACTED 1.00]
- **Staleness detection flow (as_of/source to blocked instruments)** — docs_superpowers_plans_2026_08_12_sentinel_phase_0_as_of_and_source_on_every_row, docs_superpowers_plans_2026_08_12_sentinel_phase_0_freshness_policy, docs_superpowers_plans_2026_08_12_sentinel_phase_0_assess_staleness, docs_superpowers_plans_2026_08_12_sentinel_phase_0_raise_incidents, docs_superpowers_plans_2026_08_12_sentinel_phase_0_blocked_instruments, docs_superpowers_plans_2026_08_12_sentinel_phase_0_table_incidents [EXTRACTED 1.00]
- **FR-11 paper recommendation flow — candidates to weekly report** — src_domain_engine, src_domain_alloc_engine, src_domain_sell_triggers, src_domain_maturities, src_domain_recommendations, src_notify_report, src_domain_scoring [EXTRACTED 1.00]
- **Phase 1 free-source data pipeline gated by the staleness choke point** — src_sources_bhavcopy, src_sources_amfi, src_sources_screener, src_sources_staleness, src_domain_engine, migrations_0010_phase1_quotes [EXTRACTED 1.00]
- **PRD hard constraints (never violate, never soften)** — claude_no_trading_paths, claude_no_autonomous_execution, claude_single_user, claude_no_stored_broker_credentials, claude_secrets_outside_repo, claude_telegram_owner_lock, claude_audit_immutability, claude_kolkata_property_excluded, claude_funded_status_isolation [EXTRACTED 1.00]
- **Unattended scheduled job fleet (GitHub Actions cron)** — _github_workflows_sync_sync, docs_setup_digest_workflow, _github_workflows_weekly_weekly_report, _github_workflows_schedule_daily_schedule, _github_workflows_backup_weekly_backup, docs_setup_keepalive_workflow, _github_workflows_screener_reminder_screener_reminder [EXTRACTED 1.00]
- **FR-31 staleness blocking chain (source lapse to withheld recommendation)** — readme_fr_31_staleness, readme_blocked_instruments, readme_composite_score, readme_fr_11_recommendation, readme_pnpm_report [EXTRACTED 1.00]
- **Owner provisioning flow (local to production)** — docs_setup_telegram_bot, docs_setup_supabase_project, docs_setup_indmoney_oauth_login, docs_setup_github_actions_secrets, docs_setup_vercel_web_app, readme_one_percent_dod [EXTRACTED 1.00]
- **Pre-Draft Safety Stack** — prd_investment_agent_safety_rails, prd_investment_agent_staleness_engine, prd_investment_agent_concentration_caps, prd_investment_agent_no_catch_up_rule, prd_investment_agent_never_events, prd_investment_agent_kill_switch, prd_investment_agent_circuit_breaker [EXTRACTED 1.00]
- **Paper Approval Flow (Phase 2)** — docs_superpowers_plans_2026_09_16_sentinel_phase_2_task1_paper_orders, docs_superpowers_plans_2026_09_16_sentinel_phase_2_paper_simulator, docs_superpowers_plans_2026_09_16_sentinel_phase_2_immutable_history, docs_superpowers_plans_2026_09_16_sentinel_phase_2_expiry_policy, docs_superpowers_plans_2026_09_16_sentinel_phase_2_rails_module, prd_investment_agent_telegram_channel [EXTRACTED 1.00]
- **Advisor Evidence Chain (Phase 2.5)** — docs_superpowers_plans_2026_09_17_sentinel_phase_2_5_news_ingestion, docs_superpowers_plans_2026_09_17_sentinel_phase_2_5_sentiment_classification, docs_superpowers_plans_2026_09_17_sentinel_phase_2_5_deterministic_sizing, docs_superpowers_plans_2026_09_17_sentinel_phase_2_5_advise_task, docs_superpowers_plans_2026_09_17_sentinel_phase_2_5_advisor_proposals, docs_superpowers_plans_2026_09_17_sentinel_phase_2_5_point_in_time_replay [EXTRACTED 1.00]
- **funded_status Firewall Enforcement Across Sizing and Reporting Modules** — agents_funded_status_firewall, memory_sell_triggers, memory_recommendation_objects, memory_weekly_deep_report, memory_b3_emergency_fund_exclusion, memory_fi_corpus_band [EXTRACTED 1.00]
- **Screener Ingestion Pipeline (spec, parsers, fixtures, cohort promotion, open gate decision)** — memory_screener_column_spec_wrong, memory_screener_paste_parser, memory_screener_cohort_promotion, tests_fixtures_screener_roe_roce_page1_fixture, tests_fixtures_screener_roe_roce_page2_fixture, tests_fixtures_screener_roe_roce_page1_screen_table_markup, pending_screener_gate_inputs_decision [EXTRACTED 1.00]
- **The Rails Enforcement Gap (reported everywhere, enforced nowhere on the order path)** — memory_rails_engine_reports_not_gates, memory_tactical_budget_false_positive, memory_cash_ceiling_rail, pending_fr34_cooling_off_unimplemented, pending_seven_owner_rails_still_constants, _superpowers_sdd_2026_08_12_sentinel_phase_0_progress_phase_2_task_2_rails_freeze_breaker [EXTRACTED 1.00]

## Communities (130 total, 21 thin omitted)

### Community 0 - "Rails and Staleness Gate"
Cohesion: 0.05
Nodes (61): Phase 1 Definition of Done (§14) — fully-formed rec + stale price provably blocks, FR-31 — stale is blocked, visibly, Scope call 8 — a local read-only preview UI is added to Phase 1 (port 8081), Staleness engine is the choke point, not the adapters, Task 11 — Weekly deep report job (FR-51) + narrative + schedule, Task 11A — Local preview UI (pnpm ui, 127.0.0.1:8081), Task 5 — Staleness extension + blocked-by-stale proof, Position (+53 more)

### Community 1 - "INDmoney Source Adapter"
Cohesion: 0.06
Nodes (38): InstrumentSeed, aggregate(), ALNUM(), ASSET_TYPES, brokerAccountFor(), CURRENCY_BY_ASSET_TYPE, INDMONEY_TO_CANONICAL, instrumentIdFor() (+30 more)

### Community 2 - "Database Client and Migrations"
Cohesion: 0.15
Nodes (19): vitest, Db, openDb(), DEFAULT_DIR, runMigrations(), bucketStatuses(), persistSchedules(), buildDigestInput() (+11 more)

### Community 3 - "Owner Ingest and Import Routes"
Cohesion: 0.07
Nodes (40): react, persistVests(), insertOwnerCostLot(), dynamic, POST(), dynamic, POST(), dynamic (+32 more)

### Community 4 - "Environment Config Loading"
Cohesion: 0.09
Nodes (27): env, names, CryptoEnv, demanded(), Env, KEYS, loadEnv(), Purpose (+19 more)

### Community 5 - "Order Approval State Machine"
Cohesion: 0.09
Nodes (45): abandonAdvisory(), acknowledgeAdvisory(), ApproveInput, approveOrder(), awaitManualExecution(), computeMarketExpiry(), computeSipMfExpiry(), createOrder() (+37 more)

### Community 6 - "OAuth PKCE Login Flow"
Cohesion: 0.09
Nodes (34): RFC-7591, OAuth dynamic client registration + PKCE loopback flow, env, existing, key, SCOPES, state, url (+26 more)

### Community 7 - "RSU Vest Projection"
Cohesion: 0.13
Nodes (25): allocate(), CONFIRMED_SOURCE, confirmVest(), PROJECTED_SOURCE, projectVests(), NOTE: the returned refresher grants are hypothetical and have no `rsu_grants`…, toUnitsMicros(), trancheDates() (+17 more)

### Community 8 - "Buckets and Funded Status"
Cohesion: 0.13
Nodes (28): Bucket B2: House fund (Hyderabad, 2033-35), Bucket B3: Emergency fund (Rs 6L), Assumptions, DriftRow, Bucket, BucketId, BUCKETS, bucketStatus (+20 more)

### Community 9 - "Recommendation Objects and Gating"
Cohesion: 0.10
Nodes (30): FR-11 — primary + exactly 2 alternates, stored payload contract, FR-12 — ≤4 recs/month, 12-month min-hold, 3 override events, FR-55 paper mode — pipeline runs, execution structurally impossible, Task 10 — Recommendation objects, FR-11/FR-12 + paper mode, IPS_V1_TEXT, announceMaturity(), buildRecommendation(), doNothingLeg() (+22 more)

### Community 10 - "Sell and Exit Triggers"
Cohesion: 0.11
Nodes (27): Task 9 — Sell / exit triggers, monthly evaluation (FR-15), asIsoDate(), BETTER_ALTERNATIVE_MARGIN, BETTER_ALTERNATIVE_PER_QUARTER, BetterAlternative, candidate(), daysInMonth(), evaluateExits() (+19 more)

### Community 11 - "Screener Screen Scraper"
Cohesion: 0.11
Nodes (27): screenerImportPaste(), screenerImportScreen(), COLUMN_MAP, ensureScreenInstrument(), fetchScreen(), importScreenRows(), normalizeCompanyName(), normalizeHeader() (+19 more)

### Community 12 - "Weekly Report Builder"
Cohesion: 0.12
Nodes (28): FundingRoute, SatelliteScore, isPaperMode(), Calibration, EvalResult, parseAsOf(), parseGsecYield(), BlockedName (+20 more)

### Community 13 - "Satellite Signal Engine"
Cohesion: 0.12
Nodes (28): Held instruments never enter the satellite BUY set (§6.1), MF ranking — consistency 40 / expense 20 / tenure 15 / AUM 15 / style 10, Money-vs-scores separation — BIGINT currency, unitless [0,100] float scores, Quality gate — ROCE>15%, 4/5y positive FCF, D/E<1, zero red flags, Satellite composite — valuation 30 / trend 30 / earnings 20 / fit 20, Task 7 — Signal engine: satellite composite + MF ranking, bandOf(), CandidateFundamentals (+20 more)

### Community 14 - "Web Approval and Cleanup Pages"
Cohesion: 0.12
Nodes (23): ApprovalDetailPage(), dynamic, PageProps, ApprovalsPage(), dynamic, CleanupPage(), dynamic, brokerageRow() (+15 more)

### Community 15 - "Daily Sync Job"
Cohesion: 0.08
Nodes (21): Scope call 6 — weekly cadence Sat 08:00 → Sunday 10:00 IST (§12.2), Task 13 — Workflows, env, provisioning verification, README, FxFetcher, INDMONEY_SCOPES, NavFetcher, PriceFetcher, runSync(), isTradingDay() (+13 more)

### Community 16 - "Phase 0 Core Schema"
Cohesion: 0.11
Nodes (25): IST business dates as YYYY-MM-DD strings, audit_log, audit_log_append_only, audit_log_entity_idx, audit_log_truncate_only, bucket_flows, buckets, fx_rates (+17 more)

### Community 17 - "NSE Bhavcopy Pipeline"
Cohesion: 0.15
Nodes (24): Task 3 — NSE EOD price pipeline (EQ bhavcopy + index series), BhavcopyReport, BhavcopyRow, buildEquityUrl(), buildFullMarketUrl(), buildIndexUrl(), buildMasterUrl(), downloadBhavcopy() (+16 more)

### Community 18 - "Legacy Cleanup Recommendations"
Cohesion: 0.13
Nodes (24): buildBondCreditReviewRec(), buildFyHarvestPlan(), buildGrowwRPowerRec(), buildLtcgHarvestRec(), buildMicroOrphanRec(), buildSammaanMaturityRoutingRec(), buildSmallcaseTerminationRec(), buildThesisLessRec() (+16 more)

### Community 19 - "Phase 0 Source Adapter Design"
Cohesion: 0.12
Nodes (25): Absent code paths, not toggles (no orders, F&O, leverage), blockedInstruments, ensureAccessToken, FileIndmoneySource, Fixture honesty: capture real payloads before writing mappers, KiteSource, McpClient, MCP over Streamable HTTP (JSON or SSE) (+17 more)

### Community 20 - "Order Intents Migration"
Cohesion: 0.15
Nodes (24): order_intents, order_intents_append_only, order_intents_expires_idx, order_intents_recommendation_idx, order_intents_stable_tag_idx, order_intents_status_idx, order_intents_truncate_only, order_revisions (+16 more)

### Community 21 - "Telegram Bot Commands"
Cohesion: 0.13
Nodes (18): TelegramEnv, Command, COMMANDS, TelegramUpdate, LlmProposal, CostCommand, OwnerCostOutcome, parseCostCommand() (+10 more)

### Community 22 - "Investable Surplus Curve"
Cohesion: 0.13
Nodes (22): Bucket B4: Education corpus (Rs 1 Cr, activates ~2028), FIXED_OUTFLOWS (rent, mother, wife, maid, misc), Mother's support never terminates, AnnualSurplus, BASE_TAKE_HOME, BASE_TAKE_HOME_AS_OF, CHILD_DENT_NO_END_FLAG, childDentFor() (+14 more)

### Community 23 - "Dashboard and Telegram Formatting"
Cohesion: 0.13
Nodes (15): breachFlag(), driftClass(), formatInrCompact(), formatInrFull(), generateDashboardHtml(), pct(), escapeMarkdown(), split() (+7 more)

### Community 24 - "Phase 1 Intel Schema"
Cohesion: 0.15
Nodes (21): Advisor-owned watchlist — owner curates at setup, quarterly revision is a proposal, sentinel_append_only(), benchmarks, benchmarks_append_only, benchmarks_truncate_only, fundamentals_append_only, fundamentals_truncate_only, recommendations (+13 more)

### Community 26 - "Watchlist Seeding and Screener Import"
Cohesion: 0.13
Nodes (16): Task 6 — Starter watchlist + screener.in importer, ENV_PURPOSES, screenerImportCsv(), SEED_WATCHLIST, seedWatchlist(), importScreener(), parseBool(), parseNumber() (+8 more)

### Community 27 - "AMFI NAV Pipeline"
Cohesion: 0.14
Nodes (15): iciciRows, lines, Task 4 — AMFI NAV pipeline (daily + historical), matches, searchTerms, AmfiReport, downloadDailyNav(), downloadHistory() (+7 more)

### Community 28 - "LLM Model Boundary"
Cohesion: 0.16
Nodes (16): 6.7 LLM boundary — narration never originates or re-ranks a number, Scope call 1 — weekly LLM channel is OpenRouter, not the Anthropic API, OPENROUTER_CHAT_URL, TEXT_MODEL, VISION_MODEL_CHAIN, DEFAULT_LLM_MODEL, DEFAULT_NARRATION_MODEL, NARRATION_PROMPT (+8 more)

### Community 29 - "Scoring Harness and Calibration"
Cohesion: 0.18
Nodes (16): Task 12 — Scoring harness (§13) + calibration shell, addMonths(), BenchmarkSnapshot, CalibrationRow, closeOn(), DueEval, dueEvals(), EVAL_HORIZONS (+8 more)

### Community 30 - "Web TypeScript Config"
Cohesion: 0.10
Nodes (20): compilerOptions, allowJs, baseUrl, esModuleInterop, incremental, isolatedModules, jsx, lib (+12 more)

### Community 31 - "IPS Clauses and Maturities"
Cohesion: 0.17
Nodes (9): FR-10 — every recommendation cites ≥1 real IPS v1 clause id, Task 1 — Sammaan bond maturity: model, route, alert, currentIps(), getIpsClauseIndex(), ipsClause(), renderIps(), MaturityRouting, maturityRoutingRec() (+1 more)

### Community 32 - "Approval API Routes"
Cohesion: 0.13
Nodes (14): gold(), dynamic, POST(), dynamic, POST(), dynamic, POST(), dynamic (+6 more)

### Community 33 - "Allocation and Audit Pages"
Cohesion: 0.15
Nodes (16): AllocationPage(), dynamic, AuditPage(), dynamic, dynamic, fmtAge(), FreshnessPage(), dynamic (+8 more)

### Community 34 - "Phase 0 Plan Overview"
Cohesion: 0.17
Nodes (19): composeDigest (pure), Digest contract (FR-50), GitHub Actions workflows (sync, digest, keepalive), installIps, IPS clause citation machinery (FR-10 in Phase 1), ipsClause, Phase 0 Definition of Done, Sentinel Phase 0 Implementation Plan (+11 more)

### Community 35 - "Analysis Web Pages"
Cohesion: 0.20
Nodes (6): Col, Notice(), NotYetBuild(), PageHead(), PendingButton(), Tone

### Community 36 - "Phase 1 Durable Findings"
Cohesion: 0.14
Nodes (17): Phase 1 Complete (Tasks 1-13), Screener Screen HTML Scraper (post-Phase-1), Four Artifacts Written From Imagination and Presented as Spec, ISIN Backfill Is Fill-Only, Never Clobber, LLM Shortlists the Watchlist, Engine Owns Every Number, NSE Bhavcopy Archive-First With Whole-Market Fallback, NSE Trading Calendar and isTradingDay, One Model Family, Split by Capability (text vs vision) (+9 more)

### Community 37 - "Concentration and Freshness Policy"
Cohesion: 0.15
Nodes (17): allocationDrift, assessStaleness, bucketStatuses, buildDigestInput, Concentration caps (PRD 3.5): single stock, employer, issuer, concentration, Employer concentration cap 10% on NOW, Freshness policy (prices 24h, NAVs 48h, FX 48h, portfolio 36h, fundamentals 1 quarter) (+9 more)

### Community 38 - "Net Worth and Asset Classification"
Cohesion: 0.19
Nodes (14): Asset-class mapping (EQUITY/DEBT/GOLD/CASH), EPF counts as debt-like ballast, not equity, classify(), DEBT_INSTRUMENTS, HoldingRow, InstrumentKind, LiabilityRow, loadPositions() (+6 more)

### Community 39 - "Allocation Drift Engine"
Cohesion: 0.21
Nodes (12): Task 8 — Allocation engine: monthly drift + April rebalance, AllocationState, CandidateAction, capacityFor(), dilutionRoutes(), isRebalanceTarget(), pct(), RebalanceDirection (+4 more)

### Community 40 - "Package Scripts"
Cohesion: 0.12
Nodes (17): scripts, backfill:isin, digest, indmoney:login, ips, migrate, report, screener:import (+9 more)

### Community 41 - "Allocation Bands and Caps"
Cohesion: 0.25
Nodes (12): ALL_CLASSES, allocationDrift(), CAPS, concentration, IPS_BANDS, isDirectStock(), pct(), SECTOR_COVERAGE_CAVEAT (+4 more)

### Community 42 - "Signal Engine Weights"
Cohesion: 0.17
Nodes (14): BANDS, EngineContext, loadEngineInputs(), MF_WEIGHTS, MfCandidate, persistSignalScores(), rawNumber(), SATELLITE_WEIGHTS (+6 more)

### Community 43 - "Overview and RSU Pages"
Cohesion: 0.18
Nodes (12): BucketsPage(), dynamic, dynamic, OverviewPage(), dynamic, RsuPage(), getBuckets(), getOverview() (+4 more)

### Community 44 - "Phase 2 Rails Ledger"
Cohesion: 0.18
Nodes (14): Cash Ceiling Owner Amendment (out of band), Phase 2 Task 1 — Paper Approval State Machine, Phase 2 Task 2 — Rails, Freeze, Breaker, Phase 2 Task 4 — Web Approval/Cleanup/Rail Surfaces, funded_status Firewall (no catch-up behaviour), TDD With Mutation-Checked Guard Rails, B3 Emergency Fund Excluded From the Cash Ceiling, Cash Ceiling Owner Rail (10%) (+6 more)

### Community 45 - "Phase 0 Seeding and Audit"
Cohesion: 0.19
Nodes (14): Append-only audit (FR-07) via UPDATE/DELETE triggers, Every externally-sourced row carries as_of + source, Known thin spots the implementer must not paper over, NSE:SMALLCASE-RESIDUE placeholder position, src/seed/seed.ts (idempotent seeding job), src/seed/seed-data.ts (SEED_* constants), audit_log table, holdings table (+6 more)

### Community 46 - "Rails and Behavioral Protocol"
Cohesion: 0.16
Nodes (14): src/domain/rails.ts (planned), Task 2: Rails, Freeze, Breaker, Behavioral Protocol, Deterministic Actionable Sizing, Phase 2.5 Owner Inputs Gate, Allocation / Drift Engine, Bucket B3: Emergency Fund, Behavioral Pre-Commitment Protocol, Cash Ceiling (≤10% idle cash) (+6 more)

### Community 47 - "Instrument and Lot Schema"
Cohesion: 0.14
Nodes (12): instruments, lots, lots_fifo_idx, instruments_canonical_id_idx, lots_one_open_owner_per_position, fundamentals, fundamentals_instrument_idx, screener_uploads (+4 more)

### Community 48 - "Data Contract Gotchas"
Cohesion: 0.18
Nodes (13): No Trading Paths (absent code, not disabled features), Never silently absorb a data discrepancy, Never invent a number to close a gap, Never widen a test band to make a red test green, Fidelity RSU Ingestion Flow, Bond invested_amount Is Face Value, Not Cost, INDmoney MCP networth_holdings Contract, Kite Retired — INDmoney Is the Only Portfolio Source (+5 more)

### Community 49 - "FI Corpus and Milestones"
Cohesion: 0.17
Nodes (13): Bucket B1: FI corpus (10.3-17.1 Cr real at age 55), FI corpus band (SWR 3.5% floor / 4% optimistic), fundedStatus / fiCorpusBand, Milestone M1: Rs 2 Cr term life cover, Milestone M2: ~Rs 50L health super top-up, milestoneStatuses, FR-16 no-catch-up property: funded status unreadable by risk code, PRD 15.2 planning assumptions, single source of truth (+5 more)

### Community 50 - "RSU Sync and Incidents"
Cohesion: 0.19
Nodes (13): confirmVest, Net-of-withholding factor 0.70 on RSU vests, persistVests, projectVests, PROJECTED never overwrites owner-confirmed ACTUAL, Quarterly vests on the 15th of Feb/May/Aug/Nov over 4 years, raiseIncidents, RSU refresher scenario: $20,000/yr grants (+5 more)

### Community 51 - "Shared Row Types"
Cohesion: 0.23
Nodes (12): Redemption, ExitCandidate, DigestInput, StalenessRow, AuditRow, BucketsData, CleanupCalendarData, FreshnessData (+4 more)

### Community 52 - "Root TypeScript Config"
Cohesion: 0.15
Nodes (12): compilerOptions, exactOptionalPropertyTypes, module, moduleResolution, noUncheckedIndexedAccess, outDir, skipLibCheck, strict (+4 more)

### Community 53 - "Paper Orders and Audit Immutability"
Cohesion: 0.21
Nodes (12): Db Four-Method Interface, Immutable History vs Current State, src/domain/orders.ts (planned), Paper Execution Simulator, Task 1: Paper Orders + Approval State Machine, advisor_proposals (immutable), Approval State Machine, Audit Immutability (+4 more)

### Community 54 - "Loan Amortization Cascade"
Cohesion: 0.29
Nodes (10): amortize(), interestPaid(), LoanInput, LoanRow, monthlyInterest(), nextMonth(), runCascade(), ScheduleRow (+2 more)

### Community 55 - "Package Metadata"
Cohesion: 0.18
Nodes (10): author, description, keywords, license, name, packageManager, type, version (+2 more)

### Community 56 - "Shared Runtime Dependencies"
Cohesion: 0.18
Nodes (10): @electric-sql/pglite, postgres, @types/node, typescript, react-dom, @types/react, @types/react-dom, name (+2 more)

### Community 57 - "CI Test Gate"
Cohesion: 0.20
Nodes (10): Green suite + clean tsc is the whole safety argument, pnpm test (vitest suite), CI test job, tsc --noEmit typecheck gate, CI Workflow, Every externally-sourced row carries as_of and source, PGlite (WASM Postgres) test environment, TDD with verified-failing tests and mutation-checked guard rails (+2 more)

### Community 58 - "Workflow Schedule and Repo Map"
Cohesion: 0.24
Nodes (10): Daily-not-weekday sync cron, after NSE publication, packageManager as the single pnpm version source, sync workflow, digest workflow (daily digest delivery), index.md repo map, Workflow schedule table, FR-31 staleness gate, Phase 1 provisioning items unverified against live sources (+2 more)

### Community 59 - "Session Protocol and Money Rules"
Cohesion: 0.29
Nodes (10): Sentinel SDD Progress Ledger, Phase 0 Complete (PR #1 merged), Money Is Never a Float, Sentinel Agent Operating Instructions, Session End Protocol, Session Start Protocol, Single-User, No Multi-Tenancy, Sentinel Durable Project Memory (+2 more)

### Community 60 - "Phase 2 Task Ledger"
Cohesion: 0.22
Nodes (10): Phase 2 Task 3 — Legacy Cleanup + Multi-Year LTCG Calendar, Phase 2 Task 5 — Scheduling, Scoring and Backup/Restore Proof, No Autonomous Execution, Kolkata property is not an optimization target, Allocation Engine (one net-worth basis, tax preference), FR-11/FR-12 Recommendation Objects + Paper Mode, Sell / Exit Triggers (section 6.5) and the Falsification Grammar, Signal Engine (section 6 quality gate + composite) (+2 more)

### Community 61 - "Provisioning and Deploy Ledger"
Cohesion: 0.20
Nodes (10): Phase 2 Task 6 — Provisioning, Handoff and Phase 2 Acceptance, Web App Build Fix (out of band), Audit Immutability (append-only + RLS), .env Values Must Be Unquoted, Scoring Harness (section 13 calibration), TOKEN_ENCRYPTION_KEY Rotation, Next.js web/ Bundling Contract, Weekly Deep Report + Narration (FR-51) (+2 more)

### Community 62 - "Loan Cascade and Surplus Plan"
Cohesion: 0.29
Nodes (10): amortize, Take-home steps up 10% each April (fiscal-year start), Child dent of Rs 10,000/month from Jan 2028, Total loan outflow stays flat at ~Rs 55,526/month, Prepayment cascade: freed EMIs roll into the next loan, projectAnnualSurplus, projectSurplus, runCascade (+2 more)

### Community 63 - "Db Interface and OAuth Schema"
Cohesion: 0.24
Nodes (9): Db interface (query/close), PGlite locally, Supabase in prod, identical SQL, Scope Call: Supabase not provisioned yet, src/db/client.ts (Db, openDb), src/db/migrate.ts (runMigrations), src/jobs/keepalive.ts (weekly Supabase keep-alive), Task 2: Database client and migration runner, oauth_clients (+1 more)

### Community 64 - "Known Rails Defects"
Cohesion: 0.24
Nodes (10): Rails hard-coded despite PRD 11 saying they live in settings_rails, Known defect: TACTICAL_BUDGET_EXCEEDED fires permanently, blockedInstruments (valuation-input blocking), Composite score (valuation 30 / trend 30 / earnings 20 / fit 20), FR-11 recommendation object (primary + exactly two alternates), FR-12 action caps, IPS v1 verbatim text, IPS 3.7 twelve-month minimum hold and its overrides (+2 more)

### Community 65 - "IPS Structure and Exclusions"
Cohesion: 0.20
Nodes (10): Bucket B2: House Fund, Hard Concentration Caps, Core-Satellite 75/25 Equity Structure, Satellite Demotion Rule, Investment Policy Statement (IPS), Kolkata Flat Exclusion, Milestone M1: Term Life Cover, ServiceNow RSU Pipeline (+2 more)

### Community 66 - "Next.js App Shell"
Cohesion: 0.24
Nodes (6): next, metadata, GROUPS, Nav(), resolve(), config

### Community 67 - "FX and Live Price Fetch"
Cohesion: 0.31
Nodes (6): dollars(), fetchUsdInr(), fetchLiveRsuInputs(), fetchNowPrice(), LivePrice, LiveRsuInputs

### Community 68 - "No-Catch-Up Architecture Test"
Cohesion: 0.27
Nodes (8): ALLOWED, dependencies(), graph, reachers(), reachersOf(), rel(), REPO, SRC

### Community 69 - "Keepalive and Supabase Hosting"
Cohesion: 0.25
Nodes (9): src/jobs/keepalive.ts invocation, keepalive job (weekly Sunday cron), Keepalive Workflow, Daily schedule workflow, DATABASE_URL (Supabase service-role pooler string), keepalive workflow (Supabase free-tier ping), pnpm schedule (order expiry and reminders), RLS-everywhere with owner-role bypass (+1 more)

### Community 70 - "Driver Divergences and Fix-on-Touch"
Cohesion: 0.22
Nodes (9): Subagent-Driven Execution Model, Fix-on-touch for deferred minors, Session end protocol (ledger + memory updates), Session start protocol (PENDING, MEMORY, index, progress), Db Interface Contract (query/exec/withTransaction/close), Deferred Minors Ledger, src/config/ips-v1.ts as a Template Literal, Never Feed JSON.stringify to a ::jsonb Placeholder (+1 more)

### Community 71 - "Deployment Topology"
Cohesion: 0.22
Nodes (9): Single user, no multi-tenancy or sharing, GitHub Actions secrets as the only secret store, Headless four-piece deployment topology, Vercel-hosted read-only web app, No trading paths / no autonomous execution, Plus-or-minus 1% reconciliation DoD, Phase 0 — data layer and daily digest, Phase 1 ("Think") — recommendation engine (+1 more)

### Community 72 - "Quotes and Holidays Schema"
Cohesion: 0.31
Nodes (8): Task 2 — Phase 1 schema migrations 0007 + 0008, holidays, index_prices_eod, index_prices_eod_series_date_idx, navs, navs_instrument_date_idx, prices_eod, prices_eod_instrument_date_idx

### Community 73 - "Broker Integration Posture"
Cohesion: 0.22
Nodes (9): Approval Expiry Policy (EOD / 7 days), Task 4: Web Approval/Cleanup/Rail Surfaces, Task 10: Web /advisor Surface, Telegram Approval Workflow, Kite Deep-Link Bridge, Human-in-Loop Session Unlock, Sole-User / SEBI RIA Boundary, Telegram Bot Channel (+1 more)

### Community 74 - "Advisor LLM Boundary"
Cohesion: 0.28
Nodes (9): Task 6: LLM ADVISE + Gated Paper Handoff, Task 8: Bounded Commentary, Fetch Coverage Semantics, LLM Selects, Code Sizes and Gates, News Ingestion (news_events / news_fetch_runs), Versioned Sentiment Classification, System No-Action vs LLM HOLD/WAIT, Alternate Generation (primary + 2) (+1 more)

### Community 75 - "Immutability and RLS Triggers"
Cohesion: 0.25
Nodes (8): bucket_flows_append_only, bucket_flows_truncate_only, ips_versions_append_only, ips_versions_truncate_only, lots_immutable_delete, lots_immutable_update, lots_truncate_only, sentinel_lots_immutable()

### Community 76 - "LLM Image Extraction"
Cohesion: 0.31
Nodes (6): extractRsuVestsFromImage(), extractHoldingsFromImage(), extractJsonFromImage(), LLM_MODEL_CHAIN, SYSTEM_RULES, POSITIONS

### Community 77 - "Holdings and IPS Pages"
Cohesion: 0.28
Nodes (7): dynamic, HoldingsPage(), dynamic, IpsPage(), getHoldings(), getIps(), Badge()

### Community 78 - "Owner-Locked Telegram Channel"
Cohesion: 0.32
Nodes (8): pnpm digest entrypoint, screener-reminder workflow, Telegram bot locked to owner chat ID, .env is not auto-loaded (no dotenv dependency), Owner-locked Telegram bot, TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID, pnpm screener:remind

### Community 79 - "Weekly Report Workflow"
Cohesion: 0.29
Nodes (8): deploy-dashboard job (GitHub Pages), Optional LLM_API_KEY degrades loudly, weekly-report workflow, Blank-but-present DATABASE_URL throws, Branded bigint paise/cents (no floats), GSEC_YIELD_PCT (owner-supplied, never invented), pnpm report (weekly deep report FR-51), What the engine will not invent

### Community 80 - "Secrets and Provisioning Checklist"
Cohesion: 0.25
Nodes (8): DRY_RUN=1 compose-but-do-not-send mode, AES-256-GCM encrypted refresh-token store, Telegram owner-chat-ID guard, Provisioning Checklist, src/config/env.ts (loadEnv, Env), src/jobs/indmoney-login.ts (one-time loopback login), oauth_tokens / oauth_clients tables, Telegram notifier class

### Community 81 - "Replay, Scorecard and Backup"
Cohesion: 0.29
Nodes (8): Encrypted pg_dump Backup + Tested Restore, Task 5: Paper Scheduling, Scoring, Backup/Restore, Task 7: Calibration by Conviction and Horizon, Point-in-Time Deterministic Replay, Retrospective Experiment Caveat, Conviction Calibration, Falsification Circuit Breaker, Recommendation Scorecard

### Community 82 - "Tax Engine and LTCG Harvest"
Cohesion: 0.36
Nodes (8): Task 3: Paper Cleanup + Multi-Year LTCG Calendar, Fidelity RSU Modelled Integration, FIFO Lot Tracking, Legacy Cleanup Mandate, LTCG Harvest Planner, Schedule FA / ClearTax Exports, Sell / Exit Triggers, Tax Engine

### Community 83 - "Seed Data Constants"
Cohesion: 0.46
Nodes (6): SEED_BUCKETS, SEED_HOLDINGS, SEED_INSTRUMENTS, SEED_LOANS, SEED_MILESTONES, SEED_RSU_GRANTS

### Community 84 - "Product Stage Page"
Cohesion: 0.36
Nodes (6): ProductPage(), stageTone(), Area, AREAS, Stage, STAGE_LABEL

### Community 85 - "Owner-Verified Planning Figures"
Cohesion: 0.29
Nodes (7): The Plan's Reference Code Is a Sketch, Not Truth, Loan Cascade — Owner-Verified Figures and Closures, Planning Assumptions (PRD 15.2), Investable Surplus Curve, Bucket B1: FI Corpus, Credit Rule (beat 7.95% loan rate), Loan Prepayment Cascade

### Community 86 - "Encrypted Backup Workflow"
Cohesion: 0.40
Nodes (6): Weekly backup workflow, No stored broker passwords or TOTP secrets, BACKUP_REPO / BACKUP_BRANCH / GH_TOKEN, One-time interactive INDmoney OAuth login, pnpm backup (encrypted pg_dump), TOKEN_ENCRYPTION_KEY

### Community 87 - "Money Primitives"
Cohesion: 0.47
Nodes (6): Money is branded bigint paise/cents, never float, Global Constraints (Phase 0), src/money/fx.ts (usdToInr, rateMicros), src/money/paise.ts (Paise/Cents branded bigints), Task 4: Money primitives, usdToInr

### Community 88 - "Phase Plan Roadmap"
Cohesion: 0.40
Nodes (6): Sentinel Phase 2 Implementation Plan, Task 6: Provisioning, Handoff, Phase 2 Acceptance, Sentinel Phase 2.5 ("Advise") Implementation Plan, INDmoney Advisory-Only Path, PRD Phase 2 — Prove, PRD Phase 3 — Act

### Community 89 - "Quality Gate and Data Budget"
Cohesion: 0.47
Nodes (6): Known Data Coverage Gaps, Task 9: Owner-Signed Quarterly Watchlist Revision, Binary Quality Gate, Quarterly screener.in CSV Upload, Satellite Stock Signal Stack, Zero-Cost Data Budget

### Community 90 - "Web Dependencies"
Cohesion: 0.33
Nodes (6): dependencies, @electric-sql/pglite, next, postgres, react, react-dom

### Community 91 - "Digest Workflow and Pages Deploy"
Cohesion: 0.50
Nodes (5): deploy-dashboard job (GitHub Pages), digest job, Upload dashboard.html as Pages artifact, Digest Workflow, workflow_run gating on successful sync

### Community 92 - "Funded Status Firewall"
Cohesion: 0.50
Nodes (5): funded_status Architecture Test, src/advisor/ Layer, Advisor Capability Firewall, Funded Status vs FI Band, No-Catch-Up Rule

### Community 93 - "Web Uploads Schema"
Cohesion: 0.50
Nodes (3): web_uploads, web_uploads_created_idx, web_uploads_truncate_only

### Community 94 - "Benchmark Evals Schema"
Cohesion: 0.50
Nodes (4): benchmarks_immutable, benchmarks_no_delete, sentinel_benchmarks_immutable(), sentinel_append_only

### Community 96 - "Root Dev Dependencies"
Cohesion: 0.40
Nodes (5): devDependencies, tsx, @types/node, typescript, vitest

### Community 97 - "Web Dev Dependencies"
Cohesion: 0.40
Nodes (5): devDependencies, @types/node, @types/react, @types/react-dom, typescript

### Community 98 - "Web Build Scripts"
Cohesion: 0.40
Nodes (5): scripts, build, dev, start, typecheck

### Community 99 - "Screener Name Aliases Schema"
Cohesion: 0.67
Nodes (3): screener_name_aliases, screener_name_aliases_instrument_idx, instruments

### Community 100 - "Root Runtime Dependencies"
Cohesion: 0.50
Nodes (4): dependencies, dotenv, @electric-sql/pglite, postgres

### Community 101 - "No-Catch-Up Test Rationale"
Cohesion: 0.67
Nodes (3): no-catch-up architecture test, Derive the actual side of an assertion from real data, funded_status unreadable by sizing or risk

## Ambiguous Edges - Review These
- `IPS v1 verbatim text` → `Rails hard-coded despite PRD 11 saying they live in settings_rails`  [AMBIGUOUS]
  index.md · relation: conceptually_related_to
- `Alternate Generation (primary + 2)` → `Task 8: Bounded Commentary`  [AMBIGUOUS]
  docs/superpowers/plans/2026-09-17-sentinel-phase-2.5.md · relation: conceptually_related_to
- `Zerodha Kite Connect Integration` → `Approval Expiry Policy (EOD / 7 days)`  [AMBIGUOUS]
  docs/superpowers/plans/2026-09-16-sentinel-phase-2.md · relation: conceptually_related_to

## Knowledge Gaps
- **385 isolated node(s):** `RemoteHolding`, `RpcResponse`, `ToolResult`, `FixtureHolding`, `Col` (+380 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 543 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **21 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `IPS v1 verbatim text` and `Rails hard-coded despite PRD 11 saying they live in settings_rails`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Alternate Generation (primary + 2)` and `Task 8: Bounded Commentary`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Zerodha Kite Connect Integration` and `Approval Expiry Policy (EOD / 7 days)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `Task 3: Paper Cleanup + Multi-Year LTCG Calendar` connect `Tax Engine and LTCG Harvest` to `Legacy Cleanup Recommendations`?**
  _High betweenness centrality (0.162) - this node is a cross-community bridge._
- **Why does `Db` connect `Database Client and Migrations` to `Rails and Staleness Gate`, `Owner Ingest and Import Routes`, `Environment Config Loading`, `Order Approval State Machine`, `OAuth PKCE Login Flow`, `RSU Vest Projection`, `Buckets and Funded Status`, `Recommendation Objects and Gating`, `Sell and Exit Triggers`, `Screener Screen Scraper`, `Weekly Report Builder`, `Satellite Signal Engine`, `Daily Sync Job`, `NSE Bhavcopy Pipeline`, `Legacy Cleanup Recommendations`, `Telegram Bot Commands`, `Watchlist Seeding and Screener Import`, `AMFI NAV Pipeline`, `LLM Model Boundary`, `Scoring Harness and Calibration`, `IPS Clauses and Maturities`, `Net Worth and Asset Classification`, `Allocation Drift Engine`, `Allocation Bands and Caps`, `Signal Engine Weights`, `Shared Row Types`, `Loan Amortization Cascade`?**
  _High betweenness centrality (0.115) - this node is a cross-community bridge._
- **Why does `vitest` connect `Database Client and Migrations` to `Rails and Staleness Gate`, `INDmoney Source Adapter`, `Environment Config Loading`, `Order Approval State Machine`, `OAuth PKCE Login Flow`, `RSU Vest Projection`, `Buckets and Funded Status`, `Recommendation Objects and Gating`, `Sell and Exit Triggers`, `Screener Screen Scraper`, `Weekly Report Builder`, `Daily Sync Job`, `Telegram Bot Commands`, `Investable Surplus Curve`, `Dashboard and Telegram Formatting`, `Watchlist Seeding and Screener Import`, `LLM Model Boundary`, `Scoring Harness and Calibration`, `IPS Clauses and Maturities`, `Net Worth and Asset Classification`, `Allocation Drift Engine`, `Allocation Bands and Caps`, `Signal Engine Weights`, `Loan Amortization Cascade`, `Package Metadata`, `FX and Live Price Fetch`, `No-Catch-Up Architecture Test`, `LLM Image Extraction`, `Seed Data Constants`?**
  _High betweenness centrality (0.089) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `runMigrations()` (e.g. with `.query()` and `.withTransaction()`) actually correct?**
  _`runMigrations()` has 2 INFERRED edges - model-reasoned connections that need verification._