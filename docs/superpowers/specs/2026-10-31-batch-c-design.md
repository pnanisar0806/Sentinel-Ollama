# Batch C — holding rules and life events (design)

Owner-approved scope, 2026-10-31 (the defaults offered in chat, accepted as-is; the owner is
already married, so marriage is not an event). Items 9 and 10 of the meaningful-/log plan.

## Intent

Two kinds of standing owner knowledge Sentinel cannot infer and today forgets:

1. **Holding rules** — "I never want more of X", "I am holding Y until 2030". Today the
   advisor can keep proposing a buy the owner has already refused in their head, or propose
   an exit from something they have decided to hold.
2. **Life events** — a salary change, a job loss, a new dependent. Today these live only in
   code constants (`src/config/assumptions.ts`) and the IPS text; nothing tells the owner
   which numbers a real-life change makes stale.

Success: the advisor never drafts advice that breaks a rule the owner has stated, and every
logged event leaves a visible review list of what it touches until the owner closes it.

## Goals

- Four holding rules, each per instrument, each with an optional end date:
  - `NO_ADD` — no new money into X while held (no buy, no top-up, no SIP increase).
  - `HOLD_UNTIL` — do not propose selling X before a date (`until` required).
  - `NO_REBUY` — once X is fully sold, never propose buying it again.
  - `CAP_PCT` — X may not exceed N% of the portfolio (buys that would cross it are refused).
- Rules set from a button on each holding (`/holdings`, `/funds` ranking row) and listed,
  with their end, on `/log` (new tab **Holding rules**). Ending a rule early is a reversal
  (append-only, like every other log entry).
- Six life events on `/log` (new tab **Life event**): salary change, job loss / career break,
  new dependent, inheritance or windfall, retirement-age change, major medical expense
  (the last is IPS's own second stop-event; added because the IPS names it).
- Each event produces a **review list**: the specific assumptions, rails and IPS clauses it
  touches, with today's value. The owner closes each line by signing a new value (where a
  signed rail exists) or marking it "still right". Shown on Overview until every line is closed.
- **Stop rules flag only.** IPS §(drawdown/SIP): "Stop-events only: job loss >3 months;
  medical expense >₹30L." When a logged event meets one, Overview and the weekly report say
  the IPS now *permits* pausing SIPs. Nothing pauses automatically.

## Non-goals

- No automatic change to any number. An event never edits a rail or an assumption by itself.
- No new data sources. Events and rules are owner-typed only.
- Not moving the `ASSUMPTIONS` constants into the database (see "Assumption lines" below).
- No rule types beyond the four. No rules on categories or sectors.

## Anti-goals (failure even if it works)

- A rule that silently hides advice. A suppressed draft must say so where the owner would
  have seen it ("withheld — your HOLD_UNTIL rule on X, until 2030-03").
- An event that reads as a recommendation to act. Job loss must never read as "sell".
- A `HOLD_UNTIL` that hides a red flag. Red-flag and falsification exits still **show**,
  as a warning on the holding, but never become a recommendation (owner's rule wins; the
  owner sees the evidence). *My call — see "Calls I made".*

## Constraints (from CLAUDE.md / PRD, not negotiable)

- Append-only tables with UPDATE/DELETE/TRUNCATE triggers and RLS, like `sip_moves`.
- `as_of` and `source` on every row (`source = 'owner-web'`).
- Money as bigint paise; percentages as integer bps.
- The normal plan never reads goal status. Events touch rails only via the existing
  owner-signed rail path (`rail-values.ts`, cooling-off unchanged).
- Backend and UI ship together: getter in `web/lib/data.ts`, pages, `product.ts`, nav.

## Parts

### Holding rules

- Table `holding_rules` (id, instrument_id, kind, until date null, cap_bps null, note,
  occurred_on, as_of, source). A rule is active when not reversed and `until` is null or in
  the future (IST date). One active rule per (instrument, kind); a second is refused
  ("reverse the existing one first"), same pattern as `logSipMove`.
- `loadActiveHoldingRules(db, now)` in `src/domain/holding-rules.ts`; matching by
  `fundAliases` / `sameFund` so a rule on the seed id reaches the live `IND:*` holding.
- **Enforcement at the single gate.** `gateRecommendation` (every persisted recommendation
  passes it) refuses:
  - BUY / REDIRECT-in of X under `NO_ADD`, or under `NO_REBUY` when X is not held;
  - SELL / TRIM / REDEEM of X under `HOLD_UNTIL`;
  - BUY of X under `CAP_PCT` when (X value + amount) / portfolio total > cap. Portfolio total
    is the same total the sizing input uses; unknown total → refused with "cap unknown".
  The refusal reason names the rule. The order gate in `rails.ts` gets the same check, so an
  order cannot bypass it.
- **Advice that is not a recommendation row** also honours rules:
  - SIP suggestions (`loadSipSuggestions`): a `NO_ADD` fund gets "kept — your rule" and no
    increase; `NO_REBUY`/`CAP_PCT` behave the same for funds not held / at cap.
  - Switch check (`loadFundMoves`): a `HOLD_UNTIL` fund's units answer is "keep — your rule
    until <date>"; the SIP answer is unaffected (moving a SIP sells nothing).
  - Exit candidates (`loadExitCandidates`): `HOLD_UNTIL` turns an exit into a warning.
  - Lump-sum advice: rules apply through the gate.
- UI: a small "Rule" button on each row of `/holdings` and the `/funds` ranking opens an
  inline form (kind as pills like the month picker, until-date, cap %, note). Active rules
  show as a badge on the row. `/log` "Holding rules" tab lists every active rule with
  **End now** (reversal).

### Life events

- Table `life_events` (id, kind, occurred_on, amount_paise null, detail jsonb, note, as_of,
  source) and `life_event_reviews` (id, event_id, item_key, outcome `STILL_RIGHT` |
  `SIGNED`, as_of, source) — both append-only. A line is open until a review row closes it.
- Kinds and their fields:
  | Kind | Fields | Review lines (item_key) |
  |---|---|---|
  | `SALARY_CHANGE` | new monthly take-home | `monthly_budget_paise`, `goal_setaside_monthly_paise`, `salaryStepUp`, emergency-fund target |
  | `JOB_LOSS` | start date, expected end (optional) | emergency-fund runway, `monthly_budget_paise`; **stop rule** after 3 months |
  | `NEW_DEPENDENT` | expected date | `childArrivalYear`, `childMonthlyDentInr`, emergency-fund target, education goal |
  | `WINDFALL` | amount, from | none — it offers "log as Money received" (batch B lump sum), prefilled |
  | `RETIREMENT_AGE` | new FI target age | `fiTargetAge`, fund-mix horizon band (re-proposal) |
  | `MEDICAL_EXPENSE` | amount | emergency fund; **stop rule** when amount > ₹30L |
- **Assumption lines.** `ASSUMPTIONS` values are code constants. Their review line shows the
  current value and two actions: **Still right** (closes it) or **Needs changing** (closes it
  as a dated note in `MEMORY.md`'s owner true-up list via the PENDING workflow — i.e. it
  tells the owner "ask Claude to change `fiTargetAge` to 50"). Rail lines link to the
  existing signed editor and close when a newer signed value exists.
- **Stop rules.** `stopEventsInForce(db, now)`: a `JOB_LOSS` started ≥ 3 months ago with no
  end, or a `MEDICAL_EXPENSE` > ₹30,00,000. Overview shows a Notice; the weekly report adds
  one line: "IPS stop-event in force (job loss since <date>): pausing SIPs is permitted, not
  advised. Sentinel changes nothing." Ends when the owner logs the job loss as ended
  (a dated end, append-only as a second event row referencing the first).
- UI: `/log` "Life event" tab (one form, fields per kind). Overview card **Review after life
  events** listing open lines with their buttons; hidden when none.

### ETF switch check

Not built. `/funds` now says why (no SIP to redirect; selling costs more than the fee saved).
Shipped with this batch's first commit.

## Calls I made (owner, please check)

1. `HOLD_UNTIL` still shows red-flag / falsification evidence as a warning; it only stops
   a sell *recommendation*.
2. Every rule takes an optional end date; `HOLD_UNTIL` requires one.
3. Constants stay in code; an "assumption needs changing" line becomes a true-up item for
   me to change, not a UI edit.
4. Major medical expense added as a sixth event because the IPS names it as a stop-event.
5. Windfall reuses batch B's Money received rather than a new path.

## Left to the builder

Migration number, exact copy, component layout within the existing primitives
(`web/lib/ui.tsx`), test fixtures.
