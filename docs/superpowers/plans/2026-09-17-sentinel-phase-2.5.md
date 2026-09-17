# Sentinel Phase 2.5 ("Advise") Implementation Plan

**Status:** Owner decision 2026-09-17; corrected planning handoff, not shipped functionality.

**Goal:** The LLM makes BUY / SELL / HOLD / WAIT recommendation and timing decisions from
validated engine candidates plus available company/news/sentiment context. This expressly
refines the narration-only interpretation of PRD §6.7; it does not make deterministic sizing,
scores, taxes, caps, staleness or approval optional. News may change selection or defer a call;
the LLM cannot invent an eligible instrument, a permitted action, a numeric input or a quantity.

Phase 2.5 also adds bounded commentary, owner-signed quarterly watchlist revision, deterministic
replay and calibration. It creates no execution path and does not satisfy the Phase 3 live gate.
Paper remains enforced until that separately reviewed phase.

## Contracts and architecture

- Reuse the Phase 2 plan's four-method `Db` interface (`query`, `exec`, `withTransaction`,
  `close`), non-nesting transactions, JSON objects for `::jsonb`, bigint money and unit micros.
  Assign new migration numbers after inspecting the tree; never edit an applied migration.
- Use `src/config/models.ts` / existing OpenRouter wiring for text jobs. The chosen finance
  model is text-only; no new vision chain or agent runtime. No model training-cutoff or exact
  replay claim based merely on its name. Model availability, costs and capabilities are verified
  when implemented, not asserted from a stale catalogue.
- `src/advisor/` consumes explicitly projected, read-only engine/context DTOs. Pure engine and
  sizing computations are allowed for offline replay; engine persistence helpers, broker
  adapters, arbitrary SQL write capability and operational settings writers are not.
- Split capabilities rather than prohibiting the imports the plan needs: proposal writer →
  immutable `advisor_proposals` + audit; replay writer → immutable `replay_runs` + audit;
  news/classification writers → their own immutable evidence + audit. Owner-action service
  **outside** `src/advisor/` alone applies signed watchlist changes or converts validated BUY/
  SELL proposals into Phase 2 paper requests. Recommendation and order writes go through their
  existing gate-aware platform functions, not through LLM persistence code.
- Architecture tests cover transitive paths and injected capabilities, not just direct import
  strings. Separate pure functions from writers only where the dependency requires it. Preserve
  the no-catch-up firewall: funded status cannot enter advisor decisions, sizer, risk or gates,
  including as a number copied into a generic portfolio JSON blob.
- LLM chooses an eligible `(candidateId, action, timing)`; deterministic code attaches the exact
  supported size and rechecks hard gates. Selection is not a new numeric score or size input.
  HOLD/WAIT has no order quantity and creates no order. Sign-off is not execution approval.
  Owner quantity modifications remain possible under FR-21, as a separately audited revision
  revalidated deterministically with fresh approval; the LLM itself cannot modify quantities.

## Honest data coverage and failure semantics

NSE announcements and selected business-news RSS are **candidate sources**, requiring real
format/access fixtures and symbol resolution before being called supported. Initial scope is
held/watchlist names and selected screener-cohort coverage, not everything in the market.
Corporate results, buybacks or partnership announcements may be available; reliable full
insider/institutional flows, rating actions, exhaustive sentiment and complete historical
fundamentals are not promised by RSS. Unknown identity is unresolved, never guessed neutral.

Existing gaps include the unavailable 2026 index-series feed, EV/EBITDA/own 5y P/E history,
partial fundamental/identity coverage, and aggregate rather than complete FIFO lots. Coverage
metadata names supported instruments, source/query windows, missing fields and known omissions.
The owner-provided G-sec value is not an automatically refreshed historical series. No source
or model fills these holes from recall to make a recommendation pass.

Record fetch attempts separately from articles: source/query/instrument scope, coverage window,
started/completed times, success-empty/success-with-results/partial/failed state, and error.
A successful empty fetch means **no matching news found in that scope**, not feed failure and
not proof no adverse event exists. Feed freshness uses successful coverage checks, never the
latest article timestamp. Preserve previous success and its age after failure; a failed or
partial fetch cannot masquerade as current empty success.

Advisor eligibility is per relevant coverage: known fresh empty coverage may support advice
with an explicit caveat; missing/failed/stale coverage or relevant unclassified events yield
visible deterministic no-action until resolved. Price/fundamental engine freshness remains
independent of news. A proposed 48h news coverage SLA is a design choice requiring confirmation,
not FR-31's specified price threshold. News can occur on weekends; do not skip news simply
because NSE is closed. No-key/timeout/malformed LLM results are recorded as unavailable, never
neutral sentiment or a confident HOLD recommendation.

## Tasks (11, dependency order)

### Task 1: Advisor schema + capability firewall

**Files:** next-numbered advisor migration, `src/advisor/types.ts`, capability adapters outside
the LLM layer as needed, `tests/advisor/firewall.test.ts`.

- [ ] Immutable `advisor_proposals` includes ADVISE, WATCHLIST_REVISION, COMMENTARY and optional
  RATING_REVIEW; store input snapshot/evidence IDs, `as_of`, source, model/request/prompt/schema
  versions and provenance. Signed/dismissed status is derived from append-only decision events;
  no UPDATE of a supposedly append-only payload/status row. Immutable `replay_runs` stores
  coverage, dataset/code/config hashes and results; `eval_buckets` is a reader/view, not a
  second mutable truth. RLS + UPDATE/DELETE/TRUNCATE refusal on immutable records.
- [ ] Log call model, latency, outcome and token usage when reported; unavailable usage is NULL,
  not invented zero. Deterministic no-action records name their cause and do not claim an LLM call.
- [ ] Mutation-check forbidden transitive engine-write/order/funded-status access and arbitrary
  injected writers. Positive tests allow proposal persistence, replay persistence and pure
  computations without widening the prohibition to legitimate reporting-only callers.

### Task 2: News ingestion + fetch coverage

**Files:** next-numbered news migration, `src/sources/news.ts`, `src/jobs/news-sync.ts`, source
tests and fixtures; source-status reporting integration.

- [ ] `news_events`: immutable ID, nullable resolved instrument (market-wide distinguished from
  unresolved), headline/snippet/URL, event type, `published_at`, `received_at`, `as_of`, source,
  dedupe key, optional supersedes link. `news_fetch_runs` records the coverage contract above.
- [ ] Validate a real NSE announcement JSON and RSS XML sample; retries/rate limits and errors
  are explicit. Source URLs come from verified configuration; no paid feed assumed.
- [ ] Same event rerun produces no duplicate; corrections append a superseding event. Missing
  `as_of` or source fails schema tests with otherwise valid positive-control rows.
- [ ] Tests distinguish success-empty, populated, partial, failed, stale and unresolved-name
  cases. No deleting immutable news rows to simulate staleness: advance the clock or seed an
  old coverage record. Fresh empty coverage passes the coverage check; stale/failed coverage
  blocks relevant advisor advice only. Weekend news is fetched.
- [ ] One daily news job after portfolio sync plus on-demand recovery; no duplicate fetch step
  in both `sync.ts` and a separate job. News failure does not suppress deterministic reporting.

### Task 3: Versioned sentiment classification

**Files:** `src/sources/sentiment.ts`, `src/jobs/sentiment-classify.ts`, tests.

- [ ] `event_sentiment` carries event ID, resolved scope, polarity/materiality, ≤80-word summary,
  evidence spans/IDs, model/prompt/schema versions, classified/received timestamp, `as_of`, source.
  Reclassification appends; readers select the latest **available by their cutoff**, not latest now.
- [ ] Validate closed enums and evidence membership. Unresolvable identity or uncertain output
  is flagged unresolved/unknown, never coerced to NEUTRAL/LOW. No key/failure leaves PENDING.
- [ ] Batch new events daily (proposed maximum 20/call), with on-demand audited reclassification;
  log actual calls. Daily classification is explicitly part of cost accounting in addition to
  weekly advice/commentary and quarterly watchlist calls.
- [ ] Fixture-driven tests use stubbed model outputs to prove parsing, rejection, provenance and
  versioning. A buyback is not necessarily positive; tests do not pretend a real model always
  assigns a predetermined economic sentiment. No sentiment numeric output feeds engine scores.

### Task 4: Deterministic actionable sizing prerequisite

**Files:** narrowly scoped pure sizing module under `src/domain/`, tests; candidate DTO assembly.
Reuse existing `alloc-engine.ts` and money primitives where they actually suffice.

**Missing capability:** allocation drift paise is not a general satellite/exit unit sizer.
Signal score and sell-trigger objects alone do not establish an affordable BUY or sellable SELL.

- [ ] Produce immutable eligible candidate IDs with action, instrument, quote/FX timestamps,
  requested budget/proceeds basis, integer units or product-valid amount, policy version and
  explicit constraints. Size from real cash, holdings, committed paper reservations, tactical
  budget/confirmed-vest allowance, concentration and liquidity headroom. No new catch-up budget.
- [ ] Do not invent the satellite allocation budget/rule if no existing IPS/owner input supplies
  one; record it as a prerequisite and withhold that candidate until supplied. Score ≠ budget.
- [ ] BUY is bounded by affordable cash and all applicable rails; SELL by actually owned units,
  permitted exit/minimum hold and available tax/lot evidence where required. No shorts/leverage.
  Cover integer rounding, zero size, stale quotes/FX, incomplete holdings/cash, aggregate-lot
  ambiguity and unknown tax. Unsupported action/product combinations remain unavailable.
- [ ] Validate the **combined** selected batch and outstanding reservations; multiple individually
  safe candidates cannot consume the same money or headroom. Recheck at owner-action time.
- [ ] Derived/mutation tests prove caps, holdings bounds and no-catch-up. ADVISE BUY/SELL cannot
  proceed until this prerequisite is real; HOLD/WAIT remains a valid explicit LLM decision.

### Task 5: Point-in-time deterministic replay (§13)

**Files:** `src/advisor/replay.ts`, `src/jobs/advisor-replay.ts`, tests.

- [ ] `replayWindow` operates on a frozen dataset/config/code version and injected clock; same
  inputs yield identical **result payloads**, excluding run ID/wall-clock metadata. Writes only
  replay records, never live scores/recommendations/orders. No network or new LLM calls.
- [ ] Cut off both economic timestamps and availability/ingestion timestamps. A late import
  carrying an old `as_of`, corrected price, or reclassified article must not leak backward.
  Include historical watchlist/universe, holdings/cash/flows, lots/corporate actions, FX,
  benchmarks, IPS/rails, G-sec inputs and approval state wherever the computation needs them.
- [ ] Existing correctable tables do not guarantee historical versions. Use preserved input
  snapshots/versioned evidence where available; otherwise narrow coverage or mark the result
  unreconstructable. Never replay today's watchlist/portfolio across old dates as point-in-time.
  Historical month-end readers must not read past a mid-month replay cutoff.
- [ ] Test future data, late-arriving backdated data, revised news classifications and changed
  membership/config; all must leave earlier results unchanged or explicitly unscorable.
- [ ] Stored advisor inputs/outputs can be replayed as recorded artifacts; deterministic engine
  sanity replay does **not** evaluate a historical LLM decision. A new model run on old news is
  a retrospective experiment (training-data leakage/model drift/nondeterminism possible), not
  a point-in-time backtest or exact reproduction. No claim of zero LLM cost for such new runs.
- [ ] Report survivorship bias, unavailable TRI/category/composite benchmarks and effective
  coverage. Do not relabel a price index as TRI. Backtests are directional (§13); the forward
  paper/live scorecard remains primary.

### Task 6: LLM ADVISE decision + gated paper handoff

**Files:** `src/advisor/recommend.ts`, `src/jobs/advisor-recommend.ts`, tests; owner-action
adapter and weekly report integration. Depends on Tasks 1–4; replay is separate evidence.

- [ ] `buildAdvisorContext` projects eligible sized engine candidates, sell triggers, IPS,
  portfolio constraints, trend data, covered news/classifications and calibration status with
  explicit omissions. No funded-status field or arbitrary raw reporting snapshot.
- [ ] `advise` accepts BUY/SELL/HOLD/WAIT, candidate/evidence IDs, timing, rationale, key risk,
  falsification, counterargument and holding horizon. Validate action against the candidate's
  permitted action; unknown IDs, ungrounded claims and model-supplied numeric overrides fail.
  Assemble full FR-11 primary + exactly two eligible alternates, convictions/bases and IPS
  citations via existing builders. Missing alternatives are not fabricated to fill a schema.
- [ ] The LLM can choose BUY or SELL among eligible candidates, change its recommendation based
  on news, or choose HOLD/WAIT. Negative news alone does not manufacture an eligible SELL or
  override a minimum hold. Deterministic code attaches unchanged candidate quantity, then gates
  the aggregate choice before a BUY/SELL proposal is handed to the paper approval service.
- [ ] HOLD/WAIT carries no order quantity and creates no order. Missing model/invalid output/
  required coverage failure yields **system no-action/unavailable**, distinct from LLM HOLD/WAIT.
  Fresh successful empty news is allowed with the coverage caveat; relevant unclassified news
  blocks advice. Tests pin both paths and news-driven changes using controlled model outputs.
- [ ] Proposal sign-off creates a fresh Phase 2 request through an external authorized adapter;
  it cannot itself approve an order. Revalidate current size/evidence/rails at handoff and order
  approval. Changed quantities invalidate old snapshots and require owner review, not silent resize.
  FR-21 owner modifications remain separately marked and deterministically validated.
- [ ] Persist exact input snapshot, output, evidence links, model/version/provenance and failures.
  Monthly recommendation caps, paper mode and freeze/breaker apply across all recommendation
  sources, not a separate advisor quota. Mutation-check that no LLM decision bypasses a gate.

### Task 7: Calibration by conviction and horizon

**Files:** `src/advisor/calibrate.ts`, tests; reuse `src/domain/scoring.ts` and report rendering.

- [ ] Read stored benchmark/evaluation evidence; group by conviction **and horizon**, counting
  distinct eligible recommendations (do not count 3/6/12m observations as three independent calls).
  Distinguish engine versus advisor decisions and owner modifications where attributable.
- [ ] Preserve provisional minimum N=20; each bucket independently withholds below threshold,
  subject to owner confirmation. Unelapsed/missing benchmark outcomes are excluded with reasons,
  never misses. Record sample size/coverage; no calibrated percentage from LLM confidence prose.
- [ ] Derived tests cover threshold boundaries, duplicates, missing benchmarks and due horizons.
  HIGH-vs-MEDIUM comparisons require comparable windows and coverage; N alone does not prove
  skill. Retrospective replay is not mixed into the forward paper/live calibration scorecard.

### Task 8: Bounded commentary

**Files:** `src/advisor/commentary.ts`, tests; reuse existing narration transport/fallback.

- [ ] ≤300 words/section, cited evidence IDs, deterministic bullets on failure/no key.
  Numeric-claim bindings reference a specific input field with units, subject and period;
  render important quantities deterministically. Reject missing/mismatched references.
- [ ] A regex checking that a numeral occurs somewhere in JSON is only a lint, not semantic
  validation (the right number can name the wrong company, sign or period). Tests include those
  false-positive cases; free prose remains model reasoning, not verified financial fact.
- [ ] No commentary modifies scores, sizes or advisor decisions. Persist only validated sections
  with provenance; no fabricated hit-rate in withheld buckets.

### Task 9: Owner-signed quarterly watchlist revision

**Files:** `src/advisor/watchlist.ts`, `src/jobs/advisor-watchlist.ts`, tests; existing watchlist
proposal readers and owner-signoff service.

- [ ] Additions come from real screened candidates excluding held/already-watched names.
  Removals evaluate **watchlist** evidence (failed quality, red flags, sustained underperformance),
  not only sell triggers on owned positions. Insufficient history is not a failure signal.
- [ ] Proposals cite input IDs and reasons; no invented instruments or automatic mutations.
  Owner per-line sign-off uses a gate-aware service outside the advisor. Inspect actual existing
  watchlist persistence: append-only history must not be updated to set `removed_on`; add a
  version/event representation with readers if necessary, rather than disabling audit protection.
- [ ] Quarter-key idempotency and held/unheld/removal tests. First Sunday of Apr/Jul/Oct/Jan is
  proposed scheduling (requires owner confirmation); derive IST schedule tests from actual YAML.

### Task 10: Existing web `/advisor` + Telegram/report integration

**Files:** `web/app/advisor/`, `web/lib/` adapters, existing navigation/report notification code.

- [ ] Render BUY/SELL/HOLD/WAIT, deterministic size provenance, timing, full FR-11 choices,
  evidence and coverage/failure states, with sign-off leading to Phase 2 paper approval detail.
  Show system no-action separately; no approval button for a HOLD/WAIT order that does not exist.
- [ ] Watchlist per-line sign-off, sentiment history, commentary and calibration real-data views;
  inherit single-owner auth and existing CSS/layout, keyboard and contrast requirements.
- [ ] Rating review and G-sec quarterly reminders remain proposed manual coverage, pending owner
  decision; do not mark those source gaps resolved. Preserve statement confirmation in bot/web.

### Task 11: Jobs, documentation and close

- [ ] Wire one daily news → new-event classification path, weekly advice before report, and
  quarterly watchlist proposal. Record costs for every LLM seam; reruns dedupe work, failures
  do not hide the deterministic weekly report. No tool-use/autonomous loop.
- [ ] Update env docs only for implemented configuration; reuse central text model choice.
  Document data/action coverage, sizing policy and unresolved owner inputs, replay limitations,
  capability boundaries, auth, and paper/live state truthfully.
- [ ] Relevant tests, architecture/mutation checks, full suite and root/web typechecks pass;
  ledger records actual evidence. Phase 2's four-week/owner-interaction gates still apply.

## Owner inputs before the affected capability is enabled

- Satellite per-action sizing budget/policy where the existing IPS does not determine it;
  reliable cash/units/FIFO and tax data for action types requiring them (Task 4).
- News source availability/scope and proposed coverage freshness SLA (Task 2).
- Manual quarterly rating/G-sec review versus future ingestion; historical coverage stays absent
  until evidenced. Quarterly revision timing and per-bucket N=20 remain provisional.
- Regenerate/validate the shortlist from the real imported cohort before Task 9 sign-off;
  existing instruments alone are not proof of a fresh quality gate.

**Sequencing:** Phase 2 approval/rails first; Phase 2.5 Tasks 1–4 establish evidence and sizing,
Task 5 proves bounded replay, Task 6 makes LLM decisions, Tasks 7–11 evaluate and surface them.
This plan's 11 tasks replace the draft's duplicate Task 4 and inconsistent task-count claims.
