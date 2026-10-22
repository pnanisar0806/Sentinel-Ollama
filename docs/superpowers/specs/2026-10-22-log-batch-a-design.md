# Meaningful /log, batch A: design

Status: builder-checked; for owner approval · 2026-10-22.
Owner-approved list (2026-10-15): batch A = **2 a sale or redemption I made**, **5 a withdrawal for spending**, **6 earmark money**, **13 correct a mistaken entry by reversal**. The owner opted out of questions ("just write the design"), so every behaviour below that the owner did not state is marked *my call*.

## 1. Intent

`/log` is how the owner tells Sentinel what happened outside it. Today it records goal moves, a bond redemption, a purchase, a milestone and a note. Several real events have no honest home:

- Selling RSU shares and moving the money to the house or emergency fund.
  - The goal tracker double counts this today. The 78-share quantity is a manual-seed row nobody updates (open owner true-up).
- Spending part of the Sammaan money on the Himachal trip (₹2.5L planned, exact after 2026-12-31).
  - This money sits in bank cash, which counts toward FI. So FI looks ₹2.5L richer than it is.
- Moving money between goals, e.g. part of the house money to the emergency fund.
- Correcting a typo in a logged row.
  - Every log table is append-only, so a wrong row stays wrong forever.

Success: after logging any of these, every number Sentinel shows is right without the owner editing the database. That covers goal cards, FI, the monthly envelope and the timeline.

## 2. Non-goals and anti-goals

**Non-goals:**
- No capital-gains tax computation.
- No order creation: logging a sale is a record, never advice and never an order.
- No editing or deleting of rows.
- No change to how the normal plan sizes.

**Anti-goals** (the feature fails if any of these happens):
- A logged sale or spend changes this month's free envelope. The envelope is budget − SIPs − set-aside − spent purchases; sales and spends are neither.
- A reversal deletes or updates a row. Reversal is a new row; the original stays visible, struck through.
- A sold RSU share still counts toward the house after it is logged.
- An unknown amount is stored or shown as ₹0.

## 3. The four uses

### 3.1 Use 2: a sale or redemption I made

**Form:**
- the holding (picker over current positions);
- date (not in the future);
- units sold (optional for MFs, required for RSU and stocks);
- amount received in ₹ (required);
- where the money went:
  - "stayed in my bank";
  - "into a goal" (House, Emergency, Education, or Planned spending, §3.3);
- note.

**Effects:**
- A new append-only table `owner_sales(id, sold_on, instrument_id, units numeric null, proceeds_paise > 0, destination text null, note, as_of, source)`, with an audit row.
- **Destination is a goal:** the same transaction writes a `bucket_flows` row `+proceeds` into that goal, with kind `'sale'`. The audit row links the two.
- **Manual-seed holdings:** for a holding whose latest row is a manual seed (no live feed, e.g. `US:NOW`), positions and the goal tracker subtract the units sold on or after that seed row's `as_of`.
  - The value shrinks pro rata. The goal tracker uses quantity × latest price.
  - This closes the RSU double-count true-up.
  - Synced holdings are left to the next sync, because the feed is the truth there (*my call*).
- **Bond redemptions** keep their existing flow; this form is for everything else (*my call*, so two records cannot disagree).
- **No effect** on the monthly envelope, sizing or the advisor. The proceeds are not budget. Reinvesting them is the batch B "lump sum received" use.

### 3.2 Use 5: a withdrawal for spending

**Form:**
- amount;
- date;
- what it was for (required, short text);
- paid from: "Planned spending" (an earmark, §3.3), a goal, or "my bank, not earmarked".

**Effects:**
- **From an earmark or a goal:** a negative `bucket_flows` row (kind `'spend'`) on that bucket. The balance may not go below zero; the form refuses, naming the balance.
- **From the bank:** a timeline entry only (`owner_spends` audit row). Bank cash is already measured by the balance sync, so nothing else changes.
- **Table:** spends live in `bucket_flows` and `audit_log`. There is no new table (*my call*).

### 3.3 Use 6: earmark money

**Form:**
- amount;
- date;
- from: FI (unassigned money), House, Emergency or Education;
- to: House, Emergency, Education or **Planned spending**;
- a label for Planned spending (e.g. "Himachal trip") and an optional expected date;
- note.

**Effects:**
- **Between goals:** two `bucket_flows` rows in one transaction, `−X` from the source and `+X` to the destination, kind `'earmark'`, sharing one `transfer_id` in the note or audit payload.
- **From FI:** FI is not a bucket. Its corpus is all assets minus the goal buckets, so only the `+X` row is written. FI shrinks by construction.
- **New bucket `SP` "Planned spending"** (a migration seeds the `buckets` row).
  - It is not a goal card and has no target.
  - Its balance is subtracted from the FI corpus like B2–B4.
  - It is spent through use 5.
  - Overview's Goals card shows one line: "Planned spending ₹X (Himachal trip ₹2.5L)", from the labels on its open flows.
- **Earmarking from the house while the house money is RSU shares:**
  - A negative B2 flow is allowed when the house's RSU value covers it: B2 flows + RSU value ≥ 0 after the move.
  - Otherwise the form refuses.
  - *My call.* The rupee amount is fixed; later price moves stay with the house.
- **Shortfall:** the source must cover the amount. For FI this is the FI corpus; for buckets it is their balance. Otherwise the form refuses and names the available amount.

### 3.4 Use 13: correct a mistaken entry by reversal

**Where:** every owner-entered row on the `/log` timeline gets a "Reverse" action. That covers goal moves, purchases, SIP payments, sales, spends, earmarks and notes.

**Form:** a required reason (≤ 500 characters). The confirmation shows exactly what is undone.

**Effects:**
- A new append-only table `log_reversals(id, entity text, entity_id text, reason, as_of, source)`, with `unique(entity, entity_id)`, plus an audit row.
- Every reader skips reversed rows. That covers:
  - bucket balances;
  - FI corpus;
  - month spend (`loadMonthSpend`);
  - owner SIP payments;
  - sale quantity adjustments;
  - Planned spending lines.
- **Grouped entries reverse together:** a sale with a goal destination, and an earmark's two rows, are reversed as one entry. Reversing one row of the group reverses the group.
- **The timeline** shows the original struck through, with "reversed on <date>: <reason>". To fix a typo: reverse, then log the right entry.
- **Scope:** only owner-entered rows (`source` starting `owner-`) can be reversed. Sync rows, seed rows, orders and approvals cannot. A reversal itself cannot be reversed in v1 (*my call*: log the entry again instead).

## 4. Surfaces

- **`/log`:** three new forms (sale, spend, earmark) beside the existing ones, a Reverse action on timeline rows, and timeline badges for the new kinds.
  - Same primitives and form styles as today (`web/lib/ui.tsx`, the `ui-ux-pro-max` skill against `design-system/sentinel/MASTER.md`).
- **`/buckets` and Overview:** goal balances already read `bucket_flows`, so they update by themselves. Planned spending appears as one line, not a card.
- **`web/lib/product.ts`:** the log row's `works` and `missing` lists.

## 5. Constraints

- Money is bigint paise; rupee text converts exactly (the existing `paise()`).
- An unknown is null, never ₹0.
- Every new row carries `as_of` and `source = 'owner-web'`. Every new table has the append-only triggers and RLS with no policy.
- Validation lives in the domain (`src/domain/owner-log.ts` or a sibling), so the web route and any future Telegram path enforce the same rules.
- "Today" is the IST date.
- The firewall test stays green. The FI-corpus change lives in `goal-plan.ts` and reporting code only.

## 6. Left to the builder

Module boundaries, form layout, and whether sale, spend and earmark share one component; test design under the repo's TDD and mutation-check rules.

## 7. Calls made after the builder check (mine, for owner review)

1. **Planned-spending money is not offered for investment.**
   - Sizing (`sizing-input.ts`) and the cash-ceiling check (`rails.ts`) already hold back B3, because emergency money sits in bank cash. They hold back **SP** the same way: the Himachal money is bank cash about to be spent.
   - Both read balances through one shared reader that also skips reversed rows, so a reversal or an earmark is seen everywhere.
   - These modules read bucket balances, which they already do, never goal status. The firewall is unchanged.
2. **Only entries logged after this ships can be reversed.**
   - New writes record the row id in their audit entry. Old entries show no Reverse button.
   - The few older entries (the October HDFC SIP payment and the Zerodha gold purchase) are correct.
   - Notes are not money and are not reversible.
3. **Planned spending is per label.**
   - An earmark into SP names a label, e.g. "Himachal trip".
   - A spend from SP picks one open label.
   - A label closes when its balance reaches ₹0.
   - Leftover money goes back with an earmark to **FI**. FI is now also a destination: it writes only the −X row on the source.
4. **A reversal that would push any balance below zero is refused.** The refusal names the later entry to reverse first, e.g. "reverse the ₹1.2L Himachal spend on 2026-12-28 first". There is no cascading and no negative balances.
5. **SIP payments stay reversible.**
   - The database rule "one payment per fund per month" (`owner_sip_payments`) becomes a domain check: one non-reversed payment per fund-month, inside the write transaction.
   - A migration drops the unique constraint.
6. **Only money already in a goal can be earmarked out of it.** The source's `bucket_flows` balance must cover the amount.
   - House value held as RSU shares cannot be earmarked until the shares are sold and the sale is logged into a goal.
   - So B2 never goes negative and FI's goal deduction stays simple.
   - This replaces §3.3's RSU-backed earmark rule.
7. **Log an RSU sale once the money reaches your Indian bank.**
   - Until the bank balance syncs (daily), FI reads lower by the sale amount for up to a day. The share count drops at once, so the house value stays right.
   - The form says so. No pending-cash state is built.
