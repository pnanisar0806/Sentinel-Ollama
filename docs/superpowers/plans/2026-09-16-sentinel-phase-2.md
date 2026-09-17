# Sentinel Phase 2 ("Prove") Implementation Plan

**Status:** Draft corrected against PRD §§3.9–3.10, 5.3–5.4, 7, 11–14 on 2026-09-17.
Implementation begins with Task 1; this document does not claim paper-operation acceptance.

**Goal:** Full paper approval workflow, deterministic rails, complete audit history, scorecard,
paper legacy cleanup calendar, and tested backup/restore. PRD Phase 3 is "Act"; Phase 2 is
"Prove". No broker placement, execution bridge, real fills, or live advisory verification loop
is introduced here. INDmoney remains the sole live portfolio source; do not resurrect Kite
OAuth, credentials, holdings sync, or an enable-execution flag as Phase 2 preparation.

**Implementation discipline:** Use the project's implementer → reviewer → fix-loop workflow.
Acceptance criteria and real interfaces are the contract; reference snippets are unverified
sketches. Write failing tests, verify failure, implement, verify, mutation-check guard rails.
Inspect existing migrations before assigning the next unused filename; numbers below are not
reserved. Do not rewrite deployed migrations. Commit/push only when separately authorized.

## Existing contracts and scope

- Reuse `web/app/`, `web/lib/`, `web/app/globals.css`, `web/app/nav.tsx`, and the current
  standalone Next.js app. It already has owner-confirmed statement imports. No `web/src/app`
  relocation, replacement app, mandatory Tailwind/shadcn migration, or unrelated chart rebuild.
  Extend existing layout primitives; keyboard controls, focus, readable contrast, and textual
  status labels remain acceptance requirements. The earlier OLED/green/font proposal was a
  design suggestion, not a PRD requirement or confirmed replacement for the owner's design.
- Telegram is the primary approval channel; web is authenticated deep inspection plus the same
  platform actions (PRD §12.1). Preserve brokerage/Fidelity `/confirm`, `/reject`, `/cost`,
  photo type selection and queues. Use namespaced order callbacks/commands, never repurpose
  statement confirmation. Ignore every non-owner chat ID.
- Money is branded bigint paise/cents; units use the existing integer-micros convention where
  needed. Every external datum carries `as_of` and `source`; unknown cost/date stays unknown.
- `funded_status` must not reach drafting, sizing, rails, risk, or recommendation logic,
  including through reporting helpers or payload injection. Preserve the real architecture test.
- `Db` is the shipped four-method interface, not the obsolete two-method plan sketch:

```ts
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

`withTransaction` pins one connection and does not nest. Pass objects to `::jsonb` parameters,
not `JSON.stringify` (postgres-js otherwise stores opaque JSON strings). Normalize DB dates.

## PRD rules — do not substitute draft defaults

| Requirement | Implementation contract |
|---|---|
| FR-20/21 | Telegram Approve / Modify / Defer / Reject / Show alternates; modify quantity, limit price, market/limit type, defer-until date, or choose an alternate instrument. Show full FR-11 primary + exactly two alternates. |
| FR-22 | Market approvals expire at end of trading day; SIP/MF-change approvals after 7 days. Notify and append EXPIRED. No universal 72-hour expiry. PRD does not specify limit-order approval lifetime; keep it an explicit owner decision before enabling that pending path. |
| FR-23/24 | Stable UUID idempotency tag and paper simulations of session wait, retry, partial fill, rejection and market closure. Exactly one logical paper effect on replay. Actual broker idempotency and placement proof belong to Phase 3. |
| FR-25 | Model advisory ACKNOWLEDGED → AWAITING_MANUAL_EXECUTION → VERIFIED/ABANDONED, with simulated next-sync verification and T+2/T+7 nags. Phase 2 labels instructions and outcomes PAPER; live owner-execution/verification starts in Phase 3. |
| FR-30/31 | All hard rails and affected-input freshness pass **before** a DRAFT may be persisted; revalidate modifications and approval against current facts. Refusals are auditable and visible, not invalid draft rows. |
| FR-32 | `/freeze` immediately cancels pending/awaiting requests and halts drafting; notifications continue. `/unfreeze` requires typed confirmation; it does not revive old approvals. |
| FR-33, §11.5 | Three consecutive approved recommendations hitting their falsification conditions → report-only. Reset is explicit `/reset_breaker` with agent-generated mandatory post-mortem note. This is not a drawdown breaker. |
| FR-34 | Rail edits become effective after 48 hours; rail-loosening edits are refused during drawdown **>15%**. Recheck at activation, not only proposal time. |
| FR-35, §3.10 | At drawdown **≥20%**, surface IPS and owner's 2022 history; require typed justification for SIP pause/panic-sell processing; log for recovery report. SIPs continue subject to §3.7 stop-events. This is not automatic portfolio freeze. |
| FR-12, §11 | ≤4 **recommended actions** per month, not four approvals; ₹1L single-order ceiling; ₹50k monthly tactical deployment excluding existing/recurring SIPs, with confirmed-vest-month redeployment allowance. Concentration/universe/no-catch-up rules also apply. |

FR-12 recommendation/hold discipline must be reconciled with the existing implementation:
§3.7 permits minimum-hold overrides only for thesis falsification, red flag, hard-cap breach.
Do not treat existing repeat-BUY suppression or an arbitrary owner directive as a complete
implementation of the PRD holding-period gate. Unknown holding periods are not assumed clear.

## Persistence: immutable history versus current state

FR-07 requires approvals and orders to be append-only audit records. Use immutable order
intent/revision records plus append-only approval/transition events with timestamp, actor,
payload snapshot, expected prior revision, and stable UUID tag. Derive current status through
a reader/view. Do not place blanket append-only triggers on a row then UPDATE its status.
Modifications append a new revision and invalidate the prior approval; no historical payload
is replaced. DELETE/TRUNCATE/UPDATE are refused on immutable tables; enable RLS consistently
with the single-user service-side access model.

Concurrent/repeated callbacks must conditionally append at most one transition for the same
revision, backed by database uniqueness/serialization, with its audit row in one transaction.
`settings_rails` is operational state, not immutable history: any effective-state mutation is
paired atomically with append-only proposal/activation audit evidence. Preserve existing rails
and the existing `audit_log`; do not add a redundant mutable "approval_audit" mirror.

## Tasks (ordered by dependency)

### Task 1: Paper orders + full approval state machine (FR-20–25, §7)

**Files:** new next-numbered approval/order migration; `src/domain/orders.ts`;
`tests/domain/orders.test.ts`; extend `src/notify/telegram-bot.ts` with corresponding bot tests.
Web adapters are Task 4; scheduled processing is Task 5.

**State contract from PRD §7.1:**

```text
DRAFT → PENDING_APPROVAL → {APPROVED | MODIFIED→APPROVED | DEFERRED | REJECTED | EXPIRED}
APPROVED → AWAITING_SESSION → EXECUTING → {FILLED | PARTIALLY_FILLED | BROKER_REJECTED | CANCELLED}
FILLED/PARTIALLY_FILLED → VERIFIED
Advisory: PENDING_APPROVAL → ACKNOWLEDGED → AWAITING_MANUAL_EXECUTION → VERIFIED | ABANDONED
```

Execution-side states are **paper simulator events only**. No broker dependency or real
holdings/lots/cash writes. The simulator cannot be selected as a live execution adapter.

**Acceptance (PRD-derived; implementation checklist):**
- [ ] A paper request carries immutable full FR-11 primary + exactly two alternates and all
  data timestamps. The five Telegram buttons reach real owner-locked handlers.
- [ ] Modify supports all five FR-21 fields; alternate substitution names an offered alternate;
  changes append a revision, revalidate rails/freshness, and require fresh approval. A refused
  change names the rail and leaves the previous immutable record intact.
- [ ] Defer records the chosen date, refreshes inputs when resurfacing, and reports a score
  falling below threshold with recommended withdrawal. No stale prior approval carries over.
- [ ] Market expiry uses the NSE session calendar/EOD; SIP/MF-change expiry is 7 days.
  Expiry and notification are idempotent. Cover holidays, session boundaries, and callbacks
  racing expiry. Resolve limit-order lifetime explicitly before enabling it; never assume 72h.
- [ ] Replaying/concurrently submitting an approval gives one logical paper transition/effect;
  stale revisions and terminal-state callbacks cannot reapprove. Stable UUID tag retained.
- [ ] Paper simulations cover session missing at expiry, partial fill next-step choices,
  verbatim broker rejection + interpretation/options (never auto-retry), and market closure
  (AMO only with explicit per-order opt-in). No simulation places a broker order.
- [ ] Advisory paper acknowledgement, simulated reconciliation, and T+2/T+7 reminders are
  represented honestly; a confirmation is not proof of a real fill or verified completion.
- [ ] Every transition appends timestamp/actor/payload snapshot and audit evidence atomically;
  SQL tests reject rewriting/deleting/truncating history. RLS is enabled.
- [ ] FR-30/31 is a mandatory drafting gate dependency; missing checks fail closed. Task 1
  uses controlled fixtures for this seam; Task 2 must wire and prove the real rails before
  the end-to-end pipeline is accepted. A flag alone is not a safety test.
- [ ] Regression tests preserve brokerage and Fidelity `/confirm`/`/reject` behavior and
  non-owner rejection. Existing no-execution and no-catch-up checks still hold.

### Task 2: Rails, freeze, breaker and behavioral protocol

**Files:** `src/domain/rails.ts`, next-numbered rail migration only where needed; order gate,
Telegram, digest/report wiring; domain/bot/architecture tests.

- [ ] Enforce §11's ₹1L order, ₹50k tactical monthly, confirmed-vest allowance, concentration,
  forbidden-universe, freshness and no-catch-up rules pre-draft and on revised approval.
  Derive values from policy/data; money never float. Recurring SIPs are excluded only from
  the tactical budget, not from unrelated applicable rails.
- [ ] Preserve FR-12 recommendation counting/suppression with visible reasons. A fifth approval
  is not the definition of a fifth recommended action. Enforce §3.7 hold/override semantics.
- [ ] `/freeze` cancels all pending/awaiting paper states atomically with audit and blocks new
  drafting; `/unfreeze` typed confirmation restores drafting only. Notifications still flow.
- [ ] Count distinct approved recommendations' falsification outcomes, not duplicate events or
  individual legs. Three consecutive hits demote to report-only. Test intervening non-hits,
  unknown/unresolved outcomes (not successes), event replay, and explicit reset/post-mortem.
  Document ordering/evaluation semantics so future or duplicate observations cannot fabricate a streak.
- [ ] Rail changes cool for 48h; test just-before/exact-boundary and loosening at >15% drawdown
  both at proposal and activation. Missing peak/drawdown evidence cannot approve a loosening.
- [ ] At ≥20% drawdown require §3.10 IPS/history + typed justification for relevant requests,
  with recovery-report audit trail; justification does not bypass other hard rails.
- [ ] Simulated rail violation creates no draft; simulated breaker trip blocks drafting while
  scorecard/reporting continue. Mutation-check both through the real pipeline.

### Task 3: Paper legacy cleanup + multi-year LTCG calendar (FR-14, §3.9)

**Files:** `src/domain/cleanup.ts`, `src/jobs/cleanup.ts`, tests; schema only if existing
recommendation/event records cannot express the standing queue.

- [ ] Generate PAPER FR-11 recommendations: terminate all four smallcase subscriptions while
  retaining constituent ETFs, thesis-less consolidation, micro-orphans <₹5k first, bond credit
  review, and existing Sammaan Sep-2026 maturity → B3 routing surfaced for event confirmation.
- [ ] Groww Reliance Power surfaces once as **close manually**, not SKIPPED solely because
  integration is absent. Do not duplicate a closure already evidenced by owner records.
- [ ] Schedule eligible equity LTCG harvesting across 1–2 fiscal years (Apr–Mar), using the
  PRD's ₹1.25L exemption parameter pending §15.1 build-time law verification. It is not a
  customizable tax allowance or an exemption for every asset class.
- [ ] Use known FIFO acquisition dates, units and costs only. Existing aggregate owner-cost
  lots (quantity may be 1) are not reliable acquisition lots. Missing history/realized gains/
  corporate actions → unknown estimates and named owner-data prerequisites, never ₹0 tax or
  a fabricated available exemption. Show STCG/LTCG and remaining budget only when supported.
- [ ] Wire sell trigger 6 to the standing paper queue. No `runCleanup` execution, real fills,
  lot disposal, or actual exemption consumption; planned and realized amounts remain distinct.
  Full tax engine/seeded FIFO and live realization are Phase 3.

### Task 4: Extend existing web approval/cleanup/rail surfaces

**Files:** `web/app/approvals/`, `web/app/cleanup/`, existing rails/recommendation/scoring/audit
pages, `web/lib/` server adapters and `web/app/nav.tsx` as needed.

- [ ] Add pending/detail approval views with the same Modify/Defer/substitute/approve/reject
  platform functions as Telegram; render immutable history, paper status, reasons and expiry.
- [ ] Add cleanup calendar, unknown-tax prerequisites, rail cooling countdown, freeze/breaker
  state and behavioral justification; scorecard renders real records or explicit insufficient data.
- [ ] Keep existing `/import`, Fidelity reconciliation, portfolio views and layout working.
  Do not add OHLC charts when only close data exists or route funded status into action inputs.
- [ ] Before remote deployment, enforce single-owner web authentication (passkey or OAuth
  allowlist of one, §12.3) on reads and mutations, with server-side authorization and request
  integrity checks. Secrets remain server-side; Telegram deep links confer no authority.
- [ ] Keyboard/contrast/status checks; root and web typechecks plus focused integration tests.

### Task 5: Paper scheduling, scoring and backup/restore proof

**Files:** approval/cleanup job entrypoints and workflows as needed, existing report/scoring
wiring; backup/restore workflow and runbook in `docs/SETUP.md`.

- [ ] Expiry is enforced at every action/read boundary, independent of delayed cron. Schedule
  due expiry/defer/reminder processing without claiming exact-time Actions delivery. T+2/T+7
  advisory reminders operate on simulated paper events only. Make reruns idempotent.
- [ ] Cleanup is a standing queue; monthly refresh is a proposed cadence, not PRD-fixed
  "first trading day 10:00". Keep sync 19:00 IST, digest after sync success, weekly Sun 10:00.
- [ ] Reuse the scoring engine; render creation benchmarks, due 3/6/12m evaluations and
  modifications/rejections where evidence exists. Pending horizons are not scored early.
- [ ] Implement weekly encrypted `pg_dump` backup to a private GitHub repo per §8.3; obtain
  destination/access/encryption configuration through secrets. Restore to an isolated database
  and verify rows, constraints, immutable history and recovery instructions. No production
  overwrite; a runbook without a tested restore does not satisfy Phase 2.

### Task 6: Provisioning, handoff and Phase 2 acceptance

- [ ] Document Vercel single-user deployment and only actually needed secrets/env; do not add
  unused Kite credentials/static-IP work. Document jobs, paper-only boundaries and unresolved data.
- [ ] Run relevant tests, full suite, root/web typechecks and deployment checks if provisioned;
  record actual results, not an inherited test count as proof.
- [ ] Update PENDING/MEMORY/index/progress with implementation versus observed-paper status.
- [ ] PRD §14 Phase 2 DoD, verbatim: **"4 clean weeks of paper operation; owner completes ≥5
  approval-flow interactions end-to-end in paper; scorecard renders; a simulated rail violation
  and breaker trip both behave to spec."** Record dated evidence. Tests cannot replace four
  elapsed weeks or five owner interactions. Owner paper-scorecard review gates Phase 3 (§13).

## Open decisions / provisioning (not invented policy defaults)

- Limit-order approval expiry and non-trading-day draft/session policy where the PRD is silent.
- FIFO/history and realized-gains completeness; verify tax parameters at implementation time.
- Backup destination/encryption/recovery environment and Vercel single-owner auth configuration.
- Rating-action source versus manual quarterly review remains an owner item; no fabricated feed.

These do not prevent starting Task 1's defined paper paths with fixtures. Market EOD/7-day
expiry, three-falsification breaker, ≤4 recommendations/month and 48h cooling are PRD
requirements, not owner decisions to reconfirm from the discarded draft.
