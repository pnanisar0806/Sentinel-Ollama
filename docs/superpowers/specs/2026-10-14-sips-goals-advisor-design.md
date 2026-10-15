# SIP tracking, goal tracking and a goal-aware advisor — design

Status: **draft for owner review** · 2026-10-14 · brainstormed with the owner 2026-10-13/14.

Three pieces, built in order, each with its own implementation plan:

1. **SIP tracking** — live SIPs in the database, on Overview, and in every sizing path. *(Specified in full below.)*
2. **Goal tracker + goal plan** — per-goal projection, and a second, goal-aware plan shown beside the normal one. Requires a PRD amendment. *(Designed to the level agreed; its plan comes after piece 1 ships.)*
3. **Funds-first advisor policy** — index funds and MFs by default; single stocks only above a higher bar. *(Designed to the level agreed.)*

Piece 2 depends on piece 1: SIP flows are the contributions a goal projection runs on.

---

## 0. Owner decisions this spec rests on

| date | decision |
|---|---|
| 2026-10-13 | Switched the HDFC Mid Cap SIP to **Invesco India Midcap, ₹3,001/month**, registered on INDmoney, first instalment **November 2026**. ICICI Pru Large Cap and Motilal Oswal Midcap SIPs were already stopped; the units stay held. |
| 2026-10-13 | All SIP step-ups changed from fixed rupees to **10% a year**. INDmoney restarted the three SIPs with a start date of 12-11-2026; the amounts were briefly lowered by mistake and **reverted by the owner on 2026-10-14** (verified against the live feed: ₹14,001 / ₹11,001 / ₹2,251, step-up 10). |
| 2026-10-13 | **Monthly deployment budget ₹50,000**, which the owner will raise each year; target **₹1,00,000/month by ~2031**. |
| 2026-10-13 | **PRD amendment:** the advisor may read goal gaps (`funded_status` and bucket shortfalls) — but only to produce a *second* plan. The goal-blind plan is always produced and shown beside it. |
| 2026-10-13 | The goal plan may raise **both the amount and the risk** (equity above the IPS §3.3 ceiling). Every month it does, it must disclose the risk (§2.4). |
| 2026-10-13 | **Funds first.** No individual stocks unless the case is exceptional. |
| 2026-10-13 | ₹2.5L of the Sammaan redemption (₹3,24,300) is earmarked for a family trip; exact amount known after 2026-12-31. Not modelled — it is bank cash that will be spent. |

Hard constraints this spec does **not** touch: no F&O / intraday / leverage / loan-against-securities; every order needs fresh approval; single user; Kolkata property never an optimisation target; long-term holding and HOLD-as-default.

---

## 1. Piece 1 — SIP tracking

### 1.1 Problem

Sentinel stores no SIP data. The ₹30,254 commitment exists only as prose in `MEMORY.md`. Consequences found 2026-10-13:

- The sizer and the rebalance tranche use the fixed `tactical_monthly_paise` rail (₹50,000), so the September gold recommendation sized ₹50,000 against a real free amount of ₹19,746.
- The allocation engine cannot see ₹30,254/month flowing into equity, a class already at its ceiling.
- Overview cannot show what is invested each month or where it goes.
- `/funds` offers a switch for held funds whose SIP is stopped, with nothing saying so — the owner read that as "the engine thinks these SIPs are active".

### 1.2 Source: INDmoney `mf_sips`

Live MCP tool, same OAuth client and `portfolio:read` scope the holdings sync uses. Verified shape (2026-10-14):

```
mf_sips[] : { name, isin, category, fundType, planType, folio_id,
              active_sips[]: { sip_id, sip_frequency, fund_id, amount,
                               is_step_up_sip, step_up_by, step_up_freq, sip_start_date "DD-MM-YYYY" } }
```

- **Active only.** Stopped, paused and completed SIPs are absent. A SIP registered but not yet mandated may also be absent (Invesco, today).
- **Amounts are rupees as JSON numbers.** Convert through the existing integer path; never through float arithmetic on paise.
- **`step_up_by` has no unit.** It was `1000` for ₹1,000 and is `10` for 10%. See §1.4.
- **Error shape:** the holdings tool answers a throttle with `{error, message}`; assume the same here. An error body, a non-array `mf_sips`, or an unparseable envelope is a **failed step**, never "no SIPs".

### 1.3 Data model — migration `0032_sips.sql`

```sql
create table sip_snapshots (
  id            bigserial primary key,
  as_of         timestamptz not null,
  source        text not null default 'indmoney',
  sip_count     integer not null,          -- 0 is a real, stated answer, distinct from "no snapshot"
  created_at    timestamptz not null default now()
);

create table sips (
  id               bigserial primary key,
  snapshot_id      bigint not null references sip_snapshots(id),
  sip_id           text not null,
  instrument_id    text not null,           -- 'IND:' || fund_id, matching holdings
  isin             text,
  fund_name        text not null,
  fund_type        text,                    -- source's fundType, as given ('Equity', ...)
  category         text,
  frequency        text not null,           -- 'MONTHLY' | ...
  amount_paise     bigint not null check (amount_paise > 0),
  step_up_raw      numeric,                 -- exactly what the source said; NULL if not a step-up SIP
  step_up_kind     text check (step_up_kind in ('percent','rupees','unknown')),
  step_up_inferred boolean not null default false,
  step_up_freq     text,
  start_date       date not null,
  as_of            timestamptz not null,
  source           text not null default 'indmoney',
  unique (snapshot_id, sip_id)
);
```

- **Append-only**, with the repo's standard UPDATE/DELETE/TRUNCATE triggers and RLS, like every other externally sourced table.
- **The latest `sip_snapshots` row is the active set.** A snapshot with `sip_count = 0` means INDmoney said "no active SIPs"; no snapshot at all means *unknown*.
- History is free: a SIP present in one snapshot and absent from the next stopped between them.

### 1.4 Step-up interpretation

- `is_step_up_sip = false` → `step_up_kind` NULL.
- `step_up_by` in (0, 100] → `percent`, `step_up_inferred = true`.
- `step_up_by` > 100 → `rupees`, `step_up_inferred = true`.
- anything else → `unknown`.

Ceiling, stated in the code: a genuine ₹100-or-less rupee step-up would read as a percentage. Upgrade path: use the unit if INDmoney ever exposes one. Overview marks inferred kinds ("10%, inferred") so the guess is visible.

**Projection** (`src/domain/sips.ts`, pure): the amount steps up on each anniversary of `start_date` at `step_up_freq`. Percent step-ups apply to the then-current amount, rounded down to the rupee. An `unknown` kind makes every projected figure for that SIP `null`, and the total `null`. Nothing is guessed.

### 1.5 Sync

- `RemoteIndmoneySource` gains `fetchSips(): Promise<{ rows: SipRow[]; asOf: string }>`, using the same `callTool` envelope handling and fatal-error rules as `fetchOne`.
- `runSync` gains an injected `fetchSips?` and a step named **`indmoney-sips`** placed after the portfolio sources. The step writes one `sip_snapshots` row and its `sips` rows in **one transaction**. A failure goes through the existing `step()` incident path: WARN, then BLOCK on the second consecutive failure.
- `FileIndmoneySource` (the fixture path) has no SIP file. When `fetchSips` is absent, the step is an **explicit skip on stderr**, matching the price and NAV steps. It never reports success.
- `staleness.ts` learns `indmoney-sips` with a **7-day** limit.

### 1.6 Budget and the free amount

- **New rail `monthly_budget_paise`**, default **₹50,000**, added to `DEFAULT_OWNER_RAILS` and `LOOSER_WHEN_HIGHER`. It changes through the existing `proposeRailChange` path: 48-hour cooling, audited, and a raise is a loosening, so it is refused during a >15% drawdown. That is the existing rule, and correct.
- **`src/domain/sips.ts` exports `loadSipCommitment(db, asOf)`** → `{ totalPaise: bigint | null; asOf: string | null; sips: ActiveSip[]; stale: boolean }`. It returns `totalPaise = null` when there is no snapshot or the latest is older than 7 days.
- **`freeEnvelopePaise = min(tactical_monthly_paise, monthly_budget_paise − sipTotal)`**, floored at 0. `tactical_monthly_paise` stays as the outer safety rail.
  - If `sipTotal` is null, the envelope is **null**. Every consumer then withholds with the reason "SIP commitment unknown (last SIP sync: …)". It never falls back to the full budget.
  - If SIPs ≥ budget, the envelope is 0 with the reason "SIPs already use the whole budget".
- **Consumers, all three switched in the same task:**
  1. `sizing-input.ts` → `tacticalBudgetPaise` becomes the envelope. `SizingInput` gains `envelopeReason` so `sizeCandidates` can withhold with that text.
  2. `notify/report.ts` → the rebalance tranche becomes `min(envelope, max_order_paise)`. With a null envelope the rebalance still runs for drift *reporting*, but emits no sized BUY.
  3. `rails.ts` → the `TACTICAL_BUDGET_EXCEEDED` check measures against the envelope. The violation detail names budget, SIPs and envelope.
- **This changes the rule of an order gate.** Each consumer's existing tests must be re-derived from fixtures with SIP rows, not edited to new constants.

### 1.7 Allocation engine

`rebalanceRec` already accepts `FundingRoute { kind: 'sip' }`, but nothing builds one. Today the dilution test counts routes into *other* classes and ignores money flowing *into* the overweight class.

- `report.ts` builds one `'sip'` route per asset class from `loadSipCommitment`, mapping `fund_type`/instrument kind through the existing `classify`.
- **Change in `rebalanceRec`, OVER branch:** net capacity = (load-free dilution routes into other classes) − (SIP inflow into the overweight class itself), floored at 0. With ₹30,254/month of equity SIPs, equity's dilution capacity is honestly reduced. This is the one behavioural change, and the rationale text says so: "SIPs add ₹30,254/month to EQUITY".
- The UNDER branch is unchanged: SIPs into a class already count through `capacityFor`.
- The free envelope replaces `tactical_monthly_paise` as the `fresh-surplus` capacity (§1.6, consumer 2).

### 1.8 Advisor

- `runAdvisor`'s user message gains a `budget` block: `{ monthlyBudget, sipTotal, sipAsOf, freeEnvelope, sips: [{fund, amount, assetClass}] }`. This is context only. The model still cannot state numbers (`FORBIDDEN_NUMBERS` is unchanged), so sizes remain the sizer's.
- `ADVISE_PROMPT_VERSION` → `advise-v2`. The input snapshot already records what the model was shown, so replays stay faithful.
- No change to `advisor-handoff.ts`. `signAdvice` re-sizes against fresh candidates, which now carry the envelope.

### 1.9 Web

The page work follows the `ui-ux-pro-max` skill against `design-system/sentinel/MASTER.md`, using `web/lib/ui.tsx` primitives only.

- **`web/lib/data.ts` → `getSips()`**: active SIPs, total, budget, envelope, next step-up per SIP, snapshot `as_of`, stale flag.
- **Overview (`web/app/page.tsx`) — new card "Monthly investing"**, span-8, beside Goals:
  - Stats: budget · SIPs · free this month · next step-up (month and new total).
  - `DataTable`: fund · asset class · amount · step-up (with "inferred" badge) · next step-up.
  - Empty/unknown states: "No SIP snapshot yet — filled by the daily sync (`indmoney-sips`)". When stale: "SIP data N days old — sizing is paused until it refreshes."
- **`/funds`**: each held fund carries "SIP active ₹X" or "no active SIP". The switch verdict is unchanged. This answers the owner's 2026-10-13 confusion.
- **`/controls`**: `monthly_budget_paise` appears in the existing rail editor (it already lists `DEFAULT_OWNER_RAILS`). Verify; add only if missing.
- **`web/lib/product.ts`**: Overview's `works` gains "live SIPs and the free monthly amount". **`nav.tsx`**: no new page, so no entry.

### 1.10 Tests (TDD; each written red first)

- `tests/sources/indmoney-sips.test.ts` — parses the recorded fixture (`tests/fixtures/indmoney-mf-sips-2026-10-14.json`, captured from the live call). Fatal on an error body, `holding_error`, non-array or unparseable envelope. Rupees→paise exact.
- `tests/domain/sips.test.ts` — step-up kind inference (0, 10, 100, 101, 1000, null). Anniversary projection across Nov 2027 and Nov 2028. An unknown kind makes the projection null. Stale >7 days makes the total null. An empty snapshot gives total 0, not null.
- `tests/jobs/sync-sips.test.ts` — one transaction (a failure mid-insert leaves no snapshot). The incident escalates on the second failure. A missing fetcher is a skip, not a success.
- `tests/db/sips-append-only.test.ts` — UPDATE, DELETE and TRUNCATE refused.
- `tests/domain/sizing-envelope.test.ts` — envelope = min(tactical, budget − SIPs). A null SIP total withholds every BUY with the stated reason. SIPs ≥ budget give 0. **Mutation check:** hard-code the envelope to the budget and the test must go red.
- `tests/domain/alloc-engine.test.ts` (extend) — equity SIP inflow reduces equity dilution capacity, so a case that was `DIRECT_FLOW` becomes `TRIM` when SIPs exceed other-class capacity. Derive the expected value from the fixture rows, not a literal.
- `tests/domain/rails.test.ts` (extend) — `TACTICAL_BUDGET_EXCEEDED` against the envelope.
- `tests/advisor/recommend.test.ts` (extend) — the budget block is present in the request body. The model still cannot supply an amount.
- `tests/web/` — `getSips` shape guard against real rows, following `recommendations-shape.test.ts`.
- `tests/architecture/no-catch-up.test.ts` must stay green: `sips.ts` imports nothing from `buckets.ts` or `funded-status.ts`.

### 1.11 Done means

1. The live sync writes the owner's 3 SIPs today, and 4 once Invesco mandates. Verified against Supabase.
2. Overview shows budget ₹50,000, SIPs ₹30,254 (after Invesco), free ₹19,746, and next step-up November 2027.
3. A fresh sizing run sizes gold at ≤ the free envelope, not ₹50,000.
4. Both typechecks are clean, the full suite is green, `next build` succeeds without `DATABASE_URL`, and production renders `/` and `/funds` with no server errors.
5. `PENDING.md`, `MEMORY.md` (replace the hand-copied ₹30,254 section with a pointer to the table), `index.md` and the ledger are updated in the same commit.

---

## 2. Piece 2 — goal tracker and goal plan

### 2.1 The PRD amendment, and how it is made safe

The rule "`funded_status` is unreadable by any sizing or risk function. No catch-up behavior" (CLAUDE.md; IPS §3.1, `src/config/ips-v1.ts:16`) becomes:

> Goal status may be read by **one** module, the goal plan. The normal plan never reads it. Both plans are produced every cycle and shown side by side; the owner chooses. A goal plan that exceeds an IPS band must disclose the breach and its stress cost every time.

Mechanics:

- **IPS text** — §3.1 sentence rewritten in `ips-v1.ts`. `installIps` records it as a new version automatically, so the old text stays in `ips_versions`.
- **CLAUDE.md** — the hard-constraint bullet is rewritten in the same commit as the code, not before. Until piece 2 ships, the old rule is what the code enforces.
- **Architecture test — rewritten, not deleted.** It becomes two-sided:
  - (a) the allowlist of reachers of `funded-status.ts` / `buckets.ts` = existing reporting modules **+ `src/domain/goal-plan.ts` and its web getter**;
  - (b) **new:** no module reachable from the normal plan's entry points (`sizing.ts`, `sizing-input.ts`, `alloc-engine.ts`, `rails.ts`, `advisor/recommend.ts`) may import `goal-plan.ts`.
  - Mutation-checked both ways: a normal-plan import of `goal-plan.ts` goes red, as does a stale allowlist entry.
- **`NO_CATCH_UP` rail code** — stays in the normal plan's gate. The goal plan's orders pass the same `checkRails` except the IPS-band check, which becomes a *disclosure*, not a refusal (§2.4). Every other rail still refuses: max order, single-stock cap, cash ceiling, staleness, freeze, breaker, hold period.

### 2.2 Goal tracker (reporting, on `/buckets` and summarised on Overview)

Per goal: target, date, balance today, projected value at the date at current contributions, verdict (on track / short by ₹X/month / behind by N years), and the monthly amount needed to land on time.

Inputs:
- SIP projections (piece 1)
- free envelope and budget growth
- `ASSUMPTIONS.equityNominalCagr` (12%) and its ±3% sensitivity band
- inflation (6%)

Balances come from `bucket_flows` as today. FI also reads the investable corpus, as `funded-status.ts` already does.

### 2.3 Goal plan (advisor, `/advisor`)

- **Normal plan:** today's output with the piece-1 envelope.
- **Goal plan:** the extra ₹/month needed per goal, routed by asset class. Equity goes to core index funds per §3.4, the house fund to debt/arbitrage per its mandate. The model still selects and never sizes.
- **The difference is shown**, plus "Do nothing this month" as a third first-class option.
- **If the goal plan needs more than the budget,** it says so and names the shortfall. It never quietly shrinks to fit.
- Signing either plan goes through the existing `signAdvice` → recommendation → approval path. The plan chosen is recorded on the recommendation's `engine_evidence`.

### 2.4 Risk disclosure (mandatory whenever the goal plan leaves an IPS band)

Rendered in the recommendation and the approval request, not only on the page:

1. Which band is broken and by how much (e.g. "equity 64% vs 60% ceiling, IPS §3.3").
2. A 2008-grade crash loss in rupees for both plans.
3. The goal-date cost if that crash lands within 3 years.
4. Where any above-budget money must come from.

### 2.5 Owner inputs piece 2 needs (true-up list)

1. **Expected returns for debt and gold.** Only equity (12%) exists in `ASSUMPTIONS`. No projection of the house fund or the gold sleeve is possible without them. They will not be invented.
2. **The crash depth.** The IPS states the outcome ("60% equity ≈ −25 to −30% portfolio"), not the equity drawdown behind it. Back-solving gives roughly −42% to −50%. The owner should confirm one figure before it is used.
3. **Which holdings count toward which goal.** `bucket_flows` is empty for every bucket. Today the house fund reads `unknown`, not ₹0, and the tracker cannot show progress until money is attributed. Is the owner logging deposits, or should a holding be tagged to a goal?
4. **One date per goal.** House "2033-35", education "~2046". The tracker needs a single target date for each (the early end is suggested).
5. **Is the emergency fund already in the IDFC account?** If yes, log it to B3. That also unlocks the ₹74k leftover decision after the trip.

---

## 3. Piece 3 — funds-first advisor policy

- **Default universe for new money:** index funds/ETFs and the held MFs. The rebalance and goal plans already route equity to core index instruments (`addTarget`, `CORE_EQUITY`).
- **Single stocks:** the satellite path stays but is gated higher. A stock candidate reaches the advisor only if its composite ≥ `BANDS.high` (not `BANDS.medium`) **and** the owner has signed it onto the watchlist (`watchlist-signoff.ts`). Red flags are not assessed by the screen today, so the per-company sign-off is the only review that exists. The advisor prompt states the funds-first rule, and a stock BUY needs a rationale naming why a fund cannot express the same view.
- **Prompt version bump; tests:** a MEDIUM-band stock is no longer offered; a HIGH-band stock is offered with the stricter rationale requirement.
- Recorded in `MEMORY.md` as an owner decision dated 2026-10-13.

---

## 4. Out of scope

- Non-INDmoney SIPs (owner confirmed all are on INDmoney). If one appears elsewhere, add a manual-entry path then.
- Stock SIPs and US SIPs. Both INDmoney endpoints return empty, and the owner has stopped smallcase SIPs.
- Modelling the trip or any spending.
- Changing the SIPs themselves. Sentinel reads them; the owner changes them in INDmoney.

## 5. Housekeeping in this commit

- `.gitignore` adds `.superpowers/brainstorm/`. The SDD ledger under `.superpowers/sdd/` stays tracked.
