# Sentinel — durable project memory

Last updated: 2026-08-17. Branch `phase-0`, Task 8 shipped.
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
| 7 | investable surplus curve | complete, 1 fix round (6 review issues), 61/61 green |
| 8 | RSU vest projection | complete, 1 fix round (FR-03 in SQL), 82/82 green |
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

## Plan audit — tasks 7–15 audited 2026-08-14 BEFORE implementation

**21 findings. Full register:
`.superpowers/sdd/2026-08-12-sentinel-phase-0/plan-audit-findings.md` — read it before
starting any task from 7 onward.** Do not implement a task until its findings are struck.

Five critical, in priority order:

1. **T7** reference test contradicts the plan's own derived value (₹82,124 vs a `< 82,000`
   band) — fails on first run.
2. **T10** the no-catch-up architecture test does **not** enforce the firewall. It greps for
   an import string; passing `fundedRatio: number` as a parameter from an allowed file
   defeats it entirely, as do dynamic imports, double quotes, and any file outside `src/`.
3. **T11** the Kite read-only test forbids only the literal name `placeOrder`.
   `submitOrder()` passes. Needs a full method allowlist.
4. **T11A** `oauth_clients.client_secret` is stored in plaintext while the token table beside
   it is AES-256-GCM encrypted.
5. **T13** requires PRD §3.1–§3.10 **verbatim** (shown to the owner at −20% drawdown, so a
   paraphrase is a product failure) — and §3.2–§3.10 exist in no artifact in this repo.
   **Blocked on the owner supplying the text.**

Two structural ones worth holding in mind: **T15 never wires the OAuth INDmoney source**, so
11A and 11B would be built and then never used; and **T12's staleness engine reads only
`holdings`**, so it may be structurally blind to stale prices, NAVs and FX.

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
SIP step-up 10%, **`salaryStepUp` 10% — separate key from `sipStepUp` on purpose** (equal
today; do not re-merge them), RSU refresher $20k/yr over 4 years net 70%, seed USDINR 95.3,
seed NOW price $127.54, child arrives 2028 (−₹10k/mo), FI at age 55, owner born 1995,
FI income floor ₹3L/mo, stretch ₹5L/mo.

---

## Gotchas learned the hard way (each cost a fix round)

- **PGlite returns `bigint` columns as JS numbers, not strings**, and `date` columns as
  `Date` objects. The plan's own T8 test asserted `net_paise === '900000'` and would have
  failed on that alone. Always widen through `BigInt()`; never compare a bigint column to a
  string literal. (Precision is lost above 2^53 paise ≈ ₹90,000Cr — not reachable here.)
- **PGlite is a SINGLE connection**, so a query issued on the outer `Db` while a
  `withTransaction` is open still lands *inside* that transaction. A test cannot distinguish
  "inside the tx" from "outside" that way — mutation-check transaction wrapping by removing
  `withTransaction` outright, not by moving one statement out of it.
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

**Cascade output with real data** (`runCascade(SEED_LOANS, '2026-09-01')`, re-verified by
execution 2026-08-15): car1 `2028-02-01`, car2 `2028-09-01`, home **`2033-12-01`**, interest
saved **₹19,26,308** (natural ₹31,01,145 − cascade ₹11,74,837) — against the PRD's
independently stated ~Dec 2033 and ~₹19.3L. The model never saw either figure.

**These three dates are the only correct ones.** Two other closure sets appeared in earlier
drafts of this file (Jan 2034 / ₹19.07L, and car1 2028-01 · car2 2028-10 · home 2034-03);
both predate the seed corrections and are wrong. Never write any of them as a literal —
derive from `closures`.

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
**Dec 2033** saving **₹19.26L** of interest, against the PRD's independently-stated
~Dec 2033 and ~₹19.3L. Both within 1%, and the model never saw either number.
(An earlier "Jan 2034 / ₹19.07L" reading here was stale — see the verified block above.)

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
closure — that is why the stub months dip below ₹55,526 (₹41,707 in 2028-02, ₹42,466 in
2028-09, ₹24,307 in the final month 2033-12). **Any consumer asserting flat outflow must
exempt `closures.values()`.** The closure dates written here in an earlier draft
(2028-01 / 2028-10 / 2034-03) were stale; the verified set is in the block above.

That makes four tasks in a row (2, 3, 5, 6) where the plan's reference code contained a
real defect. **Treat the plan's implementation snippets as a sketch, not as truth** —
brief the acceptance criteria and let the implementer derive the code.

## Task 7 — surplus curve

Derived, never hardcoded: **₹82,124/month** investable at Sep 2026
(₹2,15,000 − ₹55,526 loans − ₹77,350 fixed). The PRD's ₹76,000 is *inclusive of existing
SIPs*; the ~₹6,100 gap is its unquantified "+ electricity" line. **Do not tune the model to
hit ₹76,000** — when the owner supplies an electricity figure it goes into
`FIXED_OUTFLOWS.misc` and the test's expected value moves in the same commit.

- Take-home steps up each **April** at `ASSUMPTIONS.salaryStepUp`, not `sipStepUp`, counted
  from **`BASE_TAKE_HOME_AS_OF` = '2026-09-01'** — the epoch the PRD figure is quoted at,
  NOT the caller's `from`. Anchoring to `from` made the same calendar month pay differently
  depending on when the projection started, silently rebasing salary for a later caller.
- Loan release is a consequence of the cascade (home closes 2033-12), never a date literal.
- **`projectSurplus`'s coverage guard is derived from the outflow map's OWN key range**
  (every month at or before `max(keys)` must be present), plus an outright refusal of an
  empty map when `months > 0`. `closures` is kept as an ADDITIONAL tail signal and stays in
  the interface, but **nothing may depend on it being populated**: it is returned only by
  `runCascade` and persisted NOWHERE (`loan_schedule` has no closure column), so a Task 8+
  consumer reading a schedule back from Postgres passes an empty map. Keying the guard off
  `closures` alone made it a silent no-op there and inflated surplus by the full ₹55,526.
- **Never assert the release on annual investable totals.** Take-home compounds 10%/fiscal
  year, so by 2033 two years of growth swamps a ₹55,526 release: a projection where the
  release NEVER happens still shows y2035 > y2033. Assert `loanOutflowPaise` directly.
- **Open, tied to Task 10:** the child dent (₹10k/mo from Jan 2028) has **no end
  condition**. PRD §2.2 ends it at B4 activation; B4 does not exist yet, so a `TODO(Task 10)`
  sits on `childDentFor`. Over the 300-month annual view it runs 22 years and understates
  late-horizon surplus. **Gate it when B4 lands.**
- **`AnnualSurplus.flags` carries three caveats, plus `monthCount`.** `RENT_TO_EMI_FLAG` on
  every row (rent still modelled as rent, no Hyderabad purchase date — narrow it and move
  rent into the cascade when one exists); `CHILD_DENT_NO_END_FLAG` on every year carrying a
  dent (the open-ended dent above, up to ₹1.2L/yr understated); `PARTIAL_YEAR_FLAG` where
  `monthCount < 12`. The head and tail years of a window are partial — from 2026-09 the
  2026 row holds 4 months and the 2051 row holds 8, which unflagged reads as a 3.5x jump
  and a 27% collapse that are pure artifacts. **Any new caveat goes on `flags`**: a consumer
  seeing one flag reasonably concludes it is the only one.

## Task 8 — RSU vest projection

Derived, never hardcoded: **469.375 unvested units / ₹57,05,047.56** (`570_504_756` paise)
at `asOf` 2026-09-01, at $127.54 × 95.3. Working: G2021 and G2022 have fully vested by then;
G2023 2 tranches × 10.3125, G2024 6 × 11.875, G2025 10 × 12.8125, G2026 14 × 17.8125.
**The PRD's ₹53.25L is ~7% lower — that gap is an OWNER TRUE-UP, not a modelling error**
(see the true-up list below). Asserted exactly, so it fails loudly.

- **Tranches are allocated cumulatively**: tranche k gets `floor(T·k/16) − floor(T·(k−1)/16)`
  for units, gross and net alike, so 16 parts always sum back to the whole grant. Rounding
  each tranche independently (the plan's sketch) leaves a projection whose parts need not
  add to its whole. A per-grant reconciliation test asserts parts == whole for all **six**
  seed grants, with a `checked` counter tied to `SEED_RSU_GRANTS.length`.
- **USD prices go through `dollars()`**, never `Math.round(price*100)` — `127.54*100` is
  `12753.999999999998` and `127.545*100` is `12754.500000000002`. A sub-cent price is now
  *rejected* rather than silently rounded.
- **`withRefreshers` skips any year that already carries a real grant**, derived from the
  `grants` argument. Without it `fromYear: 2026` emitted `REFRESH-2026` beside the real
  285-unit G2026 and overstated the pipeline by a whole grant.
- **`confirmVest` recomputes `gross_paise`** from the confirmed units/price/FX (the sketch
  wrote only `net_paise`, leaving the row's implied withholding rate wrong), rejects a net
  above that gross, rejects a **negative** net, units or price (the one-sided `net > gross`
  test accepted `units: 0` with a −₹5L net), rejects an unknown id, and stamps
  `source = 'owner-confirmed'`. The row update and its `audit_log` insert run in ONE
  `withTransaction` — a confirmation with no audit row cannot be back-filled, since the
  table refuses UPDATE. `confirmed_on` is derived from the injectable `asOf`, never
  `current_date`.
- **`persistVests(db, vests, {asOf?})`** — `asOf` injectable so runs are reproducible. No
  `source` override: these rows are always PROJECTED / `'model'`.
- **FR-03 is enforced in the SQL, not in control flow.** `rsu_vests` carries
  `unique (grant_id, vest_on)` (added in `0001` during the T8 fix round — nothing was
  deployed, so there was no migration to preserve), and the write is a single
  `insert ... on conflict (grant_id, vest_on) do update ... where rsu_vests.status <>
  'ACTUAL'`. The original read-then-write was **check-then-act and defeatable**: a
  `confirmVest` landing between the SELECT and the UPDATE lost, and because that UPDATE
  never touched `status` the row was left reading `status = 'ACTUAL'` while carrying the
  model's units, money and `source = 'model'`. A `Db` proxy test drives a real confirmation
  into that window. **Any future check-then-act on an owner-confirmed row is the same bug.**
- **`unvestedValue` sums exactly what it is given.** A projection window that stops short of
  the last tranche understates the pipeline silently — project the full range.
- **Refresher grants have no `rsu_grants` row**, and `rsu_vests.grant_id` is a FK, so vests
  projected from `withRefreshers` output **cannot be persisted**. Scenario input only. The
  `rsu_grants.scenario` column ('ACTUAL'|'REFRESHER') exists for the day they are;
  `RsuGrantSeed` carries no `scenario` field yet.
- **A vest ON the `asOf` date is VESTED**, not unvested: `unvestedValue` filters `vestOn >
  asOf`, strictly. Pinned by a test whose `asOf` is an actual tranche date.

## Owner true-up items (need real statements — do not guess)

- ~~Home loan~~, ~~car loan 1~~, ~~car loan 2~~, ~~loans total~~ — **all resolved
  2026-08-14** from lender portals; see the verified table above.
- ~~Bonds~~ — **resolved 2026-08-14**, see below.

**OPEN (Task 8): the RSU per-grant unit split.** The PRD never published it; the six-grant
breakdown totalling 1,105 units was *reconstructed*. The model's unvested total is
₹57,05,047.56 against the PRD's ₹53.25L — a ~7% gap that is a **data** question, not a
modelling one. **Needs the owner's Fidelity statement** (per-grant units and grant dates).
Nothing was tuned toward ₹53.25L; when the real split arrives, `SEED_RSU_GRANTS` and the
exact assertion in `tests/domain/rsu.test.ts` move in the same commit. **Expect to rework
the test, not just its expected value:** `tests/domain/rsu.test.ts:80-82` uses
`BigInt(totalUnits)`, which throws the moment any grant carries fractional units, and its
per-grant net sum holds only because every `12754 x units` product happens to end in 0.
Both fail loudly rather than silently, which is why they were left as they are.

Otherwise no open data gaps: every figure in `SEED_HOLDINGS` and `SEED_LOANS` is either
owner-verified or explicitly marked as a PRD-stated value.

## Bonds — owner-verified 2026-08-14 from the INDmoney bonds screen

| ISIN | units | coupon | YTM | invested | matures | next coupon |
|---|---|---|---|---|---|---|
| INE148I07GL3 (Sammaan) | 300 | 9.00% | 11.29% | ₹2,84,057.70 | 26-Sep-2026 | 26-Sep-2026 |
| INE148I07TX1 (Sammaan) | 1 | 9.75% | 11.70% | ₹95,941.91 | 23-Jul-2029 | 23-Jul-2027 |
| INE532F07EK1 (Edelweiss) | 220 | 10.45% | 10.44% | ₹2,20,000.00 | 26-Oct-2033 | 26-Oct-2026 |
| **total** | | | **10.86%** | **₹5,99,999.61** | | |

Sums to the portal's own stated Total Investment to the paise, so **the PRD's ₹6.33L for
this bucket is superseded**. Two things to keep straight:

- These are **invested amounts, not marks.** The screen reports cost, so `valuePaise ==
  avgCostPaise` and unrealised P&L reads as zero until Task 11B supplies real marks.
- The portal's ₹1,19,480 "Returns Till Date" is **cash already received**, not accrued
  value — it is exactly 2 years of coupon on each of the three lines, and coupons here pay
  out annually rather than compounding into the bond. **Do not add it to the holding
  values.** That double-count is roughly what the PRD's ₹6.33L looks like.
- Concentration note for §3.5: **two of three bonds are the same issuer** (Sammaan
  Capital, ₹3.80L = 63% of the bond bucket). The single-issuer cap must see them as one.

`InstrumentSeed` now carries `isin`, and `seed.ts` writes it (the schema column existed but
went unwritten). Task 11B's mapper matches on ISIN, so this is load-bearing; two tests
cover it, both mutation-checked.
- **Holdings total is exact at ₹47.69L** — EPF 13.54L, MF 11.83L, stocks/ETFs 8.32L,
  bonds 6.00L, savings 1.63L, US basket 1.37L, Fidelity NOW 5.00L.

## Deferred minors (tracked, not blocking)

**Fix-on-touch**: if the task you are running edits one of these files, fix the minor in
the same commit and strike it from this list. Do not let these pile up for the single
end-of-branch fix wave. The "fixes at" column is the expected home, not a hard schedule.

| # | From | Minor | Fixes at |
|---|---|---|---|
| ~~1~~ | T6 | ~~`runCascade`'s month-step duplicates `amortize`'s math — extract `stepLoan()`~~ | **fixed in Task 7** (fix-on-touch) |
| 2 | T4 | No negative-amount tests for `formatInr` / `mulP` / `usdToInr`. Verified by trace only | Task 10 (first negative flows) |
| 3 | T1 | 2 `ASSUMPTIONS` keys still untested (`fiIncomeFloor/StretchMonthlyInr`); `childMonthlyDentInr` covered in T7 | Task 10 |
| 4 | T1 | Planning INR values are plain numbers; consumers must convert to bigint paise | same |
| 5 | T2 | postgres-js path has **no** automated test — no live Postgres here | Task 15, provisioning checklist item 2 |
| 6 | T5 | `tests/seed/seed-data.test.ts` MF subtotal test *title* says "1.83L", asserts 11.83L — cosmetic, value correct | final fix wave |
| 7 | T6 | `persistSchedules` does `delete` + N sequential inserts, unwrapped (`src/domain/loans.ts:144–171`) — matches existing `seed.ts` convention, so genuinely cross-cutting | final fix wave |
