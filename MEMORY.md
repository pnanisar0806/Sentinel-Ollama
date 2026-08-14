# Sentinel — durable project memory

Last updated: 2026-08-14. Branch `phase-0`, HEAD `1c96ae8`.
Read this at session start (see `CLAUDE.md`). Update it when a durable fact changes.

---

## Where we are

Phase 0, 17 tasks (1–11, 11A, 11B, 12–15). Plan:
`docs/superpowers/plans/2026-08-12-sentinel-phase-0.md` (committed at `ab91f87`).
Per-task ledger: `.superpowers/sdd/2026-08-12-sentinel-phase-0/progress.md`.

| Task | Subject | Status |
|---|---|---|
| 1 | scaffold + `ASSUMPTIONS` | complete |
| 2 | Db client + migration runner | complete (2 fix rounds) |
| 3 | Phase 0 schema, 16 tables | complete (1 fix round) |
| 4 | money primitives + FX | complete |
| 5 | seed data (real balance sheet) | complete (2 fix rounds) |
| 6 | loan amortization + prepayment cascade | complete, review clean, 44/44 green |
| 7 | investable surplus curve | not started |
| 8 | RSU vest projection | not started |
| 9 | net worth + allocation drift | not started |
| 10 | buckets, milestones, funded status (+ no-catch-up arch test) | not started |
| 11 | source adapters (env, Kite read-only, File INDmoney, FX, writeSnapshot) | not started |
| 11A | INDmoney OAuth: DCR + PKCE + encrypted token store + `pnpm indmoney:login` | not started |
| 11B | MCP client + `RemoteIndmoneySource` | not started — **needs owner OTP+MPIN login** |
| 12 | staleness engine | not started |
| 13 | IPS v1 stored / versioned / rendered | not started |
| 14 | Telegram notifier + daily digest | not started |
| 15 | jobs, GitHub Actions schedules, provisioning checklist | not started |

After task 15: whole-branch review (most capable model) → one fix wave → scoped
re-review → delete SDD workspace → `superpowers:finishing-a-development-branch`.

---

## Owner decisions (do not re-litigate)

- **Runtime: TypeScript everywhere.** One package. Next.js UI + jobs as TS scripts. vitest.
- **Infra: nothing provisioned yet.** No Supabase project, no Telegram bot, no Kite app.
- **Execution: subagent-driven.**
- **INDmoney login: CLI loopback** (`pnpm indmoney:login`, 127.0.0.1 listener) for now —
  not a web button, and not a Next.js dependency in Phase 0.

## Documented scope calls (deviations from a literal PRD reading)

1. **No Next.js UI in Phase 0.** IPS is rendered via Telegram and a `pnpm ips` CLI.
2. **INDmoney sync via OAuth refresh tokens** (revised — see Gotchas). `FileIndmoneySource`
   is demoted to fallback / test double.
3. **Supabase not provisioned.** PGlite locally, identical SQL.

---

## Contracts

### `Db` — `src/db/client.ts` — **THE PLAN'S BRIEFS ARE STALE ON THIS**

The briefs describe a 2-method interface. The shipped one has four. Restate this
verbatim in every subagent dispatch that touches the DB:

```ts
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Executes one or more statements over the simple protocol (DDL / migration files). */
  exec(sql: string): Promise<void>;
  /** Runs fn inside a transaction on a single pinned connection; rolls back if fn throws. */
  withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
```

`openDb(url?)` → PGlite when `url` is undefined or `pglite://`-prefixed, else postgres-js.
postgres-js `withTransaction` is built on `sql.begin()`. Inside the tx wrapper: `query`
passes params, `exec` passes none, `close()` is a no-op, `withTransaction` does not nest.

### Money — `src/money/paise.ts`, `src/money/fx.ts`

`Paise` / `Cents` are unique-symbol-branded `bigint`. Exports: `rupees`, `paise`,
`dollars`, `cents`, `addP`, `subP`, `mulP`, `pctOf`, `formatInr`, `rateMicros`, `usdToInr`.
`parseMinorUnits` rejects sub-paise precision. `mulP` goes through integer micros,
truncating toward zero. `formatInr` does Indian digit grouping (₹2,15,000) and compact
units (₹13.54L / ₹1.24Cr) with exact thresholds at 100000 / 10000000 whole rupees.

### Schema — `migrations/0001_phase0.sql`

16 tables: `instruments, snapshots, holdings, lots, buckets, bucket_flows, milestones,
rsu_grants, rsu_vests, loans, loan_schedule, ips_versions, fx_rates, incidents,
settings_rails, audit_log`. Money columns are `BIGINT`. `holdings.avg_cost_paise` is
deliberately NULLABLE (NULL = unknown cost). Append-only enforced on `audit_log` and
`snapshots` by four statement triggers — UPDATE/DELETE **and** TRUNCATE.

### Planning assumptions — `src/config/assumptions.ts`

Single source of truth for PRD §15.2. Equity CAGR 12% ±3%, inflation 6%, SWR 3.5%/4%,
SIP step-up 10%, RSU refresher $20k/yr over 4 years net 70%, seed USDINR 95.3,
seed NOW price $127.54, child arrives 2028 (−₹10k/mo), FI at age 55, owner born 1995,
FI income floor ₹3L/mo, stretch ₹5L/mo.

---

## Gotchas learned the hard way (each cost a fix round)

- **Multi-statement SQL needs the simple protocol.** Neither driver accepts it through
  the parameterized/extended path. Hence `Db.exec`.
- **postgres-js is a pool.** Raw `begin`/`commit` as separate `sql.unsafe()` calls can land
  on different connections. Transactions must go through `sql.begin()`.
- **Postgres does not fire DELETE triggers on TRUNCATE.** Append-only needs its own
  `before truncate ... for each statement` trigger or the audit trail can be wiped.
- **A NOT NULL test can test nothing.** If the row omits *other* NOT NULL columns, Postgres
  rejects on those first and the test passes regardless. Use real parent fixtures, omit
  exactly one column per negative case, and include a positive control.
- **A guard-rail test that hard-codes both sides catches no regression.** Derive the actual
  side from the real data structure; mutation-check that it goes red.
- **A wide test band hides transcription slips.** An 8%-wide band let a ₹1L error through
  (`555_400` vs the correct `655_400` for SMALLCASE-RESIDUE).
- **INDmoney sync design (corrected).** The earlier reasoning — "a CI runner can't complete
  OTP + MPIN, therefore sync must be file-based" — had a true premise and a false
  conclusion. The runner never logs in; it uses a **refresh token minted once
  interactively**. Verified metadata: issuer `https://mcp.indmoney.com/`, endpoints
  `/authorize` `/token` `/register`, scopes `portfolio:read` `market:read`, grants
  `authorization_code` + `refresh_token`. Read-only is enforced by the token's scope.
- **Kite Connect:** order + account APIs free since Mar 2025; market data ₹500/mo; **static
  IP mandatory for order placement** — a Phase 3 concern only, and the deep-link bridge
  avoids it. Phase 0 is read-only.

---

## All three loans — owner-verified 2026-08-14 from lender portals

Every loan in `SEED_LOANS` now comes from a real statement, and every field reconciles
arithmetically. **These are facts, not estimates — do not "correct" them toward the PRD.**

| | outstanding | EMI | rate | natural end |
|---|---|---|---|---|
| car1 (HDFC …7670) | ₹2,22,006 | ₹13,821 | **7.65%** | Jan 2028 |
| car2 (BoB …8366) | ₹4,68,205 | ₹17,223 | 7.95% | Mar 2029 |
| home (SBI, 2 a/cs) | ₹29,63,143 | ₹24,482 | 7.95% | Dec 2046 |
| **total** | **₹36.53L** | **₹55,526** | | |

car1's rate was wrong in the seed (7.95% → **7.65%**) and its principal was ₹6.50L against
the real ₹8,96,761 (= ₹6,74,755 paid + ₹2,22,006 outstanding, an 84-month loan from Feb
2021). car2's outstanding was ₹4.95L against the real ₹4,68,205; ₹5.50L over 36 months at
7.95% gives exactly the ₹17,223 EMI, confirming a 3-year term ending Mar 2029.

The PRD's ₹36.7L loan total is stale by ₹0.17L. The verified figures win.

**Cascade output with real data**: car1 closes Feb 2028, car2 Sep 2028, home **Dec 2033**,
saving **₹19.23L** — against the PRD's independently stated ~Dec 2033 and ~₹19.3L. The
model never saw either figure.

## Home loan detail — RESOLVED 2026-08-14 from the owner's SBI portal

The loan is **two accounts**, same rate and origination, modelled as one line (amortization
at a shared rate is linear, so the sum behaves identically):

| a/c | sanctioned | outstanding | EMI |
|---|---|---|---|
| …7807 | ₹30,00,000 | ₹29,09,463 | ₹23,988 |
| …8245 | ₹56,924 | ₹53,680 | ₹494 |
| **total** | **₹30,56,924** | **₹29,63,143** | **₹24,482** |

The seeded EMI was already right; the **outstanding was ₹60,857 too high** and the
principal was wrong. Corrected, the natural payoff lands ~Dec 2046 — so the old
`naturalEndOn` of Feb 2047 was also roughly right, and the earlier "Mar 2048" reading was
an artifact of the bad balance alone.

**The portal's "Remaining Tenure" field is stale — do not trust it.** It reads 379 months
on …7807 and 246 on …8245; neither reconciles with that account's own balance, EMI and
rate (379 months at ₹23,988 would require a ₹33.24L balance). Balance + EMI + rate are the
hard facts; derive tenure, never read it.

Corroboration that the model is sound: with real figures the cascade closes the home loan
**Jan 2034** saving **₹19.07L** of interest, against the PRD's independently-stated
~Dec 2033 and ~₹19.3L. Both within 1%, and the model never saw either number.

## Task 6 — resolved by review

The brief's reference `runCascade` was **defective**: it amortized sequentially (a later
loan idle until the earlier closed), which fails its own flat-outflow criterion by
construction — month 1 yields ₹13,821, not ₹55,526 (= 13,821 + 17,223 + 24,482, i.e. all
three EMIs paying at once). The implementer's concurrent rewrite is correct and required.

Verified by executing the shipped code: `freedEmi` accumulates additively (the sum of
*all* freed EMIs, not just the latest), targets the earliest-`cascadeOrder` **open** loan,
and is recomputed each month; steady-state months total exactly ₹55,526.00; closure-month
stubs are capped at `min(scheduled, balance + interest)` so nothing overpays. `openLoan`
is fixed at the *start* of the month, so redirection correctly begins the month **after** a
closure — that is why the two stub months dip below ₹55,526. Closures: car1 → 2028-01-01,
car2 → 2028-10-01, home → 2034-03-01.

That makes four tasks in a row (2, 3, 5, 6) where the plan's reference code contained a
real defect. **Treat the plan's implementation snippets as a sketch, not as truth** —
brief the acceptance criteria and let the implementer derive the code.

## Owner true-up items (need real statements — do not guess)

- ~~Home loan~~, ~~car loan 1~~, ~~car loan 2~~, ~~loans total~~ — **all resolved
  2026-08-14** from lender portals; see the verified table above.
- **Bonds:** line items sum to ₹6.00L against the PRD's stated ₹6.33L bucket — accrued
  interest? ₹0.33L unexplained. **The only remaining data gap.**
- **RSU grants:** per-grant unit split was reconstructed to total 1,105 units; the PRD
  never published the breakdown.
- **Holdings total is exact at ₹47.69L** — EPF 13.54L, MF 11.83L, stocks/ETFs 8.32L,
  bonds 6.00L, savings 1.63L, US basket 1.37L, Fidelity NOW 5.00L.

## Deferred minors (tracked, not blocking)

**Fix-on-touch**: if the task you are running edits one of these files, fix the minor in
the same commit and strike it from this list. Do not let these pile up for the single
end-of-branch fix wave. The "fixes at" column is the expected home, not a hard schedule.

| # | From | Minor | Fixes at |
|---|---|---|---|
| 1 | T6 | `runCascade`'s month-step duplicates `amortize`'s interest / payment / principal math (`src/domain/loans.ts:92–121`) — extract a shared `stepLoan()` | Task 7 (touches this file) |
| 2 | T4 | No negative-amount tests for `formatInr` / `mulP` / `usdToInr`. Verified by trace only | Task 10 (first negative flows) |
| 3 | T1 | 3 `ASSUMPTIONS` keys untested (`childMonthlyDentInr`, `fiIncomeFloor/StretchMonthlyInr`) | Task 8/10, whichever consumes them |
| 4 | T1 | Planning INR values are plain numbers; consumers must convert to bigint paise | same |
| 5 | T2 | postgres-js path has **no** automated test — no live Postgres here | Task 15, provisioning checklist item 2 |
| 6 | T5 | `tests/seed/seed-data.test.ts` MF subtotal test *title* says "1.83L", asserts 11.83L — cosmetic, value correct | final fix wave |
| 7 | T6 | `persistSchedules` does `delete` + N sequential inserts, unwrapped (`src/domain/loans.ts:144–171`) — matches existing `seed.ts` convention, so genuinely cross-cutting | final fix wave |
