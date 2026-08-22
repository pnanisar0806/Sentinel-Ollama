# PRODUCT REQUIREMENTS DOCUMENT
## "Sentinel" — A Personal Investment Intelligence Agent for Anirban Sarkar

**Document type:** Self-contained build prompt. Hand this document to any capable engineering agent or developer. It contains everything needed to build the product; the builder should need to ask the owner nothing except the build-time verification items in Section 15.

**Owner and sole user:** Anirban Sarkar, Hyderabad, India.
**Date of requirements freeze:** 12 August 2026.
**Status of every number herein:** Interrogated, pressure-tested, and explicitly confirmed by the owner over a multi-session requirements process. Do not relitigate settled decisions; do verify the build-time items in Section 15.

---

# 1. EXECUTIVE SUMMARY AND PROBLEM

## 1.1 The problem

The owner is a 31-year-old salaried technology professional with a single-income household, a child planned in ~2028, assets scattered across five platforms (Zerodha, INDmoney, Groww residue, Fidelity NetBenefits, EPF), three active loans, four fee-charging smallcase subscriptions producing an unmanaged 26-position stock portfolio, high-yield NBFC credit bonds held against 7.95% debt, employer stock concentration invisible to every portfolio tool he owns, and no unified view of any of it. He has clear long-term goals but no system that (a) sees the whole picture, (b) proposes analytically grounded actions bound to a written policy, (c) lets him approve, modify, or reject every action before execution, and (d) learns whether its own advice was any good.

## 1.2 The product

**Sentinel** is a standalone, single-user, approval-gated investment intelligence agent. It:

1. Aggregates the owner's complete financial position daily (Indian equities, mutual funds, US stocks, bonds, EPF, RSUs, gold, cash, loans, credit cards).
2. Manages four ring-fenced goal buckets (FI corpus, House fund, Emergency fund, Child education corpus) plus two protection milestones (term insurance, health top-up), each with its own mandate.
3. Generates recommendations bound to a written Investment Policy Statement (IPS), each carrying a primary action plus exactly two alternates, with thesis, risk, expected holding period, falsification condition, conviction level, and the strongest argument against itself.
4. Routes every recommendation through a Telegram-based approval workflow in which the owner can approve, modify parameters, defer, substitute, or reject.
5. Executes approved orders on Zerodha only (via free Kite Connect Personal API), operates advisory-only on INDmoney and Fidelity, and never acts silently, never acts on stale data, and never crosses hard safety rails.
6. Tracks its own performance against benchmarks, scores every recommendation after the fact, and demotes itself when it underperforms.

## 1.3 What this is not

Not a day-trading bot. Not a product for anyone other than the owner. Not an autonomous executor. Not a SEBI-registered advisory service. See Section 4.

---

# 2. COMPLETE FINANCIAL AND INVESTOR CONTEXT

All figures as of August 2026 unless noted. The builder must treat this section as seed data for the system's initial state.

## 2.1 Personal profile

| Item | Value |
|---|---|
| Age | 31 (born ~1995) |
| Employment | ServiceNow India (technical role); owner assesses job as currently stable |
| Household | Married; wife currently has no income (modelled at ₹0 until changed) |
| Dependents | Wife; parents (housed in owner's Kolkata flat, supported ₹20,000/month); child planned ~2028 |
| Location | Rents in Hyderabad (₹31,500/month); owns a flat in Kolkata (parents live there, ₹0 yield, non-negotiable family asset — never a sale/rent candidate) |
| Tax | New regime; 30% marginal slab; take-home ₹2,15,000/month post-tax; files via ClearTax (self-service) |
| Filing obligations | Holds US-listed shares at Fidelity → **Schedule FA reporting applies today** |

## 2.2 Monthly cash flow (August 2026)

**Income:** ₹2,15,000 take-home.

**Fixed outflows — ₹1,23,394 + electricity + ~₹10,000 misc:**

| Amount | Identity | Terminates |
|---|---|---|
| ₹24,482 (listed as 25,000) | Home loan EMI, SBI, 7.95%, started Mar 2022, outstanding ~₹29.7L + ₹54k insurance sub-loan | Dec 2033 under prepayment cascade (natural: Feb 2047) |
| ₹13,821 | Car loan 1 EMI (HDFC) | Jan 2028 |
| ₹17,223 | Car loan 2 EMI (Bank of Baroda; ₹5.5L, Apr 2026, 36mo, 7.95%) | Sep 2028 under cascade (natural: Apr 2029) |
| ₹31,500 | Hyderabad rent | Converts toward new-home EMI at Hyderabad purchase (~2033–35) |
| ₹20,000 | Support to owner's mother | Permanent obligation — never model as terminating |
| ₹10,000 | Wife's allowance | Ongoing |
| ₹5,850 | Maid + building maintenance | Ongoing |

**Committed loan prepayment cascade (owner's locked strategy — model, do not relitigate):** When car loan 1 ends (Jan 2028), its EMI redirects to car loan 2, closing it Sep 2028; thereafter ₹31,044 combined redirects to the home loan, closing it **Dec 2033** and saving ~₹19.3L interest. Consequence for the surplus model: loan-related outflow is **constant at ₹55,526/month until Dec 2033, then releases entirely in Jan 2034** (owner age ~39). This is a step function the contribution model must encode.

**Investable surplus:** ~₹76,000/month, **inclusive of existing SIPs**. Owner has committed to a **10% annual step-up regardless of market conditions**, suspended only by the SIP-stop events in the IPS (Section 3).

**Known future dent:** child from ~2028 adds ~₹10,000/month until school age; education costs beyond that are handled by the ring-fenced education corpus (Section 2.6). The contribution model must encode surplus as a curve: flat → minus dent (2028) → plus loan release (2034) → minus/neutral at Hyderabad purchase (rent→EMI conversion).

## 2.3 Balance sheet (verified via INDmoney MCP + Fidelity statement, Aug 2026)

**Assets (~₹48L total including Fidelity):**

| Bucket | Value | Composition notes |
|---|---|---|
| EPF | ₹13.54L | Largest single asset; treat as debt-like retirement ballast |
| Mutual funds | ₹11.84L | ICICI Nifty 50 Index Direct across **three folios** (₹47k Zerodha Coin + ₹2.81L + ₹3.68L INDmoney = ₹6.96L, ~59% of MF book); Parag Parikh Flexi Cap across three folios (₹2.41L); ICICI Large Cap ₹2.03L; HDFC Mid Cap ₹0.19L; Motilal Midcap ₹0.06L; Bandhan Small Cap ₹0.18L |
| Indian stocks | ₹8.32L | 26+ positions, largely smallcase residue: Nifty BeES ₹95k, Gold ETF ₹63k (2,616 units), Liquid ETF ₹16k, Tata cluster ~₹1.55L (Steel/Motors/Motors-PV/Power), Mahindra cluster ~₹73k (M&M, M&M Fin, Lifespace, Tech M), dividend-aristocrat names (ITC, HUL, Asian Paints, Berger, Pidilite…), micro-orphans (₹218 Kwality Walls; ₹2.6k Reliance Power on **Groww** — separate broker) |
| Corporate bonds | ₹6.33L | Sammaan Capital (ex-Indiabulls Housing) ₹2.84L @ 9% coupon **maturing 26-Sep-2026**; Sammaan ₹0.96L @ 9.75% maturing Jul-2029; Edelweiss Financial ₹2.20L @ 10.45% maturing Oct-2033. High-yield NBFC credit, NOT safe ballast. ~8% single-issuer exposure to Sammaan |
| Savings account | ₹1.63L | |
| US stocks (INDmoney) | ₹1.37L | Fractional AAPL/GOOGL/AMZN/MSFT/TSLA/VOO |
| Vested ServiceNow (Fidelity) | ~₹5.0L | **Invisible to INDmoney** — largest single-stock position, 10x any Indian holding |

**Liabilities:** ₹36.7L loans (per 2.2) + ~₹78k monthly credit-card cycle across 5 cards (Regalia Gold, Amazon ICICI, SBI Octane, IndusInd, YES Klick) — **owner confirms full payment monthly, zero revolving**. A ₹30k IDFC consumer loan shows ₹0 balance (closed; ignore).

## 2.4 RSU pipeline (Fidelity NetBenefits, ServiceNow "NOW", verified from statement)

- 6 grants, 1,105 units total granted; **unvested outstanding ₹53.25L** at $127.54 / ₹95.3 per USD.
- Vest cadence: quarterly (Feb/May/Aug/Nov 15 ± days), currently ~₹2.19L gross per quarterly tranche from the 2026 grant plus overlapping older grants. Approximate gross vest values: 2026 remainder ₹6.8L; 2027 ₹18.4L; 2028 ₹14.1L; 2029 ₹11.8L; 2030 ₹2.2L. Withholding: net-shares (~30%); model post-tax at ~70% of gross.
- **Refresher assumption (owner-confirmed):** $20,000/year new grants vesting over 4 years, i.e., steady-state incremental ~$20k/yr (~₹13L post-tax/yr) once ramped. Base case includes refreshers; a no-refresher downside scenario must also be maintained.
- Feb 2026 grant (285 units) is the owner's largest ever — refresher assumption is grounded, not hopeful.

## 2.5 The resolved goal and its justification (the objective function)

The owner's original target of "₹40 Cr in today's money in 15 years" was interrogated and **discarded** — the arithmetic showed even a sustained 25% CAGR on his surplus leaves a 6x gap; the number was an unexamined anchor. The resolved goal:

> **Financial independence income of ₹3,00,000/month (floor) to ₹5,00,000/month (stretch) in today's purchasing power, at age 55 (year ~2050).**

At a 3.5% safe withdrawal rate (appropriate for Indian inflation; 4% carried as optimistic sensitivity), this implies a corpus of **₹10.3 Cr (floor) to ₹17.1 Cr (stretch) in today's money** (₹9–15 Cr at 4% SWR).

**Feasibility verdict (encode as the plan's honest baseline):** Existing ₹48L corpus compounding 24 years at 12% nominal ≈ ₹1.8 Cr real; salary SIP stream (₹76k, 10% step-up, dent + release modelled) ≈ ₹6.4 Cr real by 55; combined ≈ ₹8+ Cr real vs the ₹10.3 Cr floor; RSU refreshers redirected to the FI bucket after the Hyderabad purchase (2033–35) close the remaining gap. **The floor is achievable with discipline; the stretch requires refreshers continuing and no major derailment.** The agent reports funded-status against this band but NEVER uses it to modulate risk (see IPS §3.2).

**Non-salary engines, ruled:** YouTube income modelled at **₹0 base case** (upside-only, revisited annually with actuals); wife's income ₹0 until changed; RSUs are the only modelled non-salary engine.

## 2.6 The four buckets and two milestones (goal architecture — owner-confirmed)

| Bucket | Target | Funding source | Mandate |
|---|---|---|---|
| B1: FI corpus | ₹10.3–17.1 Cr real at age 55 | Salary surplus (all SIP flows); RSU overflow after B2 completes | Max risk-adjusted return within 30% max-drawdown constraint |
| B2: House fund | Hyderabad home ₹2–2.5 Cr, purchase 2033–35; down payment + costs ₹55–75L | RSU vests (sell-on-vest), post B3 seeding | Capital preservation, duration-matched debt/arbitrage instruments; NO equity risk on money needed within 7 years of purchase |
| B3: Emergency fund | ₹6,00,000 liquid | Sammaan Sep-2026 maturity (~₹3.1L incl. final coupon) + Nov-2026 RSU vest (~₹2.1L net); complete by Dec 2026 | Savings structure per owner's existing plan: AU Small Finance Bank during build, IDFC First once >₹3L, split across banks beyond ₹5L for DICGC cover |
| B4: Education corpus | ₹1 Cr in today's money at child's age 18 (~2046) | Carve-out from surplus, activates ~2028 | Long-horizon equity glide path, de-risking from ~2040 |

| Milestone | Spec | Agent behavior |
|---|---|---|
| M1: Term life | ₹2 Cr personal term cover, before child's arrival, funded from RSU vests | Agent tracks as incomplete, includes in every weekly report, nags until done. Rationale on file: employer group cover evaporates on exit; maximum-dependency point is NOW |
| M2: Health top-up | ~₹50L family super top-up beyond employer cover | Same nag mechanics |

## 2.7 Behavioural risk profile (revealed, not questionnaire)

- 2022 drawdown: owner paused SIPs 2–3 months — later clarified as a **liquidity crisis, not fear** (the emergency fund gap was the true cause; B3 is the fix).
- Stated and confirmed stance: **SIPs continue through market drawdowns; drawdowns are buying opportunities.** SIP-stop is event-based only: job loss >3 months, or medical expense >₹30L.
- Drawdown tolerance: **30% portfolio peak-to-trough.**
- Lightweight pre-commitment protocol (owner-accepted): at −20% portfolio drawdown, before the owner can pause anything, the agent displays his own written policy and 2022 history; any pause requires a typed reason, logged, replayed during recovery.
- Never-events: leverage, F&O, intraday, loan-against-securities — **never**, no exceptions, no override path in software.

---

# 3. THE INVESTMENT POLICY STATEMENT (IPS)

This is the binding document. Every recommendation must cite the IPS clause(s) it serves. The IPS is versioned in the database; changes require explicit owner action outside a drawdown and take effect after the 48-hour cooling-off (Section 11). Annual review is a scheduled agent task.

## 3.1 Philosophy
Long-term, tax-aware, evidence-based investing for a specific household's goals. The owner is an investor, not a trader. Activity is a cost. The default action is no action.

## 3.2 Objective function
Maximize risk-adjusted return subject to a 30% maximum portfolio drawdown constraint. Funded-status vs the FI band is a REPORTING metric reviewed annually; it must never increase risk-taking after underperformance ("catch-up" behavior is prohibited by construction).

## 3.3 Strategic asset allocation (portfolio-level, across B1 primarily)
- Equity ceiling ~60% of total investable assets (calibrated so a 2008-grade equity crash ≈ −25 to −30% portfolio drawdown).
- Gold: 5–10% band (via existing Zerodha Gold ETF; gold fund-of-fund on Coin acceptable for SIP automation).
- Debt/EPF/cash: remainder; EPF counts as debt-like.
- B2 (house fund): 100% capital-preservation instruments once seeded.

## 3.4 Equity structure: core–satellite 75/25
- **Core (≥75% of equity flows):** index instruments (Nifty 50, Nifty Next 50, flexi-cap of PPFC type, US index exposure) — consolidate into the existing ICICI Nifty 50 Index folios and BeES ETFs.
- **Satellite (≤25% of equity):** agent-recommended direct stocks, each with a ≤150-word written thesis containing an explicit falsification condition. Operates on the curated watchlist (Section 8).

## 3.5 Hard concentration caps (safety rails, machine-enforced)
- Any single stock: ≤10% of liquid portfolio.
- Any single issuer across equity + credit instruments: ≤10%.
- Any single MF scheme: ≤35%.
- Any single sector (direct-equity book, ex-index funds): ≤25%.
- Employer stock (NOW): ≤10% of liquid portfolio, enforced via systematic sell-on-vest of the excess.

## 3.6 Universe
- **In:** Indian listed equity (non-penny, per 11.2), Indian MFs (direct plans only), Indian listed ETFs, US stocks/ETFs (advisory-only via INDmoney), listed bonds already held (legacy), gold ETF/FoF, liquid/arbitrage/debt funds, EPF.
- **Out:** F&O, intraday, leverage/margin/LAS (never); crypto (out; revisit clause on owner request only); REITs (deferred until after Hyderabad purchase, revisit 2035 — rationale: existing real-estate factor concentration); smallcase products (terminated — see 3.9); unlisted anything.

## 3.7 Trading discipline
- ≤4 recommended actions per month.
- 12-month minimum holding period (also the equity LTCG boundary), overridable only by: thesis falsification, red-flag event (fraud/auditor/pledge), or hard-cap breach.
- Rebalancing: hybrid — annual calendar rebalance + ±5% drift bands checked monthly. Band breach generates a recommendation, not an auto-trade.
- SIPs continue through drawdowns. Stop-events only: job loss >3 months; medical expense >₹30L.

## 3.8 Credit rule
Slab-taxed credit-risk paper must beat the owner's highest loan rate (currently 7.95%, fully post-tax-equivalent since new regime gives no interest deduction) **after tax and after a credit-risk haircut**, else the money prepays debt or buys risk-free instruments instead. Legacy positions failing this rule (Sammaan Jul-2029, Edelweiss Oct-2033) are standing review items for the agent's first live session.

## 3.9 Legacy cleanup mandate (owner-consented)
- All four smallcase subscriptions (Equity & Gold Asset Allocation, Dividend Aristocrats, Timeless Asset Allocation, House of Mahindra tracker) are **terminated** at v1 launch. The constituent ETFs (BeES, Junior BeES, Gold, Liquid) remain as direct holdings under agent management.
- Every holding without a live thesis is a consolidation candidate. Consolidation is executed tax-aware: harvest gains against the ₹1.25L/year equity LTCG exemption, spread over 1–2 fiscal years, FIFO lots.
- Micro-orphans (positions <₹5k) are consolidated first; the Groww Reliance Power position is flagged for manual closure (no Groww integration).
- Sammaan Sep-2026 maturity proceeds route to B3 (emergency fund) — pre-approved standing instruction, still surfaced for confirmation at the event.

## 3.10 Behavioral protocol
At −20% portfolio drawdown from peak: agent surfaces this IPS, the owner's 2022 history, and requires a typed justification before processing any SIP pause or panic-sell request. All such events are logged and replayed in the recovery report.

---

# 4. NON-GOALS AND SCOPE BOUNDARIES

1. **Sole user: Anirban Sarkar.** No multi-tenancy, no accounts, no sharing of recommendations with any other person in any form. The owner may showcase the *application* publicly (e.g., YouTube) but **never its recommendations/outputs as actionable advice**. This boundary exists because SEBI Registered Investment Adviser regulations and the entire liability posture change if any second person receives its output as advice. The builder must not add features that ease sharing of recommendations.
2. No trading: no F&O, no intraday, no leverage — not as disabled features but as absent code paths.
3. No autonomous execution. Every order requires fresh human approval; no standing auto-execute rules.
4. No crypto integration.
5. No paid data feeds in v1 (revisit 2–3 years).
6. No Groww integration (one legacy position, manual closure).
7. Wife's finances out of scope until owner changes this.
8. The Kolkata property is not an optimization target — never recommend selling or renting it.
9. Not a general-purpose chatbot; every LLM interaction is a structured pipeline step.

---

# 5. FUNCTIONAL REQUIREMENTS

Numbered, independently testable. "Agent" = the system. Grouped by capability. Every FR is a test case: given the stated precondition, the stated behavior must be observable.

## 5.1 Aggregation & state
- **FR-01** Agent syncs Zerodha holdings, positions, and orders at least daily on trading days via Kite Connect Personal API (or Kite MCP for read paths), persisting a timestamped snapshot.
- **FR-02** Agent syncs INDmoney net worth, MF holdings, Indian stock holdings, and US stock holdings daily via INDmoney MCP, persisting timestamped snapshots. Known limitation to handle: Zerodha-linked holdings via INDmoney lack invested amounts (return as 0/"unknown") — invested values must come from Kite/manual seed, never displayed as ₹0 cost.
- **FR-03** Agent maintains a Fidelity RSU model from the seeded grant table (Section 2.4): projected vest events with dates, units, and INR values marked PROJECTED until owner confirms; quarterly reconciliation task prompts the owner to confirm/adjust actuals (price, units, withholding). Confirmed events become ACTUAL.
- **FR-04** Agent computes total net worth including Fidelity and EPF — the unified view no existing tool provides — in every daily digest.
- **FR-05** Agent tracks all four buckets (B1–B4) with per-bucket balances, targets, funded-status, and glide paths, and both milestones (M1, M2) with completion status.
- **FR-06** Agent maintains the loan amortization model (three loans + cascade plan) and projects the surplus curve (dent 2028, release Jan 2034, rent→EMI conversion at house purchase) at least 24 months forward in monthly resolution and to 2050 in annual resolution.
- **FR-07** All snapshots, recommendations, approvals, orders, and IPS versions are append-only audit records; nothing is ever hard-deleted.

## 5.2 Analysis & recommendations
- **FR-10** Agent generates recommendations only from the engine spec in Section 6; every recommendation cites ≥1 IPS clause.
- **FR-11** Every recommendation contains: primary action + exactly 2 alternates; for each: thesis (≤150 words), key risk, expected holding period, falsification condition, conviction level (LOW/MEDIUM/HIGH with stated basis), and the strongest argument against the action.
- **FR-12** Agent enforces ≤4 recommended actions/month and 12-month minimum hold (with the three override events); attempted violations are logged and suppressed with a visible note in the weekly report.
- **FR-13** Monthly drift check against IPS bands (±5%); annual calendar rebalance proposal every April (fiscal-year aware for tax).
- **FR-14** Agent maintains the legacy cleanup program (3.9) as a standing recommendation queue with a multi-year LTCG harvest calendar.
- **FR-15** Sell logic is first-class: every holding is evaluated against sell triggers (Section 6.5) at least monthly; the system must be demonstrably capable of recommending exits, not only entries.
- **FR-16** Funded-status report vs the FI band computed monthly, shown in reporting only; a static code-review-verifiable property: no risk parameter anywhere reads funded-status as input.

## 5.3 Approval workflow
- **FR-20** Every actionable recommendation becomes an approval request on Telegram with buttons: Approve / Modify / Defer / Reject / Show alternates.
- **FR-21** Modify supports: quantity, limit price, order type (market/limit), defer-until date, and instrument substitution (choosing an alternate).
- **FR-22** Market-order approvals expire end of trading day; SIP/MF-change approvals expire in 7 days; expiry notifies the owner and archives the request as EXPIRED.
- **FR-23** Approved Zerodha orders execute via Kite Connect Personal only after the human-in-the-loop session unlock (Section 9.1); idempotency keys guarantee a retry can never double-place (FR-24 test: replay the same approval twice; exactly one broker order exists).
- **FR-24** Partial fills, broker rejections, and market-closed conditions produce owner notifications with next-step options (retry next session / convert to limit / cancel).
- **FR-25** INDmoney-side (US stocks, INDmoney MF folios) and Fidelity-side actions are ADVISORY: the agent issues instructions, the owner executes manually, the agent verifies completion on next sync and nags at T+2 and T+7 if unverified.
- **FR-26** New MF SIP flows route to Zerodha Coin folios (executable), not INDmoney folios; existing INDmoney folios are hold/advisory.

## 5.4 Safety & staleness
- **FR-30** Hard rails (Section 11) are enforced in code before any order draft is created; a draft violating a rail cannot exist.
- **FR-31** Every recommendation displays the timestamps of all data it used. Prices older than 24h (trading days) or fundamentals older than 1 quarter → recommendation generation is BLOCKED for affected instruments with a visible reason in the digest. The agent never silently proceeds on stale data.
- **FR-32** Kill switch: a single Telegram command (`/freeze`) cancels all pending approvals and halts order drafting until `/unfreeze` + confirmation. Notifications continue during freeze.
- **FR-33** Circuit breaker: 3 consecutive approved recommendations hitting their falsification conditions → agent self-demotes to report-only; reset requires explicit owner command.
- **FR-34** Rail edits apply after a 48-hour cooling-off; during a >15% drawdown, rail-loosening edits are refused entirely.
- **FR-35** Behavioral protocol (3.10) fires at −20% drawdown.

## 5.5 Tax
- **FR-40** FIFO lot tracking for every equity/MF/bond position, including seeded historical lots.
- **FR-41** Every sell recommendation shows estimated STCG/LTCG impact and remaining LTCG exemption budget for the fiscal year.
- **FR-42** LTCG harvest planner: proposes harvest transactions each fiscal year to use the ₹1.25L equity LTCG exemption against the cleanup program.
- **FR-43** ClearTax-ready exports: fiscal-year capital gains statement (per lot) and Schedule FA data (Fidelity + INDmoney US holdings with peak/closing balances) as CSV/XLSX.
- **FR-44** US-side tax awareness: TCS-on-LRS is modelled for any new US remittance recommendation; dividend withholding tracked for FA/FTC purposes. (Rates: build-time verification, Section 15.)

## 5.6 Reporting & lifecycle
- **FR-50** Daily digest (trading days, pre-open or EOD per schedule): net worth, day/period change, bucket status, drift vs IPS, staleness report, pending approvals, milestone nags.
- **FR-51** Weekly deep report: signal review, watchlist changes, recommendation pipeline, suppressed-action log.
- **FR-52** Quarterly: RSU reconciliation prompt, scorecard (Section 13), bond/credit review, screener CSV refresh prompt.
- **FR-53** Annual: IPS review, funded-status vs FI band, step-up execution reminder, fiscal-year tax pack.
- **FR-54** Event-driven alerts: vest events, loan closure events, cap breaches, staleness blocks, circuit-breaker trips — within one sync cycle of detection.
- **FR-55** Paper mode (Section 13): a global flag under which the full pipeline runs, recommendations are logged and scored, and execution is structurally impossible.

---

# 6. ANALYSIS / RECOMMENDATION ENGINE SPECIFICATION

## 6.1 Instrument universes
- **Core instruments (allocation engine):** the held index funds/ETFs, PPFC, gold ETF/FoF, liquid/arbitrage/debt funds, EPF (read-only).
- **Satellite watchlist:** ~40 Indian stocks, curated at setup and revised quarterly. Fundamentals come from the owner's quarterly screener.in CSV export (Section 8.3); price data daily from free EOD sources.
- **MF universe:** direct plans; data from AMFI NAV feed + INDmoney MCP fund-detail tools.

## 6.2 Signal stack — satellite stocks
Composite score in [0,100]; a recommendation requires score ≥70 (HIGH ≥85, MEDIUM 70–84) AND passing the quality gate.

1. **Quality gate (binary, must-pass; from screener CSV):** ROCE >15%; positive FCF in ≥4 of last 5 years; D/E sane for sector (default <1, financials exempted with sector logic); zero red flags (promoter pledging >5%, auditor resignation, SEBI action).
2. **Valuation (30% weight):** P/E and EV/EBITDA vs own 5-year history (z-score) and vs sector median; earnings yield vs 10-year G-sec.
3. **Trend (30%):** 6- and 12-month relative strength vs Nifty 500; price above/below 200DMA. Purpose: never buy quality in freefall.
4. **Earnings direction (20%):** consensus/guidance revision trend where available from the CSV; delivery vs guidance.
5. **Fit (20%):** post-trade portfolio effect — cap headroom, sector balance, bucket alignment.

## 6.3 Signal stack — mutual funds (switch/entry logic)
Ranked on: 3Y/5Y rolling-return consistency vs category (percentile of rolling windows, NOT point returns) 40%; expense ratio 20%; manager tenure/change events 15%; AUM bloat for small/mid strategies 15%; style drift vs mandate 10%. A switch recommendation additionally requires: exit-load clear, tax impact computed (FR-41), and expected improvement > estimated switch cost.

## 6.4 Allocation engine
Monthly: compute actual vs IPS strategic allocation (3.3) including Fidelity NOW and EPF. Band breach (±5%) → rebalance recommendation, direction-aware and tax-aware (prefer directing new SIP flows over selling; prefer harvesting losses/exempt gains when selling is needed). Annual April rebalance regardless.

## 6.5 Sell/exit triggers (evaluated monthly per holding)
1. Thesis falsification condition met (satellite).
2. Red-flag event (gate criteria) at any time.
3. Hard-cap breach (11).
4. 12-month total-return underperformance vs the thesis benchmark stated at buy time, sustained 2 consecutive quarters.
5. Tax-aware better-alternative swap (satellite only, ≤1/quarter, must clear costs + taxes with margin).
6. Legacy cleanup queue (3.9).
7. Credit rule failure (3.8) for bonds.

## 6.6 Alternate generation
For every primary: Alternate 1 = same intent, different instrument (e.g., different stock scoring next-best, or index-route instead of satellite); Alternate 2 = different intent (e.g., "do nothing and redirect to drift repair", or debt/prepayment alternative). Each alternate carries the full FR-11 payload. Ranking rationale stated in one paragraph.

## 6.7 LLM usage in the engine
Deterministic code computes all scores, caps, taxes, and screens. The LLM (Claude): synthesizes theses and counter-arguments from computed evidence, drafts digests, performs weekly qualitative review (news/context) and event interpretation. The LLM may never originate a number that feeds a rail or a score; it narrates and reasons over computed facts. Model tiers: SMALL/daily = current Sonnet-class; LARGE/weekly+events = current Opus-class (exact model IDs: build-time item).

---

# 7. APPROVAL WORKFLOW SPECIFICATION

## 7.1 States
```
DRAFT → PENDING_APPROVAL → {APPROVED | MODIFIED→APPROVED | DEFERRED | REJECTED | EXPIRED}
APPROVED → AWAITING_SESSION → EXECUTING → {FILLED | PARTIALLY_FILLED | BROKER_REJECTED | CANCELLED}
FILLED/PARTIALLY_FILLED → VERIFIED (post-sync reconciliation)
Advisory path: PENDING_APPROVAL → ACKNOWLEDGED → AWAITING_MANUAL_EXECUTION → VERIFIED | ABANDONED
```

## 7.2 Rules and edge cases
1. DRAFT is created only if all rails pass (FR-30) and data is fresh (FR-31).
2. PENDING_APPROVAL carries the full FR-11 payload + editable fields (FR-21). Telegram inline buttons; "Show alternates" swaps the card.
3. MODIFIED re-validates rails with new parameters; a modification that violates a rail is refused with the specific rail named.
4. DEFERRED re-surfaces on the chosen date with refreshed data; if refreshed data changes the score below threshold, the agent says so and recommends withdrawal.
5. Expiry: market orders EOD; SIP/MF changes 7 days (FR-22).
6. AWAITING_SESSION: approval message includes the Kite login deep-link; owner completes OAuth+TOTP; app exchanges request_token→access_token; only then EXECUTING. If no session by expiry → EXPIRED with notification.
7. Idempotency: every order carries a UUID tag; before placement the agent checks existing orders for the tag; retries reuse the tag (FR-23).
8. Partial fill at session end → owner notified with options (leave GTT/limit for next day per broker capability | cancel remainder | market-complete next session).
9. BROKER_REJECTED → reason surfaced verbatim + agent's interpretation + options. Never auto-retry a rejection.
10. Market closed / halted → order queues as AMO only with explicit owner opt-in per order, else waits.
11. `/freeze` at any point cancels PENDING/AWAITING states.
12. Every transition is an audit row with timestamp, actor (owner/agent/broker), and payload snapshot.


---

# 8. DATA ARCHITECTURE

## 8.1 Sources, cadence, cost

| Data | Source | Cadence | Cost | Notes |
|---|---|---|---|---|
| Zerodha holdings/positions/orders | Kite Connect Personal API (or Kite MCP read tools) | Daily EOD + on execution | ₹0 | No market data on Personal tier |
| Indian EOD prices (all instruments incl. watchlist) | NSE bhavcopy (official daily EOD file) | Daily post-close | ₹0 | Primary price feed for signals |
| MF NAVs | AMFI daily NAV feed | Daily | ₹0 | |
| MF metadata/analytics | INDmoney MCP (`get_mf_funds_details`, category tools) | Weekly/on-demand | ₹0 | |
| INDmoney portfolio | INDmoney MCP (`networth_snapshot`, `networth_holdings` per asset_type, `networth_allocation_breakdown`) | Daily | ₹0 | Zerodha-linked rows lack invested amounts — handle per FR-02 |
| Fundamentals (watchlist ~40 names) | Owner's quarterly screener.in CSV export upload | Quarterly (agent prompts) | ₹0 | 10-minute owner task; parsed by agent |
| RSU/Fidelity | Modelled schedule (seed: Section 2.4) + owner quarterly confirmation | Quarterly reconciliation | ₹0 | No retail API exists |
| USD/INR | Free FX source (e.g., RBI reference rate) | Daily | ₹0 | For NOW valuation + FA |
| Corporate actions (watchlist + holdings) | NSE announcements/bhavcopy adjuncts | Daily scan | ₹0 | Splits/bonuses must adjust lots |
| News/context for weekly LLM review | Web search in LLM step | Weekly | LLM cost | Qualitative only |

**Budget rule:** total data cost = ₹0 in v1. The v1 accepted limitation: fundamental coverage limited to the watchlist; full-market screening deferred until a paid feed is unlocked (owner: revisit in 2–3 years). Paid Kite data (₹500/mo) only if a future IPS-compliant strategy needs intraday — none currently does.

## 8.2 Staleness engine
Every datum row carries `as_of` + `source`. Freshness policy: prices 24h (trading days); NAVs 48h; fundamentals 1 quarter; FX 48h; portfolio syncs 36h. Violations: block affected recommendations (FR-31), badge the digest, and open a data-incident item. Feed-down behavior: after 2 consecutive failed syncs of any source, an explicit alert (never silent degradation).

## 8.3 Storage schema (Supabase Postgres — minimum tables)
`snapshots` (portfolio point-in-time, JSONB + normalized children) · `holdings` / `lots` (FIFO, incl. seeded history) · `instruments` (masters incl. watchlist flag) · `prices_eod` · `navs` · `fundamentals` (per screener upload, versioned) · `fx_rates` · `rsu_grants` / `rsu_vests` (PROJECTED/ACTUAL) · `loans` / `loan_schedule` · `buckets` / `bucket_flows` · `milestones` · `ips_versions` (full text + diff + effective_at) · `recommendations` (full FR-11 payload, score breakdown, IPS citations, benchmark-at-creation) · `approvals` (state machine log) · `orders` (broker refs, idempotency tags) · `scores` (post-hoc evaluation rows) · `incidents` (staleness, breaker trips, rail refusals) · `settings_rails` (with cooling-off timestamps) · `audit_log` (append-only, every state transition).

Backups: weekly automated `pg_dump` to a private GitHub repo (encrypted) via the Actions runner. Supabase free-tier pause risk is mitigated by daily cron writes; a weekly keep-alive ping is also required.

---

# 9. INTEGRATION SPECIFICATIONS (honest per platform)

## 9.1 Zerodha — full loop (read + execute)
- **Tier:** Kite Connect **Personal** app (free). Provides order placement, GTT, holdings, positions, funds, margins, and Coin MF orders (`place_mf_order`). Provides NO market data — prices come from bhavcopy (8.1).
- **Session mechanics:** access tokens expire daily. Design: **human-in-the-loop unlock** — the approval flow embeds the Kite login link; owner completes OAuth + TOTP on phone (~15s); redirect returns `request_token`; backend exchanges for the day's `access_token`; approved orders execute. No stored TOTP secrets, ever. Read-only daily syncs use Kite MCP or cached data and do not require the unlock.
- **Static IP constraint:** NSE retail algo framework requires a registered static IP for API order placement. Phase-3 default: **deep-link bridge** — approved order opens pre-filled in the Kite app for one-tap manual placement (zero infra, compliant, adequate for ≤4 actions/month). Upgrade path: static IP from the owner's ISP (ACT) + a small local execution service. Exact registration mechanics: build-time verification.
- **MF:** new SIPs and MF orders on Coin folios via API; the three-folio Nifty index duplication is consolidated by directing all new flows to a single Coin folio.

## 9.2 INDmoney — advisory-only (verified: no public order-placement API)
- Read via MCP tools (8.1). All US-stock and INDmoney-folio actions follow the advisory path (FR-25): instruct → owner executes in-app → verify on next sync → nag T+2/T+7.
- Design explicitly for this asymmetry; never present INDmoney actions as executable.

## 9.3 Fidelity / ServiceNow RSUs — modelled
- No retail API. Vest schedule modelled from the seeded grant table; quarterly reconciliation prompt with optional statement upload (PDF parse) to true-up. Sell-on-vest recommendations are advisory instructions with verification nags. NOW price and USDINR from free feeds for valuation.

## 9.4 Telegram — the channel
- Bot API (free). Digests, alerts, approval cards with inline buttons, `/freeze`, `/unfreeze`, `/status`, `/networth`, `/pending`, typed-reason capture for the behavioral protocol. Webhook or polling from the backend; webhook preferred (Vercel route).

## 9.5 Groww — none
One legacy position (Reliance Power ₹2.6k) surfaces once in the cleanup queue as "close manually"; no integration.

---

# 10. TAX ENGINE REQUIREMENTS

1. **Regime context:** new regime, 30% slab; no home-loan interest deduction (strengthens prepayment-vs-invest math — encode in the credit rule and any prepay-vs-invest comparison).
2. **Equity (Indian):** STCG (≤12mo) and LTCG (>12mo) at prevailing rates with the ₹1.25L annual LTCG exemption; grandfathering logic for any pre-2018 lots if seeded (owner likely has none — confirm during seeding). All rates parameterized in config, verified at build time (Section 15), never hardcoded in logic.
3. **Debt/bonds/liquid:** slab taxation; coupon income at slab; listed-bond capital-gain rules per holding period — parameterized.
4. **US stocks:** holding-period rules for LTCG, slab STCG; dividend withholding (25% treaty) tracked for Foreign Tax Credit; **TCS on LRS** modelled on any new remittance recommendation (threshold + rate parameterized, verify at build).
5. **Schedule FA:** annual export of foreign holdings (Fidelity + INDmoney US) with acquisition, peak, and closing values in INR per prescribed conversion rules — ClearTax-ready.
6. **FIFO lots** everywhere; corporate actions adjust lots; every sell shows per-lot gains (FR-41).
7. **Harvest planner** (FR-42) integrated with the legacy cleanup calendar.
8. **Outputs:** fiscal-year capital-gains CSV/XLSX + FA export + a plain-language annual tax summary. Audience: owner + ClearTax self-filing; no CA-grade opinions, and the tax engine states it computes estimates, not filings.

---

# 11. SAFETY RAILS AND KILL-SWITCH SPECIFICATION

All rails live in `settings_rails`, are enforced pre-draft in deterministic code (never LLM-evaluated), and are editable only by the owner with a **48-hour cooling-off**; rail-loosening edits are refused outright while portfolio drawdown >15%.

1. **Single order value:** ≤ ₹1,00,000.
2. **Tactical deployment:** ≤ ₹50,000/month (existing/recurring SIPs excluded; vest-month allowance auto-raises by that month's confirmed vest amount for sell-on-vest redeployment).
3. **Blacklist (absent code paths, not toggles):** F&O, intraday products, penny stocks (market cap < ₹500 Cr), unlisted instruments, crypto.
4. **Concentration caps:** per IPS 3.5, enforced pre-draft and monitored daily post-trade.
5. **Circuit breaker:** 3 consecutive approved recommendations whose falsification conditions trigger → report-only mode until owner `/reset_breaker` (with a mandatory post-mortem note generated by the agent).
6. **Kill switch:** `/freeze` — immediate; cancels pending approvals; halts drafting; notifications continue; `/unfreeze` requires typed confirmation.
7. **Staleness blocks** per 8.2.
8. **Calibration duty:** every recommendation carries conviction + the strongest counter-argument (FR-11); the quarterly scorecard (13) measures calibration; systematic overconfidence is itself a breaker-review trigger.
9. **No catch-up:** code-level property — funded-status is unreadable by any sizing/risk function (FR-16).

---

# 12. TECHNICAL ARCHITECTURE, STACK, HOSTING, SECURITY

## 12.1 Stack (owner-confirmed)
- **UI:** Next.js (App Router) on **Vercel Hobby** — approval detail views, dashboards, IPS viewer, audit browser. Telegram remains the primary interaction surface; the web UI is the deep-inspection surface.
- **Scheduler + jobs:** **GitHub Actions** scheduled workflows (free) — Vercel Hobby cron is once-daily with loose timing, insufficient for market-hours scheduling; Actions provides sub-daily schedules at ₹0. Jobs call Vercel API routes or run scripts directly (Python/Node): sync, signal compute, LLM steps, digest dispatch. Accept 5–15 min schedule drift (irrelevant for an EOD-signal investor).
- **State:** **Supabase free tier** (Postgres) — schema per 8.3. Daily writes + weekly keep-alive prevent free-tier pause.
- **Channel:** Telegram Bot API.
- **Brain:** Anthropic API — Sonnet-class daily, Opus-class weekly/event (6.7). Expected ₹1,500–3,000/month; this is the system's only recurring cost.
- **Contingency (owner-accepted):** if the serverless trio hiccups, migrate scheduler+jobs to an always-on local machine active 08:00–16:00 IST; architecture must keep jobs stateless-scripted so this migration is config, not rewrite.

## 12.2 Schedules (IST; express as UTC cron in Actions)
- 08:45 trading days: pre-open digest (uses prior EOD data).
- 17:30 trading days: EOD sync (bhavcopy + AMFI + Kite/INDmoney), signal refresh, drift check, staleness audit, alerts.
- Sunday 10:00: weekly deep review (Opus step), watchlist review, pipeline grooming.
- Quarterly/annual jobs per FR-52/53. Market-hours awareness: NSE holiday calendar table maintained in DB.

## 12.3 Security model
- Single-user auth on the web UI (passkey or OAuth with allowlist of one).
- Secrets (Kite API key/secret, Anthropic key, Telegram token, Supabase service key) in GitHub Actions secrets + Vercel env vars; never in the repo; never in the DB.
- No stored broker passwords or TOTP secrets — the human-in-loop unlock is the security model.
- Telegram: bot locked to the owner's chat ID; all commands ignored from any other ID.
- Audit immutability: append-only tables with RLS denying update/delete.
- Backups per 8.3; restore procedure documented and tested in Phase 2.

---

# 13. EVALUATION AND BACKTESTING REQUIREMENTS

1. **Paper mode first:** 4 weeks minimum of full-pipeline paper operation (FR-55) before any live order drafting. Gate to Phase 3 = owner review of the paper scorecard.
2. **Benchmark at creation:** every recommendation stores its benchmark when created — satellite stocks: Nifty 500 TRI; MF switches: category average; allocation moves: the IPS-weighted composite; do-nothing alternates are scored too.
3. **Scoring:** at 3/6/12 months per recommendation: return vs benchmark, falsification status, and whether owner modifications/rejections added or subtracted value (measures the human too).
4. **Calibration:** conviction levels vs realized hit-rates, reported quarterly; HIGH conviction must outperform MEDIUM over trailing 12 months or the conviction model is flagged.
5. **Demotion rule:** satellite sleeve underperforming its benchmark by >3% annualized over any rolling 12 months → satellite frozen to index-only pending an owner-reviewed post-mortem.
6. **Backtesting (bounded, honest):** signal components may be sanity-tested on historical EOD data, but the PRD explicitly warns: no paid history feed exists in v1, survivorship-clean data is unavailable, and backtest results are directional only — never a marketing number. The primary evaluation instrument is the forward paper/live scorecard, not backtests.
7. **Shutdown criterion (owner-agreed philosophy):** an advisory agent that cannot beat "index the core, prepay debt, do nothing else" after 24 months of scored operation should be simplified back to that baseline.

---

# 14. PHASED BUILD PLAN (definition of done per phase)

**Phase 0 — See clearly (week 1).**
Supabase schema; Kite + INDmoney read sync; Fidelity vest model seeded from Section 2.4; loan/surplus curve model; Telegram bot with daily digest; IPS v1 stored and rendered.
*DoD:* owner receives a daily digest showing total net worth including NOW and EPF, bucket balances, and drift vs IPS — verifiably matching broker apps ±1%.

**Phase 1 — Think (weeks 2–4).**
EOD price pipeline (bhavcopy) + AMFI; watchlist seeded (~40 names) + first screener CSV parsed; signal engine + scores; staleness engine; recommendation objects with full FR-11 payload; paper-mode logging; weekly Opus review job.
*DoD:* first weekly report contains ≥1 fully-formed paper recommendation (primary+2 alternates) citing IPS clauses, with all data timestamps shown; a deliberately stale price provably blocks a recommendation.

**Phase 2 — Prove (weeks 5–8, paper clock running).**
Approval workflow full state machine (Telegram cards, modify/defer/substitute); rails engine + `/freeze`; audit trail complete; scoring engine; legacy cleanup program generated as paper recommendations (smallcase wind-down, zoo consolidation with LTCG calendar, bond review, Sep-2026 maturity routing); backup/restore tested.
*DoD:* 4 clean weeks of paper operation; owner completes ≥5 approval-flow interactions end-to-end in paper; scorecard renders; a simulated rail violation and breaker trip both behave to spec.

**Phase 3 — Act (gated on paper review).**
Kite Connect Personal execution path with human-in-loop unlock and idempotency; deep-link bridge as placement default; tax engine v1 (lots seeded, LTCG budget, ClearTax exports); ₹50k cap + breakers armed; emergency-fund routing executed at the Sep-2026 bond maturity; advisory verification loops (INDmoney/Fidelity) live.
*DoD:* first real approved order placed and VERIFIED with correct audit trail; replayed approval provably does not double-order; FY capital-gains export opens correctly in ClearTax workflow.

**Phase 4 — Steward (quarterly rhythm, ongoing).**
RSU reconciliations; house-fund (B2) glide path activation as vests accumulate; education corpus (B4) activation ~2028; annual IPS review flow; calibration + demotion live; static-IP execution upgrade if/when the deep-link bridge annoys.
*DoD:* two consecutive quarters of scorecards + reconciliations delivered on schedule without owner-initiated fixes.

---

# 15. OPEN RISKS, ASSUMPTIONS, AND BUILD-TIME VERIFICATION ITEMS

## 15.1 Verify at build time (facts that may have changed)
1. Kite Connect Personal: current capabilities, free status, Coin MF order support, and the exact static-IP registration procedure with Zerodha under the NSE retail algo framework.
2. Paid Kite tier pricing (₹500/month as of Aug 2026) — only relevant to the deferred upgrade.
3. INDmoney: re-confirm absence of any order-placement API; re-confirm MCP tool names/shapes used in 8.1.
4. Anthropic model IDs and per-token pricing for the Sonnet/Opus tiers; set the monthly spend alert at ₹3,000.
5. All tax parameters: STCG/LTCG rates, ₹1.25L exemption, debt taxation, US holding-period rules, TCS-on-LRS threshold and rate, Schedule FA conversion rules — load into config from current law.
6. Vercel Hobby and GitHub Actions current limits (cron cadence, function duration, Actions minutes).
7. Supabase free-tier pause policy and limits.
8. Telegram Bot API unchanged for inline-button approval flows.
9. NSE bhavcopy URL/format and AMFI NAV feed format.
10. Term insurance (₹2 Cr) and health top-up market pricing when the milestone nag is acted on.

## 15.2 Standing assumptions (owner-confirmed; revisit annually)
1. RSU refreshers at $20k/year granted, 4-year vests; maintain a no-refresher downside scenario.
2. YouTube income ₹0; wife's income ₹0 — both upside-only until changed.
3. 12% nominal equity CAGR / 6% inflation as planning assumptions; sensitivity bands ±3% must exist in projections.
4. 10% salary/SIP step-up annually (owner commitment).
5. Child ~2028; ₹10k/month dent; education corpus ₹1 Cr real at 18.
6. Hyderabad purchase ₹2–2.5 Cr window 2033–35; Kolkata flat permanently out of scope.
7. Loan cascade executed as planned; home loan dead Dec 2033.

## 15.3 Known risks and mitigations
1. **Owner behavior under stress** — mitigated by B3, protocol 3.10, and event-only SIP stops; residual risk accepted.
2. **Employer concentration (salary + RSUs + group insurance all = ServiceNow)** — mitigated by 10% NOW cap, sell-on-vest, M1/M2 milestones; job-loss >3mo is a defined SIP-stop event.
3. **Free-data fragility** (bhavcopy/AMFI format changes, MCP changes) — staleness engine guarantees loud failure; contingency stack accepted.
4. **LLM error** — contained by design: LLM narrates, deterministic code decides; rails are code-enforced; approval gate is human.
5. **Scope creep toward sharing/advice** — Section 4.1 is a hard boundary; any future second user requires SEBI RIA analysis before a single line of code.
6. **Sammaan/Edelweiss credit risk pre-maturity** — Sep-2026 maturity is near; the 2029/2033 papers are first-session review items under rule 3.8.
7. **Static-IP friction at Phase 3** — deep-link bridge default removes it from the critical path.

---
*End of PRD. Builder: everything above is settled unless listed in 15.1. Build Phase 0 first; it is independently valuable.*
