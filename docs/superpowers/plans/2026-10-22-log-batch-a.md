# Meaningful /log, batch A: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. Every subagent runs on Opus (owner rule).

**Goal:** The owner can log four new kinds of entry on `/log`, and every Sentinel number stays right afterwards:
- a sale they made;
- a spend;
- an earmark between goals or into a Planned-spending pot;
- a reversal of a mistaken entry.

**Architecture:**
- **Balances:** one reversal-aware balance reader, `src/domain/bucket-balances.ts`, is used by every module that sums `bucket_flows`.
- **New log domain:** the new log uses live in `src/domain/owner-log.ts`. Reversal lives in `src/domain/reversals.ts`.
- **RSU quantity:** the RSU share count follows logged sales.
- **Web:** `/log` gains the forms and a Reverse action.

**Tech Stack:** TypeScript, vitest + PGlite, postgres-js/Supabase, Next.js 15 `web/`.

**Spec:** `docs/superpowers/specs/2026-10-22-log-batch-a-design.md`, owner-approved 2026-10-22. **§7 overrides §3 where they differ**, notably §7.6, which replaces §3.3's RSU-backed earmark rule.

## Global Constraints

- **Money:** branded `bigint` paise only. Rupee text converts with the route's existing `paise()`. An unknown is null, never ₹0.
- **Every new row:** carries `as_of` and `source = 'owner-web'`.
- **Every new table:** has `sentinel_append_only()` triggers for UPDATE, DELETE and TRUNCATE, and RLS enabled with **no policy**. Use the same do-block pattern as `migrations/0034_owner_sips.sql`.
- **Dates:**
  - "Today" is the IST date (`istDate` from `src/domain/sips.ts`).
  - An entry date may not be in the future.
  - "This month" is the IST month.
- **Validation:** lives in the domain. The web route only parses.
- **Logged events and the normal plan:**
  - No logged sale, spend or earmark changes the monthly free envelope, sizing amounts, or the advisor. The envelope is budget − SIPs − set-aside − (BUY orders + owner purchases).
  - The one deliberate exception is spec §7.1: SP is held back from tradeable cash and from the cash ceiling, exactly as B3 is.
- **Firewall:** the normal plan never reads goal status. `tests/architecture/no-catch-up.test.ts` stays green. `bucket-balances.ts` must not import `goal-plan.ts`, `funded-status.ts` or `buckets.ts`.
- **Reversible entries:** only those written after this ships. Each new write stores the written row's id in its audit payload.
- **The `Db` interface:** `{ query<T>(sql, params?): Promise<T[]>; exec(sql); withTransaction<T>(fn); close() }`.
  - PGlite returns `date`/`timestamptz` as `Date`; postgres-js (production) returns strings. Select `::text` where exactness matters.
  - `bucket_flows.id` is a uuid; select `id::text`.
- **Tests:** never edit an expected constant or widen a band to turn a test green. Derive expected values from fixture rows. Mutation-check every guard.
- **Commits:** local only, never pushed. Messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. **Reversal followed by re-logging an SIP payment for the same fund-month.** This must succeed: the unique constraint is gone, and the domain enforces one non-reversed payment (Task 2).
2. **Reversing an earmark into SP after part of it was spent.** This is refused, and the refusal names the spend (Task 2).
3. **Selling more RSU units than are held.** This is refused (Task 4).
4. **A spend from SP with two open labels.** The spend reduces only the chosen label (Task 3).
5. **SP money and the advisor.** SP money never appears as cash available to invest (Task 1).

---

### Task 1: Schema and the reversal-aware balance reader

**Files:**
- Create:
  - `migrations/0036_log_batch_a.sql`
  - `src/domain/bucket-balances.ts`
  - `tests/domain/bucket-balances.test.ts`
- Modify:
  - `src/domain/buckets.ts` (`bucketStatuses` reads balances through the new reader);
  - `src/domain/goal-plan.ts` (the FI deduction and the house, emergency and education balances use the new reader; the FI deduction also subtracts SP);
  - `src/domain/sizing-input.ts:21` and `src/domain/rails.ts:437` (hold back B3 **and SP** through the new reader);
  - `src/seed/seed.ts` (seed the SP bucket);
  - `tests/db/immutability.test.ts`.

**Migration 0036:**
- Replace `buckets_id_check` so that `id in ('B1','B2','B3','B4','SP')`. Verify the actual constraint name in the PGlite test before relying on it.
- Insert bucket `SP`: name 'Planned spending', mandate 'Cash set aside for a known expense; not invested', target null, `target_note ''`. Use `on conflict do nothing`.
- `owner_sales(id bigserial pk, sold_on date not null, instrument_id text not null references instruments(id), units numeric check (units is null or units > 0), proceeds_paise bigint not null check (proceeds_paise > 0), destination text references buckets(id), note text not null default '', as_of timestamptz not null, source text not null check (source <> ''))`
- `log_reversals(id bigserial pk, entity text not null, entity_id text not null, reason text not null check (length(reason) between 1 and 500), as_of timestamptz not null, source text not null, unique (entity, entity_id))`
  - `entity` is one of `'bucket_flow' | 'owner_purchase' | 'owner_sip_payment' | 'owner_sale' | 'earmark' | 'spend'`.
- `bucket_flows` gains a nullable `label text` column for SP labels.
  - The table is append-only by trigger. Adding a column is DDL and allowed, but confirm the triggers don't block it.
- Drop the `owner_sip_payments` `(instrument_id, month)` unique constraint (spec §7.5).
- Append-only triggers and RLS on both new tables.

**Interfaces (Produces):**
- `loadBucketBalances(db: Db): Promise<Map<string, bigint>>`. It returns the sum of `bucket_flows.amount_paise` per bucket, excluding rows reversed by a `log_reversals` row with `entity='bucket_flow'` and `entity_id = bucket_flows.id::text`. A bucket with no rows is absent from the map.
- `loadSpLabels(db: Db): Promise<{ label: string; balancePaise: bigint }[]>`. These are the open SP labels: balance > 0, non-reversed rows only.

- [ ] **Tests, red first:**
  - A reversed flow is excluded from balances.
  - SP is held back by `loadSizingInput` cash and by the cash-ceiling check, the same as B3 (Review Focus 5).
  - The FI corpus in `loadGoalTracker` subtracts SP. Derive the expected value from the fixture.
  - The new tables refuse UPDATE, DELETE and TRUNCATE.
  - The SP bucket exists after migration.
  - **Mutation check:** drop the reversal exclusion, and the first test must go red.
- [ ] Implement. Run `pnpm vitest run tests/domain tests/db tests/architecture` and `pnpm exec tsc --noEmit`. Commit.

---

### Task 2: Reversal

**Files:**
- Create `src/domain/reversals.ts` and `tests/domain/reversals.test.ts`.
- Modify:
  - `src/domain/owner-log.ts`: `logGoalMove` and `logPurchase` store the written row id in the audit payload as `rowId`, and the timeline shows reversed entries;
  - `src/domain/owner-sips.ts`: `recordSipPayment` stores `rowId`, and the duplicate check counts only non-reversed payments for the same fund and IST month, inside the transaction;
  - `src/domain/sips.ts`: owner purchases in `loadMonthSpend` and the owner-SIP-payment readers skip reversed rows.

**Interfaces (Produces):**
- `reverseEntry(db, r: { entity: ReversalEntity; entityId: string; reason: string }, now: string): Promise<void>`:
  - Validates the reason (1–500 characters, trimmed).
  - Validates that the entry exists and was written by the owner (`source` starts with `owner-`).
  - Refuses an entry that is already reversed.
  - **Groups:** an earmark or a sale with a destination reverses all its flow rows. Group membership comes from the audit payload's `rowIds`.
  - **Negative balances:** refuses if any affected bucket's balance after reversal would be below zero. The error names the latest non-reversed flow on that bucket that must be reversed first, with its date, amount and note (spec §7.4).
  - Writes `log_reversals` rows plus one audit row (`entity 'reversal'`, action `'REVERSED'`, payload `{ entity, entityId, reason, rowIds }`) in one transaction.
- `isReversed(db, entity, entityId): Promise<boolean>`.
- `TimelineEntry` gains `reversible: { entity; entityId } | null` and `reversed: { on; reason } | null`.

- [ ] **Tests, red first:**
  - A reversed purchase leaves the month spend.
  - A reversed goal move leaves the bucket balance.
  - Review Focus 1: reverse an SIP payment, then record a new one for the same fund-month, and it succeeds. A second non-reversed payment for the same fund-month is still refused.
  - Review Focus 2: an earmark into SP of ₹2.5L, then a ₹1L spend; reversing the earmark is refused, and the message names the spend.
  - Reversing twice is refused.
  - Reversing a sync or seed row is refused.
  - Entries written before this change are not reversible (no `rowId`).
  - **Mutation checks:**
    - drop the negative-balance guard, and Review Focus 2 must go red;
    - drop the non-reversed filter in the SIP duplicate check, and Review Focus 1 must go red.
- [ ] Implement. Run tests/domain, tests/db, tests/architecture and tsc. Commit.

---

### Task 3: Earmark and spend

**Files:** modify `src/domain/owner-log.ts` and `tests/domain/owner-log.test.ts`.

**Interfaces (Produces):**
- `logEarmark(db, e: { on: string; from: 'FI' | 'B2' | 'B3' | 'B4' | 'SP'; to: 'FI' | 'B2' | 'B3' | 'B4' | 'SP'; amountPaise: bigint; label?: string; expectedOn?: string; note: string }, now)`
  - `from !== to`.
  - `to === 'SP'` requires a label (1–80 characters). `from === 'SP'` requires the label of an open SP pot.
  - **Coverage:**
    - A bucket source must have a non-reversed `bucket_flows` balance ≥ the amount. RSU value does not count (spec §7.6).
    - For an `FI` source, the FI corpus from `loadGoalTracker(db, nowIso).fiPots` must be known and ≥ the amount. An unknown corpus refuses with "FI corpus is unknown".
  - **Rows:** writes −X on a bucket source and +X on a bucket destination (kind `'earmark'`, label set on SP rows). FI writes no row.
  - **Audit:** one audit row, entity `'earmark'`, with payload `{ rowIds, from, to, amountPaise, label }`. Its id is the earmark's reversal key.
- `logSpend(db, s: { on: string; amountPaise: bigint; purpose: string; from: 'B2' | 'B3' | 'B4' | 'SP' | 'BANK'; label?: string; note: string }, now)`
  - The purpose is required (1–120 characters). `from === 'SP'` requires an open label.
  - The bucket balance must cover the spend; for SP, the label's balance must cover it.
  - **Rows:** a bucket source writes −X (kind `'spend'`, label on SP). `BANK` writes no flow.
  - **Audit:** one audit row, entity `'spend'`.
- The timeline describes both:
  - "Earmarked ₹X from FI to Planned spending: Himachal trip";
  - "Spent ₹X on Himachal trip (from Planned spending)".

- [ ] **Tests, red first:**
  - FI→SP earmark: the SP label opens and the FI corpus drops by X.
  - B2→B3 writes two rows.
  - An over-balance earmark or spend is refused, and the refusal names the balance.
  - Review Focus 4: with two labels, a spend reduces only the chosen one.
  - A label closes at ₹0.
  - SP→FI releases leftover money.
  - A `BANK` spend writes no flow.
  - The envelope (`loadFreeEnvelope`) is unchanged by an earmark or spend.
  - **Mutation check:** drop the coverage check, and the over-balance test must go red.
- [ ] Implement. Run tests/domain, tests/architecture and tsc. Commit.

---

### Task 4: Sale

**Files:**
- Modify:
  - `src/domain/owner-log.ts` (add `logSale`);
  - `src/domain/networth.ts` (`loadPositions`: a holding whose surviving row has source `manual-seed` has its quantity and value reduced by non-reversed `owner_sales.units` with `sold_on` ≥ that row's `as_of` date, pro rata on value);
  - `src/domain/goal-plan.ts` (the RSU quantity applies the same reduction).
- Tests: `tests/domain/owner-log.test.ts`, `tests/domain/networth.test.ts`, `tests/domain/goal-plan-tracker.test.ts`.

**Interfaces (Produces):**
- `logSale(db, s: { on: string; instrumentId: string; units: number | null; proceedsPaise: bigint; destination: 'B2' | 'B3' | 'B4' | 'SP' | null; label?: string; note: string }, now)`
  - **Units:** required for kind `RSU` or `EQUITY`.
  - **Selling more than held:** refused for manual-seed holdings, where the held count is the quantity after earlier sales (Review Focus 3). Synced holdings have no such check, because the feed is authoritative.
  - **Destination:** a goal destination writes a +proceeds flow (kind `'sale'`, label if SP) in the same transaction.
  - **Audit:** an `owner_sales` row plus an audit row, entity `'owner_sale'`, with payload `{ rowId, rowIds }`.
  - **Bond redemptions** stay on their existing form. `logSale` refuses `BOND` with "use the bond redemption form".

- [ ] **Tests, red first:**
  - Selling 10 of 78 `US:NOW` shares into B2:
    - the house RSU quantity is 68;
    - B2 flows rise by the proceeds;
    - the positions value of `US:NOW` scales to 68/78.
  - Reversing that sale restores 78 and removes the flow.
  - Review Focus 3: overselling is refused.
  - A `BOND` sale is refused.
  - A synced holding is not adjusted.
  - The envelope is unchanged.
  - **Mutation check:** skip the sale adjustment, and the 68-share test must go red.
- [ ] Implement. Run tests/domain, tests/notify, tests/architecture and tsc, then the full suite once. Commit.

---

### Task 5: Web /log forms, Reverse, Overview Planned spending

**Files:**
- `web/app/api/log/route.ts`: actions `sale`, `spend`, `earmark` and `reverse`.
- `web/app/log/log-form.tsx`: three forms.
- `web/app/log/page.tsx`:
  - a Reverse control with a reason, behind a confirmation that shows what is undone;
  - reversed entries struck through with "reversed on <date>: <reason>";
  - badges for the new kinds;
  - the sale form hint "Log an RSU sale once the money reaches your Indian bank".
- `web/lib/data.ts`: `getLog` supplies open SP labels, bucket balances and sellable holdings.
- `web/app/page.tsx`: a line on the Overview Goals card, "Planned spending ₹X (Himachal trip ₹Y, …)", shown only when open labels exist.
- `web/lib/product.ts`: the log row's `works` and `missing` lists.
- Test: `tests/web/log-shape.test.ts`.

Use the `ui-ux-pro-max` skill against `design-system/sentinel/MASTER.md`. Use only the `web/lib/ui.tsx` primitives and the existing form styles. API errors are shown verbatim.

- [ ] **Tests, red first:**
  - Getter shape: open labels, the reversible and reversed flags on timeline entries.
  - Unknown values render as `unknown`.
- [ ] Run tests/web, the full suite, both typechecks, and `pnpm --dir web build` with `DATABASE_URL` unset.
- [ ] Update PENDING.md (tick batch A; close the RSU double-count owner true-up), MEMORY.md (the bucket-balances contract, SP, the reversal rules) and index.md. Commit.

---

**Release:** whole-branch review, then one squashed commit. Apply migration 0036 to production before the push, through the Supabase MCP, after showing the owner the SQL. The owner runs `git push origin main`.
