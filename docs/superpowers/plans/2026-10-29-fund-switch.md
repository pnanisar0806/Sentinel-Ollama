# Fund Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Log a SIP move on `/log`, and give every held fund two same-category answers on `/funds` — one for its SIP, one for its accumulated units — with index funds compared against same-index peers.

**Architecture:** A new append-only `sip_moves` table, written by `logSipMove` and reversible through `log_reversals`. A new pure-plus-loader module `src/domain/fund-moves.ts` combines the existing active-fund switch check (`evaluateSwitches`), a new same-index comparison for index funds (Nifty 50 candidates added to `index_fund_candidates`), the live SIP feed and `sip_moves` into one `FundMove` row per held fund. `/funds`, the SIP card and the monthly advisor read it.

**Tech Stack:** TypeScript, PGlite/Postgres, vitest, Next.js (`web/`).

**Spec:** `docs/superpowers/specs/2026-10-29-fund-switch-design.md` (owner-approved 2026-10-29).

**Branch:** continue on `fix/sip-suggestions` (already carries the SIP-card fix `46184c2`; ships together).

## Global Constraints

- Money is branded `bigint` paise (`src/money/paise.ts`); never a float, never an unknown shown as ₹0.
- Every new row carries `as_of` and `source`; owner rows use `source = 'owner-web'`.
- New tables: append-only triggers (UPDATE, DELETE, TRUNCATE via `sentinel_append_only()`) + `enable row level security` with no policy.
- Same category only: a challenger is always in the held fund's AMFI category (active) or tracks the same index (index fund).
- Active-fund bar unchanged: `SWITCH_MARGIN` (13.33 on a 100-point scale).
- Index-fund bar: a challenger must be at least **10 bps a year** cheaper (`INDEX_SWITCH_MIN_BPS = 10`).
- Sentinel never suggests cutting or merely stopping a SIP; a SIP answer is only "keep running", "move SIP to B" or "moved to B".
- Suggestions only: no order, approval card or Telegram message.
- `holdings.avg_cost_paise` on a live INDmoney MF row is the fund's **total invested** (`invested_amount`), not per unit (`src/sources/indmoney.ts:326-329`).
- LTCG exemption constant: reuse `LTCG_EXEMPTION_PER_FY` from `src/domain/cleanup.ts`; no rupee tax estimate (purchase dates unknown).
- Normal-plan firewall: nothing here imports goal-plan or reads goal status.
- `Db` interface: restate from `MEMORY.md` § Contracts in every dispatch (briefs are stale on `Db`).

## Review Focus

1. A fund held on two accounts or as a seed `MF:*` sibling plus a live `IND:*` row — expect one row per fund on `/funds`, keyed like `heldFunds` (Task 4 test).
2. A logged move whose "to" fund later appears in the SIP feed — expect the feed amount to win and the "logged, not yet in the feed" label to drop (Task 5 test).
3. A reversed move — expect every effect gone: HDFC back to "keep running"/switch verdict, Invesco row gone from the SIP card (Task 5 test).
4. A held index fund with no expense ratio on record, or no same-index peers — expect "unknown"/"no same-index peers on record", never a move (Task 3 test).
5. A held fund with no invested amount (null `avg_cost_paise`) — expect "gain unknown", never ₹0 (Task 4 test).

---

### Task 1: `sip_moves` table, `logSipMove`, reversal

**Files:**
- Create: `migrations/0039_sip_moves.sql`
- Modify: `src/domain/owner-log.ts` (add `logSipMove`, `loadActiveSipMoves`, timeline entry)
- Modify: `src/domain/reversals.ts` (entity `sip_move`, table `sip_moves`)
- Test: `tests/domain/sip-moves.test.ts`

**Interfaces:**
- Produces:
  - `export interface SipMove { id: string; fromInstrumentId: string; fromName: string; toInstrumentId: string; toName: string; amountPaise: bigint; firstMonth: string /* YYYY-MM */; on: string; note: string }`
  - `export async function logSipMove(db: Db, m: { on: string; fromInstrumentId: string; toInstrumentId: string; amountPaise: bigint; firstMonth: string; note: string }, now?: string): Promise<{ id: string }>`
  - `export async function loadActiveSipMoves(db: Db): Promise<SipMove[]>` — not reversed, newest first.
  - `'sip_move'` in `REVERSAL_ENTITIES`; single-row entity keyed on `sip_moves.id`.

- [ ] **Step 1: Migration 0039** — `create table sip_moves (id bigserial primary key, from_instrument_id text not null, to_instrument_id text not null check (to_instrument_id <> from_instrument_id), amount_paise bigint not null check (amount_paise > 0), first_month text not null check (first_month ~ '^\d{4}-(0[1-9]|1[0-2])$'), note text not null default '', occurred_on date not null, as_of timestamptz not null, source text not null check (source <> ''))`; triggers + RLS as Global Constraints; drop and re-add the `log_reversals.entity` check with `'sip_move'` added; widen `index_fund_candidates.fund_type` check to `('US','NEXT50','NIFTY50')` (used by Task 3).
- [ ] **Step 2: Write failing tests** in `tests/domain/sip-moves.test.ts`:
  - `logs HDFC Mid Cap → Invesco India Mid Cap, ₹3,001 from 2026-11`: `loadActiveSipMoves` returns one row with `amountPaise === 300_100n`, `firstMonth === '2026-11'`; an `audit_log` row (actor `owner`, entity `sip_move`, payload `rowId`) exists.
  - `refuses`: to = from (`'the new fund must differ from the old one'`); a "to" fund in another AMFI category (`'the new fund must be in the same category'`); a second active move from the same fund (`'a move from this fund is already logged; reverse it first'`); amount ≤ 0; `firstMonth` not `YYYY-MM` or earlier than the IST month before `now`; date in the future.
  - `reversal removes it`: `reverseEntry(db, { entity: 'sip_move', entityId: id, reason: 'typo' }, now)` → `loadActiveSipMoves` empty; a new move from the same fund is then accepted.
  - Category for the same-category check: both funds' AMFI category via the same lookup `heldFunds` uses (`metadata->>'amfiCategory'` on the instrument or its canonical sibling); a "to" fund from the switch universe (`loadUniverse` in `src/domain/mf-universe.ts`, instruments `MFU:*`) carries it as `metadata.category`. Unknown category on either side → refuse with `'category unknown for <name>'`.
- [ ] **Step 3: Run** `pnpm vitest run tests/domain/sip-moves.test.ts` — FAIL.
- [ ] **Step 4: Implement** `logSipMove` in one transaction (insert, audit row with `rowId`, mirroring `logPurchase`), `loadActiveSipMoves` (join `log_reversals` on `entity = 'sip_move'`), add `'sip_move'` to `loadOwnerTimeline`'s entity list with text "SIP moved: <from> → <to>, ₹<amount>/month from <Mon YYYY>".
- [ ] **Step 5: Run** the new test plus `tests/domain/reversals.test.ts tests/domain/owner-log.test.ts` — PASS.
- [ ] **Step 6: Commit** `feat: log a SIP move (sip_moves, reversible)`.

### Task 2: `/log` form and API for a SIP move

**Files:**
- Modify: `web/app/api/log/route.ts` (action `sip_move`)
- Modify: `web/app/log/log-form.tsx`, `web/app/log/page.tsx`
- Modify: `web/lib/data.ts` (picker data)
- Test: `tests/web/log-shape.test.ts`

**Interfaces:**
- Consumes: `logSipMove` (Task 1).
- Produces: `getSipMoveOptions(): Promise<{ from: { instrumentId: string; name: string; category: string }[]; toByCategory: Record<string, { instrumentId: string; name: string }[]> }>` in `web/lib/data.ts` — "from" = held MFs with a known category; "to" = switch-universe funds (`loadUniverse`) plus held funds of the same category, minus the "from" fund.

- [ ] **Step 1: Failing test** in `tests/web/log-shape.test.ts`: `getSipMoveOptions` against a seeded PGlite returns HDFC Mid Cap under `from` and Invesco India Mid Cap under `toByCategory['Equity Scheme - Mid Cap Fund']`, and no Flexi Cap fund in that list.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the getter; route case `sip_move` (`rupees` parsed with the route's existing `paise()`); a "Move a SIP" use on `/log` with from → to pickers (to filtered by from's category), amount, first month (`<input type="month">`), note. Reuse batch A form patterns and `web/lib/ui.tsx` primitives; refused inputs show the domain error text.
- [ ] **Step 4: Run** test + `pnpm tsc --noEmit -p web` — PASS.
- [ ] **Step 5: Commit** `feat: move a SIP on /log`.

### Task 3: Nifty 50 index candidates and the same-index comparison

**Files:**
- Modify: `src/sources/index-funds.ts` (`IndexFundType` adds `'NIFTY50'`; slug `'nifty-50-index-funds'`; benchmark `/nifty 50(?! ?next)/i` labelled `'Nifty 50'`; loop over all three types)
- Create: `src/domain/index-switch.ts`
- Test: `tests/sources/index-funds.test.ts`, `tests/domain/index-switch.test.ts`

**Interfaces:**
- Consumes: `IndexFundRow`, `chooseIndexFund` (existing).
- Produces:
  - `export const INDEX_SWITCH_MIN_BPS = 10;`
  - `export function indexChallenger(held: { indmoneyFundId: string | null; expenseRatioBps: number | null }, choice: IndexFundChoice): { challenger: IndexFundRow | null; reason: string }` — pure.

- [ ] **Step 1: Failing tests**:
  - `index-funds.test.ts`: the NIFTY50 benchmark matches "NIFTY 50 TRI" and rejects "Nifty Next 50 TRI"; `recordIndexFundCandidates` stores `fund_type = 'NIFTY50'` rows (extend the existing fake client with a `nifty-50-index-funds` page).
  - `index-switch.test.ts`: held 20 bps, top 9 bps → challenger, reason `"<name> costs 0.09% a year against 0.20%, 0.11 points cheaper"`; held 18 bps, top 9 bps → none (`"cheapest same-index fund is 0.09 points cheaper, short of the 0.10-point bar"`); top is the held fund itself → none (`"already the cheapest eligible Nifty 50 fund"`); held expense unknown → none, `"expense ratio unknown"`; `choice.top === null` → none, `"no same-index peers on record"`. Exactly 10 bps cheaper clears the bar.
- [ ] **Step 2: Run** both — FAIL.
- [ ] **Step 3: Implement.** Held fund's expense ratio: its own candidate row by `indmoneyFundId` (`IND:5536` → `5536`) when listed, else `loadMfMetadata`. `chooseIndexFund` already ranks by cost; the challenger is `choice.top` when it is not the held fund and clears the bar.
- [ ] **Step 4: Run** — PASS. Also `pnpm vitest run tests/jobs/sync.test.ts`.
- [ ] **Step 5: Commit** `feat: Nifty 50 index candidates and same-index switch bar`.

### Task 4: `fund-moves` — two answers per held fund

**Files:**
- Create: `src/domain/fund-moves.ts`
- Test: `tests/domain/fund-moves.test.ts`

**Interfaces:**
- Consumes: `evaluateSwitches` (`SwitchCandidate`), `indexChallenger` (Task 3), `loadActiveSipMoves` (Task 1), `loadSipCommitment` (live SIPs), `heldFunds`, `typeOf`, `LTCG_EXEMPTION_PER_FY`.
- Produces:
  ```ts
  export type SipAnswer =
    | { kind: 'none' }
    | { kind: 'keep'; amountPaise: bigint }
    | { kind: 'move'; amountPaise: bigint; toId: string; toName: string; why: string }
    | { kind: 'moved'; toId: string; toName: string; firstMonth: string; loggedOn: string };
  export type UnitsAnswer =
    | { kind: 'keep'; why: string }
    | { kind: 'move'; toId: string; toName: string; why: string; valuePaise: bigint; investedPaise: bigint | null; gainPaise: bigint | null };
  export interface FundMove { instrumentId: string; name: string; category: string; isIndex: boolean; sip: SipAnswer; units: UnitsAnswer }
  export async function loadFundMoves(db: Db, asOf: string): Promise<{ moves: FundMove[]; ltcgExemptionPaise: bigint }>;
  ```

- [ ] **Step 1: Failing tests** (seeded PGlite, 2026-10-28 live holdings as fixture values):
  - active fund, challenger clears margin, live SIP → `sip.kind === 'move'` and `units.kind === 'move'` with the same `toName`; `gainPaise = value − invested`.
  - HDFC Mid Cap with a logged move to Invesco → `sip.kind === 'moved'`, `firstMonth '2026-11'`; units still judged (`move` to Invesco on the current data).
  - fund without SIP or move → `sip.kind === 'none'`.
  - ICICI Nifty 50 index fund, a 9 bps peer vs held 20 bps → both answers `move`; vs 18 bps → `keep running` / `keep`.
  - invested unknown → `gainPaise === null`, `investedPaise === null`.
  - one row per fund when a seed `MF:*` sibling and a live `IND:*` row both exist.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Index funds = held funds whose `typeOf` is `NIFTY50`/`NEXT50`/`US`; all others use `evaluateSwitches`. A SIP is matched to a fund the way `sipInstrumentKey` does (ISIN/canonical). Invested = latest live row's `avg_cost_paise` summed across accounts; null if any account's is null.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat: per-fund SIP and units answers`.

### Task 5: SIP card and monthly advisor honour logged moves

**Files:**
- Modify: `web/lib/data.ts` (`getSipSuggestions`)
- Modify: `src/domain/fund-mix.ts` (`loadFundCandidates`; `suggestSips` input)
- Test: `tests/domain/sip-suggest.test.ts`, `tests/web/funds-sips-shape.test.ts`, `tests/domain/fund-candidates.test.ts`

**Interfaces:**
- Consumes: `loadActiveSipMoves` (Task 1).
- Produces: `SipInput` gains `logged?: boolean`; `SipSuggestion` gains `logged: boolean`.

- [ ] **Step 1: Failing tests:**
  - `getSipSuggestions` with a logged HDFC → Invesco move and no Invesco SIP in the feed: a MID row for Invesco with `currentPaise 300_100n`, `logged true`; no row sends money to HDFC.
  - same, after a feed snapshot that contains Invesco's SIP: one Invesco row, `logged false`, feed amount.
  - after reversing the move: no logged Invesco row.
  - `loadFundCandidates`: HDFC excluded with reason `'SIP moved to Invesco India Mid Cap Fund'`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** In `getSipSuggestions`, every active move's "from" goes into `leaving` (name = move's "to"); a move whose "to" has no feed SIP is appended to `sips` as a typed input with `logged: true`. In `loadFundCandidates`, exclude a move's "from" before the switch lookup.
- [ ] **Step 4: Run** the three test files — PASS.
- [ ] **Step 5: Commit** `feat: SIP card and advisor follow logged SIP moves`.

### Task 6: `/funds` switch check shows both answers; docs

**Files:**
- Modify: `web/app/funds/page.tsx` ("Switch check" card), `web/lib/data.ts` (`getFundMoves`), `web/lib/product.ts` (`/funds` works/missing)
- Modify: `PENDING.md`, `MEMORY.md`, `index.md`, `.superpowers/sdd/2026-10-29-fund-switch/progress.md` (create)
- Test: `tests/web/funds-moves-shape.test.ts`

**Interfaces:**
- Consumes: `loadFundMoves` (Task 4).

- [ ] **Step 1: Failing test:** `getFundMoves()` returns one row per held fund with `sip` and `units`; a `moved` SIP row renders text containing `'moved to'`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** Columns: Fund · Category · SIP (keep running ₹X / move SIP to B / moved to B from Mon YYYY / no SIP) · Units (keep / move to B) · Gain if sold now (`Money`, or "unknown") · Why. Under the table: "This FY's LTCG exemption: ₹1,25,000. Gains on units held under 12 months are short-term; Sentinel has no purchase dates for funds, so the split is unknown. Decisions are yours; change funds in INDmoney." Design with the `ui-ux-pro-max` skill against `design-system/sentinel/MASTER.md`; reuse `web/lib/ui.tsx`. Remove the "Index funds are not switch-checked" note. Mark the SIP card fix (`46184c2`) and this work in the docs; record migration 0039 as "apply to prod before deploy".
- [ ] **Step 4: Run** full `pnpm vitest run`, `pnpm tsc --noEmit -p .`, `pnpm tsc --noEmit -p web`, `DATABASE_URL= pnpm --dir web build` — all green.
- [ ] **Step 5: Commit** `feat: /funds switch check gives SIP and units answers`.
