# Sentinel — repo map

Read at session start (see `CLAUDE.md`). Update when files are added, moved, or their
exports change. Files marked *(planned)* do not exist yet.

## Layout

```
CLAUDE.md      agent operating instructions + hard PRD constraints
MEMORY.md      durable state: decisions, contracts, gotchas, open questions
index.md       this file
migrations/    numbered .sql, applied in name order
src/           implementation
tests/         vitest, mirrors src/ layout
docs/superpowers/plans/2026-08-12-sentinel-phase-0.md   the ~4,700-line plan (do not read whole)
.superpowers/sdd/2026-08-12-sentinel-phase-0/           SDD workspace: briefs, review diffs, progress.md
```

## Source

| File | Exports / role |
|---|---|
| `src/config/assumptions.ts` | `ASSUMPTIONS` — the only place PRD §15.2 planning constants live |
| `src/db/client.ts` | `Db` interface (4 methods), `openDb(url?)` — PGlite or postgres-js |
| `src/db/migrate.ts` | `runMigrations(db, dir?)` — each unapplied file in one transaction; also a CLI |
| `src/money/paise.ts` | `Paise`, `Cents`, `rupees`, `paise`, `dollars`, `cents`, `addP`, `subP`, `mulP`, `pctOf`, `formatInr` |
| `src/money/fx.ts` | `rateMicros`, `usdToInr` |
| `src/seed/seed-data.ts` | `SEED_INSTRUMENTS`, `SEED_HOLDINGS`, `SEED_LOANS`, `SEED_BUCKETS`, `SEED_MILESTONES`, `SEED_RSU_GRANTS` — the owner's real balance sheet. All loan and bond figures are owner-verified against lender/broker portals; see `MEMORY.md`. `InstrumentSeed` carries optional `isin` (populated for the three bonds; Task 11B matches on it) |
| `src/seed/seed.ts` | `seed(db, opts?)` — idempotent; one snapshot per (business_date, source); writes `instruments.isin` |
| `src/domain/loans.ts` | `amortize`, `runCascade`, `interestPaid`, `nextMonth`, `persistSchedules`. Both schedules share the private `stepLoan()` month step |
| `src/domain/surplus.ts` | `FIXED_OUTFLOWS`, `BASE_TAKE_HOME`, `BASE_TAKE_HOME_AS_OF`, `RENT_TO_EMI_FLAG`, `CHILD_DENT_NO_END_FLAG`, `PARTIAL_YEAR_FLAG`, `SurplusMonth`, `AnnualSurplus` (carries `monthCount` + `flags`), `loanOutflowByMonth`, `projectSurplus`, `projectAnnualSurplus`. `projectSurplus`'s coverage guard is derived from the outflow map's own key range, never from `closures` alone — see `MEMORY.md` |
| `src/domain/rsu.ts` | `VestEvent`, `PROJECTED_SOURCE`, `CONFIRMED_SOURCE`, `projectVests`, `withRefreshers`, `unvestedValue`, `persistVests(db, vests, {asOf?, source?})`, `confirmVest(db, id, actual, {asOf?})`. Tranches are allocated cumulatively so 16 parts always sum to the whole grant; `confirmVest` RECOMPUTES `gross_paise`; `withRefreshers` skips years that already carry a real grant |
| `src/jobs/sync.ts` *(planned)* | Task 15 — `pnpm sync` |
| `src/jobs/digest.ts` *(planned)* | Task 15 — `pnpm digest` |
| `src/jobs/ips.ts` *(planned)* | Task 13/15 — `pnpm ips` |

## Migrations

| File | Contents |
|---|---|
| `migrations/0000_bootstrap.sql` | `schema_migrations` bookkeeping table (single statement) |
| `migrations/0001_phase0.sql` | 16 Phase 0 tables + append-only triggers (~30 statements) |

## Tests

One file per source module under `tests/`, same relative path. Plus:
`tests/db/schema.test.ts` (constraints, `as_of`/`source` NOT NULL, append-only incl.
TRUNCATE) and `tests/domain/loans.persist.test.ts` (schedule persistence). 78 tests.

Two conventions worth preserving, both learned from tests that caught nothing:
derive the *actual* side of an assertion from the real data structure rather than
hard-coding both sides, and never hard-code a literal (a month, a total) that is
downstream of seed data — it goes stale silently the moment the seed is corrected.

One deliberate exception: `tests/domain/surplus.test.ts` asserts ₹82,124 / ₹55,526
exactly. A stale literal there fails **loudly**, which is the point — the rule exists to
stop literals that make a test *vacuous*, not ones that make it break when the seed moves.

## Scripts

`pnpm test` · `test:watch` · `migrate` · `seed` · `sync` · `digest` · `ips`
(`indmoney:login` arrives with Task 11A).
