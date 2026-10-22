# Goal tracker and goal plan — design (piece 2)

Status: owner-approved 2026-10-21.
Parent spec: `2026-10-14-sips-goals-advisor-design.md` §2. That section was a sketch; this document supersedes it.

## 1. Intent

The owner opens Sentinel each month to answer one question: **"Am I on track for the house and for FI?"**

The answer must be a plain verdict per goal: on track, or short by ₹X/month or by N years. It must come with what it would take to fix, and with what that fix costs in risk.

Today nothing answers this. Every goal shows ₹0 attributed. The FI band is a reporting number nobody acts on. The advisor is forbidden from looking at goals at all.

## 2. Owner decisions this rests on

| date | decision |
|---|---|
| 2026-10-13 | PRD amendment: the advisor may read goal gaps, but only to produce a **goal plan** shown beside the unchanged goal-blind **normal plan**. The owner picks. |
| 2026-10-13 | The goal plan may raise both the **amount** invested and the **risk** taken (equity above the IPS §3.3 60% ceiling). Every month it does, it must disclose the risk (§6). |
| 2026-10-14 | Layout approved from a mockup: goal cards (target, progress, finish year at current pace, ₹/month needed), then normal plan and goal plan side by side, then "do nothing". |
| 2026-10-21 | Expected nominal returns: equity 12% ±3, debt 7% ±2, gold 8% ±2. Inflation 6%. |
| 2026-10-21 | Crash for the risk disclosure: equity −50%, debt 0%, gold 0%. |
| 2026-10-21 | Goal attribution. All investable assets count toward **FI**: EPF, MFs, ETFs, stocks, bonds, vested RSUs. House, emergency and education count only money moved into them (`bucket_flows`). |
| 2026-10-21 | Target dates: FI 2050 (age 55); house 2033, ₹65L in today's money; education 2046, ₹1Cr in today's money; emergency Dec 2026, ₹6L. |
| 2026-10-21 | The emergency fund is ₹0 until the owner logs an IDFC deposit. |
| 2026-10-21 | **The house is funded mainly from RSU vests, plus bonuses as they arrive.** The ₹50k monthly budget and its yearly raises go to FI. The tracker counts projected future vests, after withholding, toward the house. The owner has not firmly committed to this. House money sits in debt or arbitrage funds (IPS: no equity within 7 years of the purchase). |

## 3. Goals, non-goals, anti-goals

**Goals**
- A goal tracker. One card per goal, showing:
  - target and date;
  - money attributed today;
  - projected value at the date at the current pace;
  - verdict;
  - the extra ₹/month that closes the gap (or, for the house, the shortfall after expected vests).
- A monthly goal plan on `/advisor`, beside the normal plan, with:
  - the extra money per goal and where it goes (asset class and fund);
  - an optional higher-risk route for FI, with full disclosure;
  - the difference from the normal plan.
- The firewall survives in a new form. The normal plan provably still cannot read goal status. Only the goal-plan module can.

**Non-goals (v1)**
- No change to how the normal plan sizes, gates, rebalances or advises.
- No automatic action. Nothing executes, and no budget changes without the owner signing.
- No bonus forecasting. Bonuses count when logged; that log use is in batch A/B.
- No tax modelling of RSU sales beyond the existing withholding assumption (70% net).

**Anti-goals** — the feature has failed if any of these happen:
- The goal plan proposes a sale because a goal is behind. Catch-up is new money or more equity on new money, never selling.
- A goal plan inside the IPS bands looks riskier than it is, or one outside them looks safe.
- An unknown renders as ₹0. Unknown NOW price, unknown FX or no vest data means "unknown", not "on track".
- The normal plan changes because goal status exists.

## 4. Projection method

All projections run in **real terms** (today's money), so targets need no inflation adjustment:
- real return = nominal − 6%: equity 6%, debt 1%, gold 2%;
- the sensitivity bands carry over (equity ±3, debt ±2, gold ±2);
- money stays bigint paise; growth uses integer basis points or micros, never a float on money.

**FI (B1)**
- Starting balance: the investable corpus `funded-status.ts` already uses.
- Monthly contribution: today's ₹50,000 budget, growing **10% a year nominal**, 4% real.
  - *My call.* It matches `sipStepUp` and `salaryStepUp`. The owner's stated aim of ₹1L/month by about 2031 implies ~15%, and the card should say which rate it assumes.
- The return blends the current allocation; new money follows the IPS target mix.
- Target: the FI floor, ₹10.29Cr real (3.5% SWR); the stretch target is also shown.

**House (B2)**
- Balance today: B2's `bucket_flows`.
- Plus **RSU shares already vested and still held**: held quantity × latest `prices_eod` NOW close × latest `fx_rates` USD/INR (owner, 2026-10-21, §12 Q5). No 70% haircut: tax was withheld at vest, so held shares are already net. Capital-gains tax on a later sale is not modelled (non-goal).
- **No projected inflows.** Future vests and refreshers are not counted. Each vest counts once it lands as a held share.
- Growth at the debt real rate.
- Target: ₹65L real by 2033.
- The card shows the shortfall and the ₹/month from the budget that would close it.
- RSU shares counted here are never counted toward FI. The FI projection's contributions are the monthly budget plus EPF only.

**Emergency (B3):** B3's `bucket_flows` against ₹6L by Dec 2026; no growth.

**Education (B4):** inactive until 2028. The card shows "starts 2028; ₹X/month from then to reach ₹1Cr real by 2046" at the equity real rate.

**Verdict per goal:** on track if the projection meets the target at the central assumptions. Otherwise "₹X/month short" (the level monthly addition that closes it) and "reaches the target in YYYY at today's pace". The sensitivity band shows a pessimistic and an optimistic finish year.

## 5. The goal plan (monthly, on `/advisor`)

Computed deterministically. The LLM does not set numbers, as for the normal plan.

1. **More money (always offered when a goal is short):** the extra ₹/month per goal, routed by each goal's mandate:
   - FI to core index equity and gold up to its band;
   - house to debt or arbitrage;
   - education to an equity index from 2028.
2. **More risk (FI only, offered only when more money alone cannot close FI at a stated affordable budget):** the equity share of new money that would close the gap, if it is above the 60% ceiling.
3. Beside both: the normal plan unchanged, and "Do nothing this month".

## 6. Risk disclosure (mandatory whenever the goal plan exceeds an IPS band)

Rendered on `/advisor` and carried into any recommendation or approval it produces:
- which band is broken and by how much (e.g. "equity 68% vs 60% ceiling, IPS §3.3");
- the loss in a 2008-grade crash (equity −50%) in rupees, for both plans;
- the FI year if that crash lands within 3 years, for both plans;
- where any above-budget money would come from.

## 7. The firewall, rewritten not removed

- New module `src/domain/goal-plan.ts`: the only new reader of goal status. It joins the allowlist in `tests/architecture/no-catch-up.test.ts`.
- **New assertion:** no module reachable from the normal plan's entry points (`sizing.ts`, `sizing-input.ts`, `alloc-engine.ts`, `rails.ts`, `notify/report.ts`, `advisor/recommend.ts`) may import `goal-plan.ts`. Mutation-checked.
- IPS §3.2's "catch-up behavior is prohibited by construction" sentence is amended in `src/config/ips-v1.ts` and the PRD, byte-identically (the `ips-verbatim` test). `installIps` writes a new IPS version. CLAUDE.md's hard constraint is rewritten in the same commit as the code, not before.

## 8. Surfaces

- `/buckets` becomes the goal tracker: cards per §4, with assumptions visible and editable only through the existing assumptions file.
- Overview's Goals card shows each goal's verdict line.
- `/advisor` gains the goal plan beside the normal plan (the approved mockup layout).
- `web/lib/product.ts` and `nav.tsx` are updated per CLAUDE.md "backend and UI ship together".

## 9. What signing the goal plan does — owner-approved 2026-10-21
- Signing the **more-money** route proposes a raise of `monthly_budget_paise` (and `tactical_monthly_paise` if it binds) through the existing 48-hour rail change. The normal machinery then sizes and gates as today. No new order path.
- Signing the **more-risk** route records an owner-approved **goal-plan equity ceiling** (e.g. 68%), dated and audited, which the rebalance engine uses instead of 60% for new-money routing only. It never triggers a sale. The ceiling can be revoked in one click.

## 10. Left to the builder

- Module boundaries inside `goal-plan.ts`, the exact projection loop, and card visuals, using the `ui-ux-pro-max` skill against `design-system/sentinel/MASTER.md` and `web/lib/ui.tsx` primitives.
- Test design, under the repo's rules: TDD; a fixture-derived expected value; a mutation check on every guard.

## 11. Calls made after the builder check (mine, for owner review)

1. **No double counting between goals.**
   - FI's starting corpus is all assets, as `funded-status.ts` uses (cash and gold included), **minus** the B2, B3 and B4 balances from `bucket_flows`, **minus** all held RSU (`US:NOW`) shares.
   - Held RSU shares count toward the **house** (owner, §12 Q5), valued at the latest NOW close and USD/INR (no haircut, §4), until the owner sells them and logs the proceeds to B2. Logging moves the money into B2's balance.
   - So a share never jumps from the house card to FI. An unknown NOW price or FX makes the house balance unknown, not ₹0.
2. **The more-risk route ships in v1** (owner-approved §9). The firewall holds this way:
   - The rebalance engine reads a **rail**, `goal_equity_ceiling_pct`. It is owner-signed, audited and revocable, and set only through the existing rail-change path with the 48-hour cooling.
   - The engine never reads goal status. `goal-plan.ts` only *proposes* the value; the owner signing it is what changes the rail.
   - The anti-goal is read as "the normal plan never changes because of goal status *without an owner-signed rail change*".
   - The ceiling applies to new-money routing only, and is never a reason to sell.
3. **Target mix for new FI money:** equity up to the 60% ceiling (or the signed goal ceiling), gold to the middle of its band (7.5%), debt the remainder.
   - Existing holdings are not assumed to move: the projection never sells.
4. **Each goal's ₹/month gap is computed independently and shown as added on top of the current budget.** The goal plan shows the sum.

## 12. Owner answers (2026-10-21)
- **Q1, sustainable monthly investment: no fixed maximum.** The budget varies month to month. The owner sets each month's budget by the end of its first week.
  - *My call:* the "affordable budget" in §5 is the current month's `monthly_budget_paise`. When FI is short, both routes are shown and the owner picks: more money (the extra ₹/month) and more risk (the equity share of new money that closes the gap at the current budget). The disclosure's "where above-budget money comes from" line reads: "a raise you would set in your monthly budget update".
  - Pending owner answer, Q4 below: when the advisor runs relative to the budget update.
- **Q2, EPF: ₹24,632/month into the corpus.** Passbook, Sep-2026 wage month: employee ₹13,135 (12% of ₹1,09,456 EPF wages) plus employer EPF share ₹11,497. The employer's pension (EPS) share, ₹1,638, is a pension, not corpus, and is excluded.
  - *My calls:* the FI projection adds EPF as its own contribution line, growing 10% a year nominal with salary. The EPF balance grows at the debt real rate (1%). That understates the 8.25% EPF rate, which is the cautious direction.
  - Owner, 2026-10-21: **the whole EPF balance counts toward FI**, none toward other goals. *My call:* the EPS pension balance (~₹94k) is not in the EPF holding and stays out: it pays a pension, not a lump sum.
  - The opening balance comes from the synced EPF holding (₹13.54L, close to the passbook's ₹13.65L before interest). Not a new manual input.
- **Q3, RSUs toward the house: "use the already vested amount only".** Refreshers are not counted.
- **Q5, reading (a):** only vested, still-held shares count, and for now all of them count toward the house: 78 shares, ₹11.08L at the 2026-10-20 close (₹14,206.27/share via Yahoo and Frankfurter 94.93). The `US:NOW` holding row is a stale manual seed, so the value is computed from quantity × latest price, never read from that row. They leave FI.
  - The owner may sell some for the emergency fund. No special case: selling and logging the proceeds to B3 moves that money from the house card to the emergency card. Future vests of existing grants (21 vests, Nov 2026 – Feb 2030, ~₹36.3L net) are not projected; each counts once it lands. This supersedes the 2026-10-21 row in §2 that counted projected vests.
- **Q4, advisor timing: yes, hold until the budget update, up to the 7th.** Changes the normal plan's timing only, not its sizing.
  - The monthly advisor is held until the owner confirms or changes that month's budget, or until the 7th (IST) passes, whichever comes first. It then runs at the next weekly report. *My call:* after the 7th it runs on the budget in force; no confirmation is needed.
  - "Confirm" is a one-click "keep ₹X this month" on the budget editor, audited. A change counts once its 48-hour wait ends.
  - A Telegram reminder goes out on the 1st: "Set this month's budget by the 7th."
  - The held line in the report reads "Advisor (YYYY-MM): waiting for this month's budget (until the 7th)". The month stays open, as for the SIP hold.
