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
| 6 | loan amortization + prepayment cascade | **implemented, NOT reviewed; 1 red test** |
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

## Open question blocking Task 6

`SEED_LOANS.home` is internally inconsistent. Outstanding ₹30.24L at 7.95% with EMI
₹24,482 amortizes to a natural payoff of **Mar 2048**, not the seeded `naturalEndOn` of
**Feb 2047**. Verified independently: monthly interest ₹20,034, principal ₹4,448,
n = −ln(1 − 0.8183)/ln(1.006625) ≈ 258 months from Sep 2026.

Consequence: computed home-loan interest saved is **₹21,18,438**, ~0.9% above the brief's
₹17L–₹21L cap, so one Task 6 test is red. **Assessment: the model is right and the band's
premise is wrong** — the band derives from the PRD's ~₹19.3L figure, which assumed the
Feb 2047 end date the seeded balance/EMI pair cannot produce. Needs the owner's real
statement, not a band edit.

Also from Task 6, not yet independently reviewed: the implementer **rewrote `runCascade`**
from the brief's sequential version (a later loan idle until the earlier closed) to a
concurrent one, on the grounds that the brief's own flat-outflow requirement
(~₹55,526/month) is impossible under sequential amortization. That rewrite looks correct
but the task review never ran. Computed closures: car1 → 2028-01-01, car2 → 2028-10-01,
home → 2034-03-01.

## Owner true-up items (need real statements — do not guess)

- **Home loan:** actual outstanding + actual EMI (see above; blocks Task 6).
- **Car loan 1:** outstanding ₹2.20L is an estimate.
- **Bonds:** line items sum to ₹6.00L against the PRD's stated ₹6.33L bucket — accrued
  interest? ₹0.33L unexplained.
- **Loans total:** ₹37.39L computed vs ₹36.7L stated in the PRD.
- **RSU grants:** per-grant unit split was reconstructed to total 1,105 units; the PRD
  never published the breakdown.
- **Holdings total is exact at ₹47.69L** — EPF 13.54L, MF 11.83L, stocks/ETFs 8.32L,
  bonds 6.00L, savings 1.63L, US basket 1.37L, Fidelity NOW 5.00L.

## Deferred minors (tracked, not blocking)

- Task 1: 3 `ASSUMPTIONS` keys untested; planning INR values are plain numbers, so
  consumers must convert to bigint paise.
- Task 2: the postgres-js path has **no** automated test — no live Postgres here. Verify at
  Supabase provisioning (Task 15 checklist item 2).
- Task 4: no negative-amount tests for `formatInr` / `mulP` / `usdToInr`. Behavior verified
  by trace; negative flows first appear in Task 10 withdrawals.
- Task 5: `tests/seed/seed-data.test.ts` MF subtotal test *title* says "1.83L" but asserts
  11.83L — cosmetic typo, value correct.
