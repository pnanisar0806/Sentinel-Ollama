# Piece 3 — funds first, a strict stock gate, and a fund mix review — design

Status: **approved by owner 2026-10-23** (plan decisions — headline-only rating downgrade, stocks withheld before a signed mix — approved 2026-10-26) · 2026-10-23 · brainstormed with the owner 2026-10-23.
Supersedes §3 of `2026-10-14-sips-goals-advisor-design.md`. That section stays as the record
of what was first asked; the ledger notes the change.

## 1. Intent

The owner, 2026-10-13: *"i dont want to pick individual stocks now unless it has a very
prosperous future."* 2026-10-23: *"i want to give priority to mutual fund still. stocks will
get less priority … before advising the advisor should consider everything about the stock …
it should be very good and then only i will buy stocks."* And: *"who tells me if this
distribution is correct or good?"*

Three findings from 2026-10-23 drive this design:

- The monthly advisor only ever chooses among **stocks**. Funds get new money only through the
  rebalance, which routes equity to core index funds. Nothing gives funds considered advice.
- A stock is judged on a composite score, a quality gate (ROCE, D/E, 5-year FCF) and 90 days
  of news (the quality gate also fails a known screener red flag). Promoter pledging, promoter holding and management quality are not checked at all.
  Red flags are recorded as "not assessed".
- Nothing says what the fund mix *should* be. The asset-class bands (IPS §3.3), the 75/25
  core–satellite rule (§3.4) and the 35% single-scheme cap exist; a target per fund type does not.
  Today the money is 72% large-cap (Nifty 50 index 58% + ICICI active large cap 14%), mid+small
  about 4%, while the SIPs point 46% Nifty / 36% flexi / 10% mid / 7% small.

## 2. Goals

1. **Funds first in the monthly advice.** The advisor's candidates include held funds, listed
   first; a stock is the exception.
2. **A stock must pass every one of five checks, or it never reaches the advisor.** Any single
   failure is an automatic no. Unknown is a failure.
3. **A fund mix review.** Sentinel proposes a target range per fund type with a written reason,
   flags overlap and cost problems, the owner approves, and `/funds` shows target vs actual.
4. **On approval, suggested SIP amounts per fund** that move new money toward the approved mix.

## 3. Non-goals and anti-goals

- **Not** a separate stock ceiling below the IPS one. The IPS §3.4 split moves from 75/25 to
  **70/30** (§7.1); stocks and mid/small funds share the 30%.
- **Never sells to reach the mix.** Underweight is closed with new money only. Overweight is
  left to shrink as a share. A sale stays the job of the existing sell triggers.
- **No new fund opened by the monthly pick.** Only held funds are topped up. A better fund in
  the same category is the existing switch rule (`mf-switch.ts`), unchanged.
- **Sentinel does not change SIPs.** It suggests amounts; the owner changes them in INDmoney
  and the daily sync reads them back (spec 2026-10-14 §4 still holds).
- **The normal plan stays goal-blind.** The fund mix uses goal *target dates* (horizons), never
  `funded_status`, shortfalls or anything from `src/domain/goal-plan.ts`
  (`tests/architecture/no-catch-up.test.ts` must still pass unchanged).
- Anti-goal: a system that churns between funds month to month. A month with no top-up is a
  correct output.

## 4. Owner decisions (2026-10-23)

| decision |
|---|
| Funds take priority over stocks in the monthly advice. |
| No owner watchlist sign-off is needed for a stock (drops that part of the 2026-10-14 §3). |
| Five stock checks — management quality, debt, promoter pledging, valuation, future growth. **Any single failure is an automatic no.** |
| **Missing data counts as a failure.** Until the Screener screen carries the new columns, no stock passes. |
| Promoter-holding trend: until a year of history exists the check is unknown, so it fails. |
| A stock must also be in the HIGH band (composite ≥ `BANDS.high` = 85). The checks are pass/fail; the score ranks what passes. |
| The monthly fund pick tops up **held** funds only, ranked against their whole AMFI category. |
| **IPS §3.4 amended: core ≥ 70% of equity flows** (was 75%). Mid- and small-cap funds and direct stocks share the non-core 30%. Owner: "i dont need stocks unless they are very good". |
| **Funds before stocks in the same month:** the month's free money goes to a fund below its midpoint; a stock is sized only in a month when every fund type is at or above its midpoint. |
| Sentinel proposes target ranges per fund type with reasons; the owner approves; on approval it suggests SIP amounts per fund. |
| The proposed ranges in §7 look good (owner). |
| For US index and Nifty Next 50 the owner opens new index mutual funds; Sentinel must name the appropriate fund (§8.1). |

## 5. The five stock checks

Each check returns `PASS`, `FAIL` or `UNKNOWN`, with the number and source that decided it.
`UNKNOWN` is treated as `FAIL`. A stock reaches the advisor only with five `PASS`es, a quality
gate pass, composite ≥ 85 and fresh news coverage (today's rule).

| check | fails when | data |
|---|---|---|
| **Debt** | D/E ≥ 1 (today's `QUALITY.maxDeRatio` rule, `engine.ts`). Finance sectors (`FINANCE_SECTORS`) exempt, as today. | Screener upload (have). |
| **Promoter pledging** | pledged share > 0%. | Screener "Pledged percentage" — owner adds the column. |
| **Valuation** | P/E > 1.5 × sector median P/E. **Recomputed daily**: price from `prices_eod`, earnings from the uploaded EPS (12M). The sector median is taken over **every stock in the latest Screener upload** in that sector (not the watchlist alone, which would be a median of 1–3 names). No sector or fewer than 5 peers = `UNKNOWN`. | have, once recomputed daily. |
| **Future growth** | 5-year profit CAGR < 12% **or** 5-year sales CAGR < 12%. Analyst targets (INDmoney) are context for the advisor, never a pass. | Screener upload (have). |
| **Management quality** | any of: (a) a governance event in the last 3 years (auditor resignation, SEBI order, fraud, default, rating downgrade); (b) 5-year cash from operations < 70% of 5-year reported profit; (c) promoter holding down > 5 percentage points over a year. | (a) news + credit-rating filings; (b), (c) Screener columns the owner adds. |

**Governance events (check a):** auditor resignation, SEBI order or penalty, fraud, default or insolvency, pledge invocation, and a credit-rating downgrade announced on BSE. Litigation, clarifications, strikes and Reg 29/SAST filings do **not** count (the news `governance` tag is broader than this list). News is kept for 90 days today, so for a stock that passes the other four checks the builder backfills three years of its BSE announcements (`src/sources/bse.ts`). A failed backfill is `UNKNOWN`. *(Builder-check call.)*

**Universe:** the stocks scored today — the effective watchlist — without any owner sign-off.

**Screener columns the owner adds to the saved screen:** Pledged percentage, Promoter holding,
cash from operations (5 years) and profit after tax (5 years). If Screener offers a one-year
change-in-promoter-holding column, the builder uses it for (c) instead of waiting for a year of
uploads — confirm against the owner's real export, never against documentation.

Every check result is shown on `/advisor` per stock: the five results, each with its value,
threshold and as-of date. A stock that failed shows why, so "no stock this month" is explained.

## 6. Funds in the monthly advice

- **Funds before stocks (owner, 2026-10-23).** The sizer still deploys one tranche a month
  (`sizing.ts`). If any fund candidate exists, it gets the month; stock candidates are listed
  as "not this month — a fund is below target". A stock is sized only when every fund type is
  at or above its midpoint.

- **Candidates:** held funds and ETFs whose fund type has an approved target range, whose
  current share is below the range midpoint, and that pass a quality bar: an **active** fund
  must rank in the top half of its AMFI category (`mf-switch.ts`); an **index** fund or ETF is
  exempt, because the universe deliberately leaves index funds out and they track the same
  index (`mf-universe.ts`). A fund flagged for a switch is not a candidate. *(Builder-check call.)*
- **No news rule for funds.** `contextFor` drops any candidate without fresh news coverage;
  funds take their own path and are never excluded for it.
- **Cap:** a fund top-up obeys the IPS §3.5 single-scheme cap (35% of the liquid portfolio),
  not the 10% single-stock cap. A top-up that would breach it is withheld and the next fund is
  tried.
- **Order:** the fund furthest below its midpoint first. Funds are listed before stocks.
- **Size:** the existing deterministic sizer, unchanged in spirit — the model never states an
  amount.
- **Before a mix is approved** there are no fund candidates and the advisor says so ("no
  approved fund mix yet — approve it on /funds").
- **Prompt:** `advise-v2` → `advise-v3`. It states funds first; a stock BUY must also return a
  `whyNotFund` field. A stock BUY without it is rejected in code, like a reply that states an
  amount.

## 7. Fund mix review

**Fund types:** Nifty 50 index · Nifty Next 50 index · Flexi cap · Large cap (active) ·
Mid cap · Small cap · US index. AMFI's index category does not say which index a fund tracks,
so each held fund or ETF is typed by an explicit table keyed by instrument id (the owner holds
about ten); an untyped fund is shown as "type unknown" and is never a candidate. *(Builder-check call.)*

**Proposed ranges** (share of equity funds), derived from the horizon of the money equity
serves. House and emergency money sits outside equity, so equity serves FI (~2050, 20+ years).
A rule table keyed by years to the goal; the owner approves the numbers, they are not
self-evident:

| fund type | ≥ 15 years | 7–15 years | reason shown to the owner |
|---|---|---|---|
| Nifty 50 index | 35–50% | 50–65% | low-cost core; the anchor |
| Nifty Next 50 index | 0–10% | 0–5% | next 50 largest, cheap |
| Flexi cap | 15–25% | 10–20% | manager can go mid and abroad |
| Large cap (active) | 0% new money | 0% new money | overlaps the Nifty 50 index; held, never topped up |
| Mid cap | 10–20% | 5–10% | long horizon can sit through deeper falls |
| Small cap | 5–10% | 0–5% | same, deeper falls still |
| US index | 5–10% | 5–10% | country diversification (IPS §3.4 core) |

### 7.1 Core ≥ 70% of equity flows (IPS amendment)

IPS §3.4 changes from 75/25 to 70/30, recorded as a new `ips_versions` row (the existing
append-only mechanism, `src/domain/ips.ts`), with the owner's words and date. Core stays Nifty 50,
Nifty Next 50, flexi cap and US index. Non-core is mid cap, small cap, active large cap and direct
stocks. Every place that states or enforces 75% (`alloc-engine.ts`, `allocation.ts`, the IPS text,
`/controls` or any page that quotes it) moves to 70% in the same change.

Arithmetic: the ≥15-year midpoints, normalised, put 77% of new money in core and 23% in mid+small,
leaving about 7% of flows for stocks. At the top of the mid and small ranges (30%) there is no room
for stocks — intended. The SIP tilt in §8 never takes non-core flows above 30%.

**Findings shown with the proposal:** overlap (active large cap vs the Nifty 50 index), cost
(expense ratio against the category), and any fund above the 35% single-scheme cap.

**Approval:** the owner approves the whole range table on `/funds`. It is stored append-only
(`as_of`, `source = 'owner-signed'`), audited, and the latest signed row is in force. The
proposal is regenerated once a year, or when a goal date changes; the old ranges stay in force
until the owner signs new ones.

## 8. Suggested SIP amounts

On approval, and on every later monthly run, `/funds` shows a "suggested SIPs" table: per fund,
current SIP → suggested SIP, and a one-line reason.

- **Total stays the same:** the suggestion redistributes today's SIP total (₹30,254 from
  November); it never raises the budget. The free amount is unchanged.
- **Split:** new money mirrors the range midpoints, normalised to 100%, tilted toward the types furthest below
  midpoint. A type with "0% new money" gets its SIP suggested to zero (no sale).
- **A type with no SIP** (US index, Next 50): the owner will open a new index **mutual fund** for
  each (owner, 2026-10-23) and SIP into it. The suggestion names the fund (§8.1). The ETFs held
  today (Vanguard S&P 500, Nifty Next 50 Junior BeES) are kept, not topped up.

### 8.1 Choosing the new index fund (US index, Nifty Next 50)

A one-off proposal on `/funds`, shown with the suggested SIP. Not part of the monthly pick, which
still tops up held funds only. The owner opens the fund in INDmoney; once the sync sees it, it is
a held fund like any other.

- **Eligible:** Direct plan, Growth option, an index fund tracking the right index (Nifty Next 50;
  for US, a broad US index — S&P 500 or Nasdaq 100 — fund or fund of funds), **accepting fresh
  SIPs** (US funds are often closed to new money under the RBI overseas limit; a closed fund is
  not eligible, and if none is open the proposal says so).
- **Ranked by:** lowest expense ratio, then lowest tracking error, then larger AUM. Each value is
  shown with its source and as-of date; a fund missing any of the three is shown but not
  proposed.
- **Shown:** the top choice and two alternatives, each with its numbers.
- Sources: the AMFI scheme list for names and plans; INDmoney `get_mf_funds_details` / existing
  `mf_metadata` for expense ratio, AUM and tracking error. The builder confirms which source
  carries tracking error; if none does, ranking uses expense ratio then AUM and the page says
  tracking error is unavailable.
- Amounts are rounded to a whole ₹100 (builder may pick the rounding; state it on the page).
- Read-only advice. The owner changes SIPs in INDmoney; the next sync shows the new amounts and
  the suggestion settles. Batch B's "SIP change" log use is separate and unaffected.

## 9. Web (ships with the backend)

- `/funds`: target vs actual per fund type; the proposal with its reasons and findings; an
  approve button; the suggested-SIP table. Before approval the target column says "not set —
  approve the proposal below", never 0%.
- `/advisor`: fund candidates first; per-stock five-check results with values and as-of dates.
- `web/lib/data.ts` getters; `web/lib/product.ts` rows honest about what works and what is
  missing (e.g. "management check needs Screener columns").
- Design against `design-system/sentinel/MASTER.md`, reusing `web/lib/ui.tsx` primitives.

## 10. Constraints

- Money is `bigint` paise. Unknown is `null`, shown as "unknown" or "—", never ₹0 or 0%.
- Every new stored row carries `as_of` and `source`. New tables are append-only (UPDATE,
  DELETE, TRUNCATE triggers) with RLS on and no policy (MEMORY.md RLS posture).
- TDD; each test red first. Tests at minimum: a stock failing any one check is not offered; an
  `UNKNOWN` check blocks; a HIGH-band stock passing all five is offered; a stock BUY without
  `whyNotFund` is rejected; fund candidates exclude unapproved mixes, switch-flagged funds and
  "0% new money" types; SIP suggestion keeps the total; no path sells.

## 11. Left to the builder

Module layout; the exact tilt formula in §8 (must keep the total and never go negative); how
AMFI categories map to fund types; the daily P/E recompute's job placement; the migration
number and table shape for signed ranges.
