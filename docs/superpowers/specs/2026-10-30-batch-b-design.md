# Batch B: lump sums, SIP changes from the feed, monthly SIP advice, budget raise — design

Status: owner-approved 2026-10-30; builder-checked. Follows the fund switch (`2026-10-29-fund-switch-design.md`,
shipped). Batch A is `2026-10-22-log-batch-a-design.md`; its §"no effect" note on sale and bond
proceeds names this batch's lump-sum use. Behaviour the owner did not state is marked *my call*.

## 1. Intent

Four owner situations Sentinel cannot handle today:

1. **Money arrives outside the monthly budget** — e.g. ₹20,691 of Edelweiss bond interest (Oct 2026),
   still uninvested. The owner logs it; Sentinel says where to put it: gold, any fund (held or not), a
   stock if the stock gate allows, or anything else the advisor can propose. Owner, 2026-10-30.
2. **SIPs change in INDmoney** (start, raise, stop, step-up). The daily INDmoney sync already reads
   every active SIP's fund, amount, start date and step-up (`src/sources/indmoney.ts`,
   `src/domain/sips.ts`), so Sentinel should notice changes itself rather than ask the owner to log
   them. Owner: log only what Sentinel cannot see for itself.
3. **SIP advice is only on `/funds`.** The owner wants it also in the report, once a month (SIPs are monthly).
4. **Salary hike.** Hikes vary (mostly 15–20%). After one, the owner raises the ₹50,000 monthly budget
   (SIPs + everything else) himself. The tactical cap (₹50,000, non-SIP buys only) is left alone; it
   does not bind today (budget − SIPs = ₹19,746) and the owner only wants to hear about it when it does.

## 2. Non-goals and anti-goals

**Non-goals:**
- **No separate "raise your total SIP" feature** (e.g. "free money recurred 3 months, raise SIPs").
  Owner, 2026-10-30: free money is invested every month anyway and the advisor decides where. The
  existing `/funds` SIP card keeps suggesting larger or new SIPs (owner, 2026-10-30: "suggest anything
  best for me long [term], not exceeding monthly budget") — but see §5: its total is now capped.
- No salary input, no hike percentage, no automatic or scheduled budget raise, no reminder to raise it.
- No new log form for SIP start/raise/stop/step-up — the feed covers those. "Move a SIP" (shipped)
  stays the only SIP log entry.
- No order, no execution. Lump-sum advice is a suggestion like every other; the owner acts in the
  broker and records it as today (Approvals, or "Purchase outside Sentinel").

**Anti-goals** (failure even if it works):
- A lump sum pushed into one name, or into anything on short-term price evidence. CLAUDE.md "invests
  for the long term" applies unchanged; "keep it in the bank for now" is a valid answer when nothing
  clears the bar, and says why.
- SIP advice weekly: SIPs are monthly, so it is said once a month (§5).
- An unknown shown as ₹0 or as a guessed number (a new fund with no known type, a stopped SIP with
  no known destination).
- The goal-status firewall breached: lump-sum advice is normal plan and never reads goal status.

## 3. Lump sum received

**Log** (`/log`, new tab "Money received", *my call* on the name): amount (₹, > 0), where it came from
(free text, e.g. "Edelweiss bond interest"), date received, optional note. Append-only table with
`as_of`/`source`, triggers + RLS, reversible through `log_reversals` like every `/log` entry; audit row
as batch A.

**Advice:** Sentinel proposes where to invest that amount, using the same rules as the monthly
advisor (fund-mix gaps, asset targets, stock gate, FR-12 hold and its fund/ETF/gold top-up exemption).
**Every eligible destination is open** (owner, 2026-10-30): any held fund, a fund not yet held (via the
index fund chooser or the switch check's challengers), gold, a stock if the stock gate allows, or
"keep it in the bank for now" with a reason.
- **One destination or a split: the advisor decides** (owner, 2026-10-30: "sometimes split is better,
  sometimes one fund"). Today's `runAdvisor` picks one candidate or HOLD/WAIT and `sizeCandidates`
  sizes one tranche, so the lump-sum path needs the advisor to return a split (one or more
  destinations, amounts summing to at most the lump sum) and each part to be sized and approvable on
  Approvals. Each part carries its own reason and falsification condition (FR-11).
- **Scope:** the wider destination set (unheld funds, gold) is for the lump-sum path only in this
  batch; the monthly advisor's candidate set is unchanged. *My call* — the owner asked only about the
  lump sum; widening the monthly plan is a separate decision.
- *My call:* the lump sum is **in addition** to the monthly budget: it does not consume that month's
  budget or the tactical cap. (The owner did not object when this was played back.) The max-order and
  bank-cash-minus-emergency-fund checks still apply to each part.
- **Accounting (*my call*):** a purchase logged under "Purchase outside Sentinel", or an approved BUY,
  can be marked as paid from an open lump sum; it then counts against the lump sum, not that month's
  budget. A partial purchase leaves the rest open. Monthly sizing treats open lump-sum money as
  spoken for (subtracts it from investable bank cash), so the monthly plan does not spend it.
- Shown on `/advisor` as its own "Lump sum" block, separate from the monthly plan, with the amount,
  where it came from, and each destination with its reason. It stays until the owner marks it done
  (approved/executed on Approvals, or a logged "Purchase outside Sentinel" that covers it) or reverses
  the log entry. *My call.*
- *My call:* the advice is produced when the entry is logged (or at the next scheduled advisor run if
  on-demand is impractical — builder states which and the page says when it will appear).
- Sale and bond-redemption proceeds already logged in batch A do **not** become lump sums
  automatically; the owner logs a "Money received" entry for money he wants invested. *My call* — see
  open question Q1.

## 4. SIP changes from the feed

Once a month (§5), Sentinel compares the active SIP feed now against last month's view and lists what
changed:
- new SIP (fund, amount) — e.g. "new SIP: Edelweiss Nifty Next 50, ₹2,000";
- amount changed (old → new; a step-up is labelled as one when it matches the recorded step-up);
- SIP gone — if a logged SIP move covers it, "moved to <fund> (logged)"; otherwise flagged:
  "<fund> SIP stopped — moved anywhere? Log it under Move a SIP", so the switch check stops giving SIP
  advice for it.
- A new SIP in a fund whose fund-mix type is unknown (not in `FUND_TYPE_BY_ISIN` / not classifiable)
  shows "type unknown" on `/funds` and in the report line; it is never dropped from the SIP total.

*My call:* nothing is shown when nothing changed.

## 5. SIP advice: capped at the budget, and a monthly SIP block

**Cap (owner, 2026-10-30).** The SIP card never suggests a SIP total above the monthly budget
(`monthly_budget_paise`, ₹50,000 today). Today the card says its total "can be higher … not yet checked
against" free money; that changes. Existing SIPs are still never cut (`neverCut`); if the suggested
increases would push the total past the budget, the increases are scaled down to fit (*my call*: pro
rata over the increases, ₹100 rounding, remainder to the core fund as today). If current SIPs alone
already exceed the budget, no increase is suggested and the card says so. The card's copy states the
cap. `suggestSips`'s comment that the total is preserved is stale since `neverCut`; fix it.

**Monthly SIP block (owner, 2026-10-30: "SIP is monthly, no point giving it weekly").** Once a month,
in the first weekly report of the IST month, one block lists the month's SIP changes from the feed (§4)
and the SIP advice that is due, linking to `/funds`. "Due" (*my call*): the switch check says "move SIP
to B"; the card suggests starting a SIP in a type with none; or a suggested amount differs from the
current one by at least ₹1,000 or 20%, whichever is larger. Monthly cadence is the de-duplication: an
item still due next month is shown again. No block when nothing changed and nothing is due; a stale feed
says so and retries the next week.

## 6. Budget raise

The budget editor already exists (Overview "Schedule change"; Cleanup for all rails), with the 48-hour
wait and the drawdown refusal. Batch B adds only:
- a warning on Overview (and `/funds` SIP card, *my call*) when the tactical cap becomes the binding
  limit — i.e. cap < budget − SIPs: "Tactical cap ₹X is now below your free money ₹Y — raise it on
  Cleanup?" Owner-approved 2026-10-30.
- The salary-hike step changes the budget only. The cap is never changed alongside it.

## 7. Constraints

- Money in branded paise; every new row carries `as_of` and `source`; unknown ≠ ₹0.
- Append-only + triggers + RLS for any new log table; reversal only via `log_reversals`.
- Normal-plan firewall: nothing here reads goal status (`tests/architecture/no-catch-up.test.ts`).
- Backend and UI ship together (CLAUDE.md): getter in `web/lib/data.ts`, page, `product.ts` row.
- UI via `web/lib/ui.tsx` primitives, `design-system/sentinel/MASTER.md`.
- Migrations applied to prod before deploy.

## 8. Left to the builder

Table and column names; how the monthly SIP diff stores the previous view (existing SIP snapshots vs a
new one); whether lump-sum advice is computed on log or at the next run; small-amount threshold;
report wording; test fixtures from the live 2026-10-30 data (₹20,691 interest, SIPs ₹30,254 incl.
the logged Invesco move).

## 9. Owner answers from the builder check (2026-10-30)

- SIP card keeps suggesting larger/new SIPs, total capped at the monthly budget (§5).
- Lump sum: one destination or a split, advisor decides (§3).
- Lump-sum destinations: held funds as well as new funds, gold, stocks (§3).
