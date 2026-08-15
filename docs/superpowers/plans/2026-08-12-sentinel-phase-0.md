# Sentinel Phase 0 ("See Clearly") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a daily Telegram digest showing Anirban's true total net worth — including Fidelity NOW RSUs and EPF, which no tool he owns can see — plus bucket balances, allocation drift vs the IPS, and a loud staleness report.

**Architecture:** A single TypeScript package. Deterministic domain modules (money, loans, surplus, RSU, allocation) are pure functions over seeded state and persisted snapshots. Source adapters (Kite REST, INDmoney, FX) implement one `Source` interface and every row they write carries `as_of` + `source` for the staleness engine. Jobs are stateless `tsx` scripts invoked by GitHub Actions, so the PRD §12.1 contingency migration to a local machine is a config change, not a rewrite. No LLM in Phase 0 — the digest is templated; Claude enters in Phase 1.

**Tech Stack:** TypeScript 5.x on Node 22, pnpm, vitest, `tsx` for job entrypoints, raw SQL migrations, `@electric-sql/pglite` for local/test Postgres and `postgres` (postgres-js) for Supabase, Telegram Bot API over `fetch`.

## Global Constraints

- **Sole user.** No accounts, no multi-tenancy, no sharing affordances (PRD §4.1). Telegram commands are ignored from any chat ID other than `TELEGRAM_OWNER_CHAT_ID`.
- **No money in floats, ever.** All INR is `bigint` paise; all USD is `bigint` cents. Columns are `BIGINT`. A `number` holding a currency amount is a bug.
- **Absent code paths, not toggles** (PRD §11.3): Phase 0 contains no order placement, no F&O, no leverage, no crypto. Kite client exposes read methods only.
- **Append-only audit** (FR-07): `audit_log` and `snapshots` have `UPDATE`/`DELETE` triggers that raise. Nothing is hard-deleted.
- **Never display an unknown cost as ₹0** (FR-02). Unknown invested amount is `null` and renders as `—`.
- **Staleness is loud** (FR-31, §8.2): every persisted datum carries `as_of` + `source`; freshness policy is prices 24h (trading days), NAVs 48h, FX 48h, portfolio syncs 36h, fundamentals 1 quarter. Violations raise incidents and badge the digest.
- **Funded-status is unreadable by risk code** (FR-16, §11.9). `src/domain/funded-status.ts` may import from allocation/networth, never the reverse. Enforced by a test that greps imports.
- **Planning assumptions** (§15.2), all in `src/config/assumptions.ts`, none inline: equity 12% nominal (±3% bands), inflation 6%, SWR 3.5% (4% sensitivity), SIP step-up 10%/yr, RSU refresher $20,000/yr over 4-year vests, USDINR seed 95.3, NOW seed price $127.54, net-of-withholding factor 0.70.
- **Timezone:** all business dates are IST (`Asia/Kolkata`). Store `DATE` for business dates, `TIMESTAMPTZ` for event times. Never use the runner's local timezone.
- **Dates in code** are `'YYYY-MM-DD'` strings, not `Date` objects, in all domain signatures.

## Scope Calls (deviations from a literal reading of the PRD — flagged deliberately)

1. **No Next.js UI in Phase 0.** The Phase 0 DoD (§14) requires a digest and "IPS v1 stored and rendered"; rendering is served by Telegram + a `pnpm ips` CLI. The web UI earns its keep in Phase 2 when approval detail views exist. Vercel is not provisioned yet.
2. **INDmoney sync is automated via OAuth refresh tokens, bootstrapped by a one-time interactive login.** Verified against `https://mcp.indmoney.com/.well-known/oauth-authorization-server`:

   ```json
   { "issuer": "https://mcp.indmoney.com/",
     "authorization_endpoint": "https://mcp.indmoney.com/authorize",
     "token_endpoint": "https://mcp.indmoney.com/token",
     "registration_endpoint": "https://mcp.indmoney.com/register",
     "scopes_supported": ["portfolio:read", "market:read"],
     "grant_types_supported": ["authorization_code", "refresh_token"] }
   ```

   `registration_endpoint` means Dynamic Client Registration (RFC 7591) is open — Sentinel registers itself, no partner agreement. `refresh_token` means the owner completes OTP + MPIN **once**, via `pnpm indmoney:login` (loopback flow on 127.0.0.1, exactly like `gcloud auth login`), after which jobs mint access tokens unattended. The runner never sees a credential. The granted scope is `portfolio:read` only, so the PRD §9.2 read-only guarantee is enforced by the token itself, not by our restraint.

   **Unknown, and deliberately not guessed:** refresh-token lifetime and whether INDmoney periodically forces a fresh OTP + MPIN. Handled, not predicted — a failed refresh opens an incident, the digest badges INDmoney stale, and Telegram nags the owner to re-run the login. Worst case degrades to the file-source experience; best case it never surfaces.

   `FileIndmoneySource` survives as the test double and the manual fallback. When the Next.js UI lands in Phase 2, the button is a thin wrapper over the same token store built in Task 11A — no rework.
3. **Supabase is not provisioned yet.** Everything runs on PGlite locally with identical SQL; `DATABASE_URL` switches to Supabase with zero code change. Task 14 produces the provisioning checklist.

## File Structure

```
package.json                      pnpm scripts: test, migrate, seed, sync, digest, ips
tsconfig.json                     strict: true, target ES2023, module NodeNext
vitest.config.ts
.env.example                      env contract (Task 14)
migrations/0001_phase0.sql        all Phase 0 tables + append-only triggers
src/
  config/env.ts                   parse + validate process.env, fail fast
  config/assumptions.ts           §15.2 planning constants (single source of truth)
  config/ips-v1.md                verbatim IPS text from PRD §3
  db/client.ts                    Db interface; PGlite + postgres-js implementations
  db/migrate.ts                   ordered SQL file runner with applied-migrations table
  money/paise.ts                  Paise/Cents branded bigints, parse/format/arith
  money/fx.ts                     USD→INR conversion at a dated rate
  domain/loans.ts                 amortization + prepayment cascade
  domain/surplus.ts               investable surplus curve (monthly + annual)
  domain/rsu.ts                   grant → vest projection, refresher scenarios
  domain/networth.ts              consolidated position → total net worth
  domain/allocation.ts            actual vs IPS strategic bands, drift
  domain/buckets.ts               B1–B4 balances, targets, funded ratio; M1/M2 status
  domain/funded-status.ts         FI band vs corpus (REPORTING ONLY — one-way import)
  domain/ips.ts                   IPS install/version/clause extraction
  sources/types.ts                Source, SourceResult, Freshness contracts
  sources/kite.ts                 Kite Connect read-only client
  sources/indmoney.ts             FileIndmoneySource (fallback) + RemoteIndmoneySource (OAuth)
  sources/oauth.ts                DCR, PKCE, encrypted token store, silent refresh
  sources/mcp-client.ts           MCP over Streamable HTTP (initialize + tools/call)
  sources/fx.ts                   USDINR daily rate fetch
  sources/staleness.ts            freshness policy, incident raising
  seed/seed-data.ts               PRD §2 seed constants (balance sheet, loans, grants)
  seed/seed.ts                    idempotent seeding job
  notify/telegram.ts              sendMessage, owner-chat guard, command router
  notify/digest.ts                digest composition (pure: state → markdown)
  jobs/sync.ts                    EOD sync entrypoint
  jobs/digest.ts                  pre-open digest entrypoint
  jobs/keepalive.ts               weekly Supabase keep-alive write
  jobs/ips.ts                     `pnpm ips [clause]` render CLI
tests/                            mirrors src/ ; fixtures/ holds captured API payloads
.github/workflows/{sync,digest,keepalive}.yml
```

---

### Task 1: Repository skeleton and test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/config/assumptions.ts`
- Test: `tests/config/assumptions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `pnpm test` (vitest), `pnpm exec tsx <file>` for scripts; `ASSUMPTIONS` constant object exported from `src/config/assumptions.ts`.

- [ ] **Step 1: Initialise the repo and install dev tooling**

```bash
cd /d/Sentinel
git init
pnpm init
pnpm add -D typescript@^5 vitest@^3 tsx@^4 @types/node@^22
pnpm add @electric-sql/pglite postgres
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

Add `"type": "module"` to `package.json`, plus scripts:

```json
"scripts": {
  "test": "vitest run",
  "test:watch": "vitest",
  "migrate": "tsx src/db/migrate.ts",
  "seed": "tsx src/seed/seed.ts",
  "sync": "tsx src/jobs/sync.ts",
  "digest": "tsx src/jobs/digest.ts",
  "ips": "tsx src/jobs/ips.ts"
}
```

- [ ] **Step 3: Write `vitest.config.ts` and `.gitignore`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
```

`.gitignore`:

```
node_modules/
dist/
.env
.pglite/
*.local.json
```

- [ ] **Step 4: Write the failing test for assumptions**

`tests/config/assumptions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';

describe('planning assumptions', () => {
  it('encodes PRD 15.2 values exactly', () => {
    expect(ASSUMPTIONS.equityNominalCagr).toBe(0.12);
    expect(ASSUMPTIONS.sensitivityBand).toBe(0.03);
    expect(ASSUMPTIONS.inflation).toBe(0.06);
    expect(ASSUMPTIONS.swrFloor).toBe(0.035);
    expect(ASSUMPTIONS.swrOptimistic).toBe(0.04);
    expect(ASSUMPTIONS.sipStepUp).toBe(0.10);
    expect(ASSUMPTIONS.rsuRefresherUsdPerYear).toBe(20_000);
    expect(ASSUMPTIONS.rsuVestYears).toBe(4);
    expect(ASSUMPTIONS.rsuNetOfWithholding).toBe(0.70);
    expect(ASSUMPTIONS.seedUsdInr).toBe(95.3);
    expect(ASSUMPTIONS.seedNowPriceUsd).toBe(127.54);
    expect(ASSUMPTIONS.childArrivalYear).toBe(2028);
    expect(ASSUMPTIONS.fiTargetAge).toBe(55);
    expect(ASSUMPTIONS.ownerBirthYear).toBe(1995);
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `pnpm test`
Expected: FAIL — cannot resolve `../../src/config/assumptions.js`.

- [ ] **Step 6: Write `src/config/assumptions.ts`**

```ts
/**
 * PRD §15.2 standing assumptions. Owner-confirmed; revisit annually.
 * Nothing in this file may be duplicated inline anywhere else in the codebase.
 */
export const ASSUMPTIONS = {
  equityNominalCagr: 0.12,
  sensitivityBand: 0.03,
  inflation: 0.06,
  swrFloor: 0.035,
  swrOptimistic: 0.04,
  sipStepUp: 0.10,
  rsuRefresherUsdPerYear: 20_000,
  rsuVestYears: 4,
  rsuNetOfWithholding: 0.70,
  seedUsdInr: 95.3,
  seedNowPriceUsd: 127.54,
  childArrivalYear: 2028,
  childMonthlyDentInr: 10_000,
  fiTargetAge: 55,
  ownerBirthYear: 1995,
  /** FI income target in today's purchasing power, monthly (PRD §2.5). */
  fiIncomeFloorMonthlyInr: 300_000,
  fiIncomeStretchMonthlyInr: 500_000,
} as const;

export type Assumptions = typeof ASSUMPTIONS;
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `pnpm test`
Expected: PASS (1 test).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "chore: scaffold Sentinel TypeScript package with planning assumptions"
```

---

### Task 2: Database client and migration runner

**Files:**
- Create: `src/db/client.ts`, `src/db/migrate.ts`, `migrations/0000_bootstrap.sql`
- Test: `tests/db/migrate.test.ts`

**Interfaces:**
- Consumes: Task 1 tooling.
- Produces:
  - `interface Db { query<T>(sql: string, params?: unknown[]): Promise<T[]>; close(): Promise<void>; }`
  - `openDb(url?: string): Promise<Db>` — PGlite when `url` is undefined or starts with `pglite://`, postgres-js otherwise.
  - `runMigrations(db: Db, dir?: string): Promise<string[]>` — returns names newly applied, idempotent.

- [ ] **Step 1: Write the failing test**

`tests/db/migrate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

describe('migration runner', () => {
  it('applies migrations once and is idempotent', async () => {
    const db = await openDb();
    const first = await runMigrations(db);
    expect(first).toContain('0000_bootstrap.sql');

    const second = await runMigrations(db);
    expect(second).toEqual([]);

    const rows = await db.query<{ name: string }>(
      'select name from schema_migrations order by name',
    );
    expect(rows.map((r) => r.name)).toContain('0000_bootstrap.sql');
    await db.close();
  });

  it('round-trips parameters and bigint columns', async () => {
    const db = await openDb();
    await runMigrations(db);
    await db.query('create table t (id int primary key, amount bigint)');
    await db.query('insert into t values ($1, $2)', [1, '123456789012']);
    const rows = await db.query<{ amount: string }>('select amount from t where id = $1', [1]);
    expect(String(rows[0]!.amount)).toBe('123456789012');
    await db.close();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test tests/db/migrate.test.ts`
Expected: FAIL — module `src/db/client.js` not found.

- [ ] **Step 3: Write `src/db/client.ts`**

```ts
import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

/**
 * In-memory/embedded Postgres for local dev and tests; postgres-js for Supabase.
 * Identical SQL runs on both — migrations must stay portable.
 */
export async function openDb(url = process.env.DATABASE_URL): Promise<Db> {
  if (!url || url.startsWith('pglite://')) {
    const dataDir = url ? url.slice('pglite://'.length) : undefined;
    const pg = dataDir ? new PGlite(dataDir) : new PGlite();
    await pg.waitReady;
    return {
      async query<T>(sql: string, params: unknown[] = []) {
        const res = await pg.query<T>(sql, params);
        return res.rows;
      },
      async close() {
        await pg.close();
      },
    };
  }

  const sql = postgres(url, { max: 2, prepare: false });
  return {
    async query<T>(text: string, params: unknown[] = []) {
      return (await sql.unsafe(text, params as never[])) as unknown as T[];
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
```

- [ ] **Step 4: Write `migrations/0000_bootstrap.sql`**

```sql
-- Bootstrap: migration bookkeeping only.
create table if not exists schema_migrations (
  name        text primary key,
  applied_at  timestamptz not null default now()
);
```

- [ ] **Step 5: Write `src/db/migrate.ts`**

```ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './client.js';
import { openDb } from './client.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));

/** Applies every unapplied .sql file in name order. Returns names newly applied. */
export async function runMigrations(db: Db, dir = DEFAULT_DIR): Promise<string[]> {
  await db.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now())`,
  );

  const applied = new Set(
    (await db.query<{ name: string }>('select name from schema_migrations')).map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const newlyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    await db.query(sql);
    await db.query('insert into schema_migrations (name) values ($1)', [file]);
    newlyApplied.push(file);
  }
  return newlyApplied;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await openDb();
  const applied = await runMigrations(db);
  console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Already up to date.');
  await db.close();
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test tests/db/migrate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(db): portable Db client (PGlite/Supabase) and migration runner"
```

---

### Task 3: Phase 0 schema with append-only audit

**Files:**
- Create: `migrations/0001_phase0.sql`
- Test: `tests/db/schema.test.ts`

**Interfaces:**
- Consumes: `openDb`, `runMigrations` (Task 2).
- Produces: the tables every later task reads and writes. Column names below are authoritative — later tasks reference them verbatim.

- [ ] **Step 1: Write the failing test**

`tests/db/schema.test.ts`:

```ts
import { beforeAll, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

let db: Db;
beforeAll(async () => {
  db = await openDb();
  await runMigrations(db);
});

const REQUIRED_TABLES = [
  'instruments', 'snapshots', 'holdings', 'lots', 'buckets', 'bucket_flows',
  'milestones', 'rsu_grants', 'rsu_vests', 'loans', 'loan_schedule',
  'ips_versions', 'fx_rates', 'incidents', 'settings_rails', 'audit_log',
];

describe('phase 0 schema', () => {
  it('creates every required table', async () => {
    const rows = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const names = rows.map((r) => r.table_name);
    for (const t of REQUIRED_TABLES) expect(names).toContain(t);
  });

  it('refuses updates and deletes on audit_log', async () => {
    await db.query(
      `insert into audit_log (entity, entity_id, action, actor, payload)
       values ('test', '1', 'CREATED', 'agent', '{}'::jsonb)`,
    );
    await expect(db.query(`update audit_log set action = 'X'`)).rejects.toThrow();
    await expect(db.query(`delete from audit_log`)).rejects.toThrow();
  });

  it('requires as_of and source on every holdings row', async () => {
    await expect(
      db.query(`insert into holdings (snapshot_id, instrument_id, quantity) values (null, null, 1)`),
    ).rejects.toThrow();
  });

  it('stores money as bigint paise without precision loss', async () => {
    await db.query(
      `insert into fx_rates (pair, as_of, rate_micros, source)
       values ('USDINR', '2026-08-12', 95300000, 'seed')`,
    );
    const [row] = await db.query<{ rate_micros: string }>(
      `select rate_micros from fx_rates where pair = 'USDINR'`,
    );
    expect(String(row!.rate_micros)).toBe('95300000');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test tests/db/schema.test.ts`
Expected: FAIL — relation `instruments` does not exist.

- [ ] **Step 3: Write `migrations/0001_phase0.sql`**

```sql
-- Sentinel Phase 0 schema. Money: BIGINT paise (INR) or BIGINT cents (USD).
-- Every externally-sourced row carries as_of + source for the staleness engine.

create table instruments (
  id              text primary key,               -- e.g. 'NSE:TATASTEEL', 'MF:INF109K012K1', 'US:AAPL'
  kind            text not null check (kind in ('EQUITY','ETF','MF','BOND','CASH','EPF','RSU','GOLD','LOAN')),
  name            text not null,
  currency        text not null default 'INR' check (currency in ('INR','USD')),
  exchange        text,
  isin            text,
  sector          text,
  issuer          text,                            -- for §3.5 single-issuer cap across equity + credit
  is_watchlist    boolean not null default false,
  is_employer     boolean not null default false,  -- NOW: §3.5 10% cap
  metadata        jsonb not null default '{}'::jsonb
);

create table snapshots (
  id              uuid primary key default gen_random_uuid(),
  taken_at        timestamptz not null default now(),
  business_date   date not null,
  source          text not null,                   -- 'kite' | 'indmoney' | 'manual' | 'composite'
  payload         jsonb not null default '{}'::jsonb
);
create index snapshots_business_date_idx on snapshots (business_date desc);

create table holdings (
  id              uuid primary key default gen_random_uuid(),
  snapshot_id     uuid not null references snapshots(id),
  instrument_id   text not null references instruments(id),
  quantity        numeric(20,6) not null,
  avg_cost_paise  bigint,                          -- NULL = unknown (FR-02); never render as 0
  value_paise     bigint not null,
  account         text not null,                   -- 'zerodha' | 'indmoney' | 'fidelity' | 'epf' | 'bank'
  as_of           timestamptz not null,
  source          text not null
);
create index holdings_snapshot_idx on holdings (snapshot_id);

create table lots (
  id              uuid primary key default gen_random_uuid(),
  instrument_id   text not null references instruments(id),
  account         text not null,
  acquired_on     date not null,
  quantity        numeric(20,6) not null,
  cost_paise      bigint not null,
  closed_on       date,
  seeded          boolean not null default false,  -- historical lots seeded by owner
  as_of           timestamptz not null,
  source          text not null
);
create index lots_fifo_idx on lots (instrument_id, account, acquired_on);

create table buckets (
  id              text primary key check (id in ('B1','B2','B3','B4')),
  name            text not null,
  mandate         text not null,
  target_paise    bigint,
  target_note     text not null,
  active          boolean not null default true
);

create table bucket_flows (
  id              uuid primary key default gen_random_uuid(),
  bucket_id       text not null references buckets(id),
  occurred_on     date not null,
  amount_paise    bigint not null,                 -- signed
  kind            text not null,                   -- 'seed' | 'sip' | 'vest' | 'maturity' | 'withdrawal'
  note            text not null default '',
  as_of           timestamptz not null,
  source          text not null
);

create table milestones (
  id              text primary key check (id in ('M1','M2')),
  name            text not null,
  spec            text not null,
  rationale       text not null,
  completed_on    date,
  nag             boolean not null default true
);

create table rsu_grants (
  id              text primary key,
  granted_on      date not null,
  units           numeric(12,4) not null,
  vest_years      int not null default 4,
  cadence         text not null default 'QUARTERLY',
  scenario        text not null default 'ACTUAL' check (scenario in ('ACTUAL','REFRESHER')),
  note            text not null default ''
);

create table rsu_vests (
  id              uuid primary key default gen_random_uuid(),
  grant_id        text not null references rsu_grants(id),
  vest_on         date not null,
  units           numeric(12,4) not null,
  status          text not null default 'PROJECTED' check (status in ('PROJECTED','ACTUAL')),
  price_usd_cents bigint,
  usdinr_micros   bigint,
  gross_paise     bigint,
  net_paise       bigint,
  confirmed_on    date,
  as_of           timestamptz not null,
  source          text not null
);
create index rsu_vests_date_idx on rsu_vests (vest_on);

create table loans (
  id              text primary key,
  name            text not null,
  lender          text not null,
  principal_paise bigint not null,
  outstanding_paise bigint not null,
  annual_rate_bps int not null,                    -- 795 = 7.95%
  emi_paise       bigint not null,
  started_on      date not null,
  natural_end_on  date not null,
  cascade_order   int,                             -- 1 = closes first and redirects into order 2
  as_of           timestamptz not null,
  source          text not null
);

create table loan_schedule (
  id              uuid primary key default gen_random_uuid(),
  loan_id         text not null references loans(id),
  scenario        text not null check (scenario in ('NATURAL','CASCADE')),
  period_month    date not null,                   -- first of month
  opening_paise   bigint not null,
  payment_paise   bigint not null,
  interest_paise  bigint not null,
  principal_paise bigint not null,
  closing_paise   bigint not null
);
create index loan_schedule_idx on loan_schedule (loan_id, scenario, period_month);

create table ips_versions (
  version         int primary key,
  full_text       text not null,
  diff            text not null default '',
  effective_at    timestamptz not null,
  created_at      timestamptz not null default now()
);

create table fx_rates (
  pair            text not null,
  as_of           date not null,
  rate_micros     bigint not null,                 -- 95.3 -> 95300000
  source          text not null,
  primary key (pair, as_of)
);

create table incidents (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null,                   -- 'STALE_DATA' | 'SYNC_FAILURE' | 'CAP_BREACH'
  severity        text not null check (severity in ('INFO','WARN','BLOCK')),
  subject         text not null,
  detail          text not null,
  opened_at       timestamptz not null default now(),
  resolved_at     timestamptz
);
create index incidents_open_idx on incidents (resolved_at, opened_at desc);

create table settings_rails (
  key             text primary key,
  value           jsonb not null,
  updated_at      timestamptz not null default now(),
  pending_value   jsonb,
  pending_since   timestamptz                       -- 48h cooling-off (PRD §11)
);

create table audit_log (
  id              bigserial primary key,
  at              timestamptz not null default now(),
  entity          text not null,
  entity_id       text not null,
  action          text not null,
  actor           text not null check (actor in ('owner','agent','broker','system')),
  payload         jsonb not null default '{}'::jsonb
);
create index audit_log_entity_idx on audit_log (entity, entity_id, at desc);

-- Append-only enforcement (FR-07). RLS is added when Supabase is provisioned;
-- triggers protect local and remote identically.
create or replace function sentinel_append_only() returns trigger as $$
begin
  raise exception 'append-only table: % may not be % ed', tg_table_name, tg_op;
end;
$$ language plpgsql;

create trigger audit_log_append_only before update or delete on audit_log
  for each statement execute function sentinel_append_only();
create trigger snapshots_append_only before update or delete on snapshots
  for each statement execute function sentinel_append_only();
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/db/schema.test.ts`
Expected: PASS (4 tests). If `gen_random_uuid()` is unavailable, add `create extension if not exists pgcrypto;` at the top of the migration and re-run.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(db): phase 0 schema with append-only audit and staleness columns"
```

---

### Task 4: Money primitives

**Files:**
- Create: `src/money/paise.ts`, `src/money/fx.ts`
- Test: `tests/money/paise.test.ts`, `tests/money/fx.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Paise = bigint & { readonly __brand: 'Paise' }`, `type Cents = bigint & { readonly __brand: 'Cents' }`
  - `rupees(amount: number | string): Paise`, `paise(v: bigint | string | number): Paise`
  - `formatInr(p: Paise, opts?: { compact?: boolean }): string` — `compact` renders Indian units (`₹13.54L`, `₹1.24Cr`)
  - `addP(...xs: Paise[]): Paise`, `subP(a: Paise, b: Paise): Paise`, `mulP(p: Paise, factor: number): Paise`, `pctOf(part: Paise, whole: Paise): number`
  - `usdToInr(cents: Cents, rateMicros: bigint): Paise`, `rateMicros(rate: number): bigint`

- [ ] **Step 1: Write the failing tests**

`tests/money/paise.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addP, formatInr, mulP, paise, pctOf, rupees, subP } from '../../src/money/paise.js';

describe('paise', () => {
  it('parses rupees without float error', () => {
    expect(rupees(24_482).toString()).toBe('2448200');
    expect(rupees('0.10').toString()).toBe('10');
    expect(rupees('1354000.55').toString()).toBe('135400055');
  });

  it('rejects sub-paise precision rather than silently rounding', () => {
    expect(() => rupees('1.005')).toThrow(/sub-paise/i);
  });

  it('formats Indian units compactly', () => {
    expect(formatInr(rupees(1_354_000), { compact: true })).toBe('₹13.54L');
    expect(formatInr(rupees(12_400_000), { compact: true })).toBe('₹1.24Cr');
    expect(formatInr(rupees(31_500), { compact: true })).toBe('₹31,500');
  });

  it('formats full amounts with Indian digit grouping', () => {
    expect(formatInr(rupees(2_15_000))).toBe('₹2,15,000');
    expect(formatInr(rupees('1234.50'))).toBe('₹1,234.50');
  });

  it('does arithmetic in integers', () => {
    expect(addP(rupees(1), rupees(2), rupees(3)).toString()).toBe('600');
    expect(subP(rupees(5), rupees(2)).toString()).toBe('300');
    expect(mulP(rupees(100), 0.7).toString()).toBe('7000');
    expect(pctOf(rupees(25), rupees(100))).toBeCloseTo(0.25, 10);
  });

  it('treats pctOf a zero whole as zero, not NaN', () => {
    expect(pctOf(rupees(0), rupees(0))).toBe(0);
  });

  it('round-trips a bigint from the database', () => {
    expect(paise('135400055').toString()).toBe('135400055');
  });
});
```

`tests/money/fx.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { rateMicros, usdToInr } from '../../src/money/fx.js';
import { cents } from '../../src/money/paise.js';

describe('fx', () => {
  it('converts USD cents to INR paise at a dated rate', () => {
    // 127.54 USD at 95.3 -> 12154.562 INR -> 1215456 paise (truncated, not rounded up)
    expect(usdToInr(cents('12754'), rateMicros(95.3)).toString()).toBe('1215456');
  });

  it('rejects a non-positive rate', () => {
    expect(() => usdToInr(cents('100'), 0n)).toThrow(/rate/i);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm test tests/money`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/money/paise.ts`**

```ts
declare const brand: unique symbol;
export type Paise = bigint & { readonly [brand]: 'Paise' };
export type Cents = bigint & { readonly [brand]: 'Cents' };

function parseMinorUnits(amount: number | string, unitName: string): bigint {
  const text = typeof amount === 'number' ? amount.toString() : amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`invalid ${unitName} amount: ${amount}`);
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
  if (fraction.length > 2) throw new Error(`sub-paise precision not representable: ${amount}`);
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  return negative ? -minor : minor;
}

export const rupees = (amount: number | string): Paise =>
  parseMinorUnits(amount, 'rupee') as Paise;
export const paise = (v: bigint | string | number): Paise => BigInt(v) as Paise;
export const dollars = (amount: number | string): Cents =>
  parseMinorUnits(amount, 'dollar') as Cents;
export const cents = (v: bigint | string | number): Cents => BigInt(v) as Cents;

export const addP = (...xs: Paise[]): Paise => xs.reduce((a, b) => a + b, 0n) as Paise;
export const subP = (a: Paise, b: Paise): Paise => (a - b) as Paise;

/** Multiplies by a real factor via micro-precision integers; truncates toward zero. */
export const mulP = (p: Paise, factor: number): Paise => {
  const micros = BigInt(Math.round(factor * 1_000_000));
  return ((p * micros) / 1_000_000n) as Paise;
};

export const pctOf = (part: Paise, whole: Paise): number =>
  whole === 0n ? 0 : Number(part) / Number(whole);

const groupIndian = (digits: string): string => {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
};

export function formatInr(p: Paise, opts: { compact?: boolean } = {}): string {
  const negative = p < 0n;
  const abs = negative ? -p : p;
  const sign = negative ? '-' : '';

  if (opts.compact) {
    const wholeRupees = abs / 100n;
    if (wholeRupees >= 10_000_000n) return `${sign}₹${(Number(abs) / 1e9).toFixed(2)}Cr`;
    if (wholeRupees >= 100_000n) return `${sign}₹${(Number(abs) / 1e7).toFixed(2)}L`;
  }

  const whole = groupIndian((abs / 100n).toString());
  const frac = abs % 100n;
  return frac === 0n
    ? `${sign}₹${whole}`
    : `${sign}₹${whole}.${frac.toString().padStart(2, '0')}`;
}
```

- [ ] **Step 4: Write `src/money/fx.ts`**

```ts
import type { Cents, Paise } from './paise.js';

/** 95.3 -> 95_300_000 micros. Stored in fx_rates.rate_micros. */
export const rateMicros = (rate: number): bigint => BigInt(Math.round(rate * 1_000_000));

/** USD cents -> INR paise at the given dated rate. Truncates toward zero. */
export function usdToInr(amount: Cents, micros: bigint): Paise {
  if (micros <= 0n) throw new Error('fx rate must be positive');
  return ((amount * micros) / 1_000_000n) as Paise;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test tests/money`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(money): branded paise/cents integers with Indian formatting and FX"
```

---

### Task 5: Seed data from PRD §2

**Files:**
- Create: `src/seed/seed-data.ts`, `src/seed/seed.ts`
- Test: `tests/seed/seed-data.test.ts`, `tests/seed/seed.test.ts`

**Interfaces:**
- Consumes: `Paise`/`rupees` (Task 4), schema (Task 3), `openDb`/`runMigrations` (Task 2).
- Produces:
  - `SEED_INSTRUMENTS`, `SEED_HOLDINGS`, `SEED_LOANS`, `SEED_BUCKETS`, `SEED_MILESTONES`, `SEED_RSU_GRANTS`
  - `seed(db: Db, opts?: { asOf?: string }): Promise<{ snapshotId: string }>` — idempotent
  - `type Account = 'zerodha' | 'indmoney' | 'fidelity' | 'epf' | 'bank' | 'groww'`
  - `interface HoldingSeed { instrumentId: string; account: Account; quantity: number; valuePaise: Paise; avgCostPaise: Paise | null }`

- [ ] **Step 1: Write the failing test for the seed constants**

`tests/seed/seed-data.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { addP, rupees } from '../../src/money/paise.js';
import {
  SEED_BUCKETS, SEED_HOLDINGS, SEED_INSTRUMENTS, SEED_LOANS,
  SEED_MILESTONES, SEED_RSU_GRANTS,
} from '../../src/seed/seed-data.js';

describe('seed data matches the PRD balance sheet', () => {
  it('totals roughly 48L of assets including Fidelity', () => {
    const total = addP(...SEED_HOLDINGS.map((h) => h.valuePaise));
    expect(Number(total / 100n)).toBeGreaterThan(4_600_000);
    expect(Number(total / 100n)).toBeLessThan(5_000_000);
  });

  it('carries EPF and Fidelity at their stated values', () => {
    const byAccount = (account: string) =>
      addP(...SEED_HOLDINGS.filter((h) => h.account === account).map((h) => h.valuePaise));
    expect(byAccount('epf')).toBe(rupees(1_354_000));
    expect(byAccount('fidelity')).toBe(rupees(500_000));
  });

  it('references only declared instruments', () => {
    const ids = new Set(SEED_INSTRUMENTS.map((i) => i.id));
    for (const h of SEED_HOLDINGS) expect(ids.has(h.instrumentId)).toBe(true);
  });

  it('marks NOW as the employer instrument for the 10% cap', () => {
    expect(SEED_INSTRUMENTS.find((i) => i.id === 'US:NOW')?.isEmployer).toBe(true);
  });

  it('records unknown cost as null, never zero (FR-02)', () => {
    expect(SEED_HOLDINGS.some((h) => h.avgCostPaise === null)).toBe(true);
    expect(SEED_HOLDINGS.some((h) => h.avgCostPaise === 0n)).toBe(false);
  });

  it('carries three loans totalling ~36.7L outstanding with a cascade order', () => {
    const outstanding = addP(...SEED_LOANS.map((l) => l.outstandingPaise));
    expect(Number(outstanding / 100n)).toBeGreaterThan(3_500_000);
    expect(Number(outstanding / 100n)).toBeLessThan(3_800_000);
    expect(SEED_LOANS.map((l) => l.cascadeOrder).sort()).toEqual([1, 2, 3]);
  });

  it('declares four buckets and two incomplete milestones', () => {
    expect(SEED_BUCKETS.map((b) => b.id)).toEqual(['B1', 'B2', 'B3', 'B4']);
    expect(SEED_MILESTONES.map((m) => m.id)).toEqual(['M1', 'M2']);
    expect(SEED_MILESTONES.every((m) => m.completedOn === null)).toBe(true);
  });

  it('carries six RSU grants totalling 1105 units', () => {
    expect(SEED_RSU_GRANTS).toHaveLength(6);
    expect(SEED_RSU_GRANTS.reduce((a, g) => a + g.units, 0)).toBe(1105);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test tests/seed/seed-data.test.ts`
Expected: FAIL — module `src/seed/seed-data.js` not found.

- [ ] **Step 3: Write `src/seed/seed-data.ts`**

Values transcribed from PRD §2.3, §2.4, §2.6. Where the PRD gives a rounded bucket total but not every line item (Indian stocks ₹8.32L), the named positions are listed and the remainder is carried as one `NSE:SMALLCASE-RESIDUE` line so totals reconcile and the Phase 2 cleanup queue has something to attach to.

```ts
import { rupees, type Paise } from '../money/paise.js';

export type Account = 'zerodha' | 'indmoney' | 'fidelity' | 'epf' | 'bank' | 'groww';

export interface InstrumentSeed {
  id: string;
  kind: 'EQUITY' | 'ETF' | 'MF' | 'BOND' | 'CASH' | 'EPF' | 'RSU' | 'GOLD';
  name: string;
  currency: 'INR' | 'USD';
  sector?: string;
  issuer?: string;
  isEmployer?: boolean;
}

export interface HoldingSeed {
  instrumentId: string;
  account: Account;
  quantity: number;
  valuePaise: Paise;
  /** null = unknown cost (FR-02). Never 0. */
  avgCostPaise: Paise | null;
}

export interface LoanSeed {
  id: string;
  name: string;
  lender: string;
  principalPaise: Paise;
  outstandingPaise: Paise;
  annualRateBps: number;
  emiPaise: Paise;
  startedOn: string;
  naturalEndOn: string;
  cascadeOrder: 1 | 2 | 3;
}

export interface RsuGrantSeed {
  id: string;
  grantedOn: string;
  units: number;
  note: string;
}

export const SEED_INSTRUMENTS: InstrumentSeed[] = [
  { id: 'EPF:ANIRBAN', kind: 'EPF', name: 'Employees Provident Fund', currency: 'INR' },
  { id: 'MF:ICICI-NIFTY50-IDX', kind: 'MF', name: 'ICICI Pru Nifty 50 Index Direct', currency: 'INR' },
  { id: 'MF:PPFC', kind: 'MF', name: 'Parag Parikh Flexi Cap Direct', currency: 'INR' },
  { id: 'MF:ICICI-LARGECAP', kind: 'MF', name: 'ICICI Pru Large Cap Direct', currency: 'INR' },
  { id: 'MF:HDFC-MIDCAP', kind: 'MF', name: 'HDFC Mid Cap Opportunities Direct', currency: 'INR' },
  { id: 'MF:MOTILAL-MIDCAP', kind: 'MF', name: 'Motilal Oswal Midcap Direct', currency: 'INR' },
  { id: 'MF:BANDHAN-SMALLCAP', kind: 'MF', name: 'Bandhan Small Cap Direct', currency: 'INR' },
  { id: 'NSE:NIFTYBEES', kind: 'ETF', name: 'Nippon Nifty BeES', currency: 'INR' },
  { id: 'NSE:GOLDBEES', kind: 'GOLD', name: 'Gold ETF', currency: 'INR' },
  { id: 'NSE:LIQUIDBEES', kind: 'ETF', name: 'Liquid ETF', currency: 'INR' },
  { id: 'NSE:SMALLCASE-RESIDUE', kind: 'EQUITY', name: 'Smallcase residue (unallocated; cleanup queue)', currency: 'INR' },
  { id: 'NSE:RPOWER', kind: 'EQUITY', name: 'Reliance Power (Groww - manual closure)', currency: 'INR', sector: 'Power' },
  { id: 'BOND:SAMMAAN-2026', kind: 'BOND', name: 'Sammaan Capital 9% 26-Sep-2026', currency: 'INR', issuer: 'Sammaan Capital' },
  { id: 'BOND:SAMMAAN-2029', kind: 'BOND', name: 'Sammaan Capital 9.75% Jul-2029', currency: 'INR', issuer: 'Sammaan Capital' },
  { id: 'BOND:EDELWEISS-2033', kind: 'BOND', name: 'Edelweiss Financial 10.45% Oct-2033', currency: 'INR', issuer: 'Edelweiss Financial' },
  { id: 'CASH:SAVINGS', kind: 'CASH', name: 'Savings account', currency: 'INR' },
  { id: 'US:INDMONEY-BASKET', kind: 'EQUITY', name: 'US fractional basket (AAPL/GOOGL/AMZN/MSFT/TSLA/VOO)', currency: 'USD' },
  { id: 'US:NOW', kind: 'RSU', name: 'ServiceNow (NOW) - vested, Fidelity', currency: 'USD', sector: 'Technology', issuer: 'ServiceNow', isEmployer: true },
];

export const SEED_HOLDINGS: HoldingSeed[] = [
  { instrumentId: 'EPF:ANIRBAN', account: 'epf', quantity: 1, valuePaise: rupees(1_354_000), avgCostPaise: null },

  // Mutual funds - 11.84L total (PRD 2.3)
  { instrumentId: 'MF:ICICI-NIFTY50-IDX', account: 'zerodha', quantity: 1, valuePaise: rupees(47_000), avgCostPaise: null },
  { instrumentId: 'MF:ICICI-NIFTY50-IDX', account: 'indmoney', quantity: 1, valuePaise: rupees(281_000), avgCostPaise: null },
  { instrumentId: 'MF:ICICI-NIFTY50-IDX', account: 'indmoney', quantity: 1, valuePaise: rupees(368_000), avgCostPaise: null },
  { instrumentId: 'MF:PPFC', account: 'indmoney', quantity: 1, valuePaise: rupees(241_000), avgCostPaise: null },
  { instrumentId: 'MF:ICICI-LARGECAP', account: 'indmoney', quantity: 1, valuePaise: rupees(203_000), avgCostPaise: null },
  { instrumentId: 'MF:HDFC-MIDCAP', account: 'indmoney', quantity: 1, valuePaise: rupees(19_000), avgCostPaise: null },
  { instrumentId: 'MF:MOTILAL-MIDCAP', account: 'indmoney', quantity: 1, valuePaise: rupees(6_000), avgCostPaise: null },
  { instrumentId: 'MF:BANDHAN-SMALLCAP', account: 'indmoney', quantity: 1, valuePaise: rupees(18_000), avgCostPaise: null },

  // Indian stocks / ETFs - 8.32L total
  { instrumentId: 'NSE:NIFTYBEES', account: 'zerodha', quantity: 1, valuePaise: rupees(95_000), avgCostPaise: null },
  { instrumentId: 'NSE:GOLDBEES', account: 'zerodha', quantity: 2616, valuePaise: rupees(63_000), avgCostPaise: null },
  { instrumentId: 'NSE:LIQUIDBEES', account: 'zerodha', quantity: 1, valuePaise: rupees(16_000), avgCostPaise: null },
  { instrumentId: 'NSE:SMALLCASE-RESIDUE', account: 'zerodha', quantity: 1, valuePaise: rupees(555_400), avgCostPaise: null },
  { instrumentId: 'NSE:RPOWER', account: 'groww', quantity: 1, valuePaise: rupees(2_600), avgCostPaise: null },

  // Corporate bonds - 6.33L
  { instrumentId: 'BOND:SAMMAAN-2026', account: 'indmoney', quantity: 1, valuePaise: rupees(284_000), avgCostPaise: null },
  { instrumentId: 'BOND:SAMMAAN-2029', account: 'indmoney', quantity: 1, valuePaise: rupees(96_000), avgCostPaise: null },
  { instrumentId: 'BOND:EDELWEISS-2033', account: 'indmoney', quantity: 1, valuePaise: rupees(220_000), avgCostPaise: null },

  { instrumentId: 'CASH:SAVINGS', account: 'bank', quantity: 1, valuePaise: rupees(163_000), avgCostPaise: null },
  { instrumentId: 'US:INDMONEY-BASKET', account: 'indmoney', quantity: 1, valuePaise: rupees(137_000), avgCostPaise: null },
  { instrumentId: 'US:NOW', account: 'fidelity', quantity: 1, valuePaise: rupees(500_000), avgCostPaise: null },
];

export const SEED_LOANS: LoanSeed[] = [
  {
    id: 'car1', name: 'Car loan 1', lender: 'HDFC',
    principalPaise: rupees(650_000), outstandingPaise: rupees(220_000),
    annualRateBps: 795, emiPaise: rupees(13_821),
    startedOn: '2023-02-01', naturalEndOn: '2028-01-01', cascadeOrder: 1,
  },
  {
    id: 'car2', name: 'Car loan 2', lender: 'Bank of Baroda',
    principalPaise: rupees(550_000), outstandingPaise: rupees(495_000),
    annualRateBps: 795, emiPaise: rupees(17_223),
    startedOn: '2026-04-01', naturalEndOn: '2029-04-01', cascadeOrder: 2,
  },
  {
    id: 'home', name: 'Home loan (Kolkata flat)', lender: 'SBI',
    principalPaise: rupees(3_200_000), outstandingPaise: rupees(3_024_000),
    annualRateBps: 795, emiPaise: rupees(24_482),
    startedOn: '2022-03-01', naturalEndOn: '2047-02-01', cascadeOrder: 3,
  },
];

export const SEED_BUCKETS = [
  { id: 'B1', name: 'FI corpus', targetPaise: null,
    mandate: 'Max risk-adjusted return within a 30% max-drawdown constraint',
    targetNote: '10.3-17.1 Cr real at age 55 (2050)' },
  { id: 'B2', name: 'House fund', targetPaise: rupees(6_500_000),
    mandate: 'Capital preservation; duration-matched debt/arbitrage; no equity risk inside 7 years of purchase',
    targetNote: 'Down payment + costs 55-75L for a 2-2.5 Cr Hyderabad home, 2033-35' },
  { id: 'B3', name: 'Emergency fund', targetPaise: rupees(600_000),
    mandate: 'Liquid savings; AU SFB during build, IDFC First beyond 3L, split beyond 5L for DICGC cover',
    targetNote: 'Complete by Dec 2026 from Sammaan maturity + Nov 2026 vest' },
  { id: 'B4', name: 'Education corpus', targetPaise: rupees(10_000_000),
    mandate: 'Long-horizon equity glide path, de-risking from ~2040',
    targetNote: '1 Cr in today money at child age 18 (~2046); activates ~2028' },
] as const;

export const SEED_MILESTONES = [
  { id: 'M1', name: 'Term life cover',
    spec: '2 Cr personal term cover, before the child arrives, funded from RSU vests',
    rationale: 'Employer group cover evaporates on exit; the maximum-dependency point is now',
    completedOn: null },
  { id: 'M2', name: 'Health super top-up',
    spec: '~50L family super top-up beyond employer cover',
    rationale: 'Single-income household with a 30L medical event as a defined SIP-stop trigger',
    completedOn: null },
] as const;

/** PRD 2.4: 6 grants, 1,105 units total, quarterly vests over 4 years. */
export const SEED_RSU_GRANTS: RsuGrantSeed[] = [
  { id: 'G2021', grantedOn: '2021-11-15', units: 120, note: 'Joining grant' },
  { id: 'G2022', grantedOn: '2022-02-15', units: 140, note: 'Annual refresher' },
  { id: 'G2023', grantedOn: '2023-02-15', units: 165, note: 'Annual refresher' },
  { id: 'G2024', grantedOn: '2024-02-15', units: 190, note: 'Annual refresher' },
  { id: 'G2025', grantedOn: '2025-02-15', units: 205, note: 'Annual refresher' },
  { id: 'G2026', grantedOn: '2026-02-15', units: 285, note: 'Largest grant to date' },
];
```

> **Seeding accuracy note:** the per-grant unit split reconciles to the PRD's 1,105-unit total and its stated vest-value profile, but the PRD did not publish the per-grant breakdown. Task 8 asserts the *aggregate* vest profile, not these rows. Surface this to the owner at first run for true-up from the Fidelity statement; the quarterly reconciliation (FR-03) is the permanent fix.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test tests/seed/seed-data.test.ts`
Expected: PASS (8 tests). If the asset total falls outside 46-50L, adjust `NSE:SMALLCASE-RESIDUE` so the zerodha equity lines total 8.32L — never adjust a named PRD line item.

- [ ] **Step 5: Write the failing test for the seeding job**

`tests/seed/seed.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

const count = async (t: string) =>
  Number((await db.query<{ n: string }>(`select count(*) as n from ${t}`))[0]!.n);

describe('seed job', () => {
  it('writes instruments, holdings, loans, buckets, milestones and grants', async () => {
    await seed(db, { asOf: '2026-08-12' });
    expect(await count('instruments')).toBeGreaterThan(15);
    expect(await count('holdings')).toBeGreaterThan(15);
    expect(await count('loans')).toBe(3);
    expect(await count('buckets')).toBe(4);
    expect(await count('milestones')).toBe(2);
    expect(await count('rsu_grants')).toBe(6);
  });

  it('is idempotent - re-seeding does not duplicate holdings', async () => {
    await seed(db, { asOf: '2026-08-12' });
    const before = await count('holdings');
    await seed(db, { asOf: '2026-08-12' });
    expect(await count('holdings')).toBe(before);
  });

  it('records the seeding in the audit log', async () => {
    await seed(db, { asOf: '2026-08-12' });
    const rows = await db.query<{ action: string; actor: string }>(
      `select action, actor from audit_log where entity = 'seed'`,
    );
    expect(rows[0]).toMatchObject({ action: 'SEEDED', actor: 'system' });
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `pnpm test tests/seed/seed.test.ts`
Expected: FAIL — `src/seed/seed.js` not found.

- [ ] **Step 7: Write `src/seed/seed.ts`**

```ts
import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import {
  SEED_BUCKETS, SEED_HOLDINGS, SEED_INSTRUMENTS, SEED_LOANS,
  SEED_MILESTONES, SEED_RSU_GRANTS,
} from './seed-data.js';

const SOURCE = 'manual-seed';

/**
 * Idempotent: the manual seed owns exactly one snapshot per business date.
 * snapshots is append-only, so re-seeding clears that snapshot's holdings
 * (holdings is not append-only) and reuses the snapshot row.
 */
export async function seed(db: Db, opts: { asOf?: string } = {}): Promise<{ snapshotId: string }> {
  const businessDate = opts.asOf ?? new Date().toISOString().slice(0, 10);
  const asOf = `${businessDate}T00:00:00+05:30`;

  for (const i of SEED_INSTRUMENTS) {
    await db.query(
      `insert into instruments (id, kind, name, currency, sector, issuer, is_employer)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set name = excluded.name, sector = excluded.sector,
         issuer = excluded.issuer, is_employer = excluded.is_employer`,
      [i.id, i.kind, i.name, i.currency, i.sector ?? null, i.issuer ?? null, i.isEmployer ?? false],
    );
  }

  const existing = await db.query<{ id: string }>(
    `select id from snapshots where business_date = $1 and source = $2`,
    [businessDate, SOURCE],
  );
  let snapshotId = existing[0]?.id;
  if (snapshotId) {
    await db.query('delete from holdings where snapshot_id = $1', [snapshotId]);
  } else {
    const [row] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ($1,$2) returning id`,
      [businessDate, SOURCE],
    );
    snapshotId = row!.id;
  }

  for (const h of SEED_HOLDINGS) {
    await db.query(
      `insert into holdings
         (snapshot_id, instrument_id, quantity, avg_cost_paise, value_paise, account, as_of, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [snapshotId, h.instrumentId, h.quantity,
       h.avgCostPaise === null ? null : h.avgCostPaise.toString(),
       h.valuePaise.toString(), h.account, asOf, SOURCE],
    );
  }

  for (const l of SEED_LOANS) {
    await db.query(
      `insert into loans (id, name, lender, principal_paise, outstanding_paise, annual_rate_bps,
                          emi_paise, started_on, natural_end_on, cascade_order, as_of, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       on conflict (id) do update set outstanding_paise = excluded.outstanding_paise,
         emi_paise = excluded.emi_paise, as_of = excluded.as_of`,
      [l.id, l.name, l.lender, l.principalPaise.toString(), l.outstandingPaise.toString(),
       l.annualRateBps, l.emiPaise.toString(), l.startedOn, l.naturalEndOn, l.cascadeOrder,
       asOf, SOURCE],
    );
  }

  for (const b of SEED_BUCKETS) {
    await db.query(
      `insert into buckets (id, name, mandate, target_paise, target_note)
       values ($1,$2,$3,$4,$5)
       on conflict (id) do update set mandate = excluded.mandate,
         target_paise = excluded.target_paise, target_note = excluded.target_note`,
      [b.id, b.name, b.mandate, b.targetPaise === null ? null : b.targetPaise.toString(), b.targetNote],
    );
  }

  for (const m of SEED_MILESTONES) {
    await db.query(
      `insert into milestones (id, name, spec, rationale, completed_on)
       values ($1,$2,$3,$4,$5) on conflict (id) do nothing`,
      [m.id, m.name, m.spec, m.rationale, m.completedOn],
    );
  }

  for (const g of SEED_RSU_GRANTS) {
    await db.query(
      `insert into rsu_grants (id, granted_on, units, note)
       values ($1,$2,$3,$4) on conflict (id) do update set units = excluded.units`,
      [g.id, g.grantedOn, g.units, g.note],
    );
  }

  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('seed', $1, 'SEEDED', 'system', $2::jsonb)`,
    [snapshotId, JSON.stringify({ businessDate, holdings: SEED_HOLDINGS.length })],
  );

  return { snapshotId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = await openDb();
  await runMigrations(db);
  const { snapshotId } = await seed(db);
  console.log(`Seeded snapshot ${snapshotId}`);
  await db.close();
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test tests/seed`
Expected: PASS (11 tests).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(seed): PRD balance sheet, loans, buckets, milestones and RSU grants"
```

---

### Task 6: Loan amortization and the prepayment cascade

**Files:**
- Create: `src/domain/loans.ts`
- Test: `tests/domain/loans.test.ts`

**Interfaces:**
- Consumes: `Paise` (Task 4), `SEED_LOANS` (Task 5).
- Produces:
  - `type LoanInput = { id: string; outstandingPaise: Paise; annualRateBps: number; emiPaise: Paise; cascadeOrder: number }`
  - `interface ScheduleRow { loanId: string; month: string; openingPaise: Paise; paymentPaise: Paise; interestPaise: Paise; principalPaise: Paise; closingPaise: Paise }`
  - `amortize(loan: LoanInput, opts: { from: string; extraByMonth?: Map<string, Paise> }): ScheduleRow[]`
  - `runCascade(loans: LoanInput[], from: string): { rows: ScheduleRow[]; closures: Map<string, string> }`
  - `interestPaid(rows: ScheduleRow[], loanId?: string): Paise`
  - `nextMonth(month: string): string` — used by Task 7

**Cascade rule (PRD §2.2):** loans close in `cascadeOrder`; when one closes, the sum of all EMIs freed so far becomes extra principal on the next open loan. Total loan outflow stays flat at ~₹55,526/month until the last closure.

- [ ] **Step 1: Write the failing test**

`tests/domain/loans.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { amortize, interestPaid, runCascade } from '../../src/domain/loans.js';
import { rupees } from '../../src/money/paise.js';
import { SEED_LOANS } from '../../src/seed/seed-data.js';

const inputs = SEED_LOANS.map((l) => ({
  id: l.id, outstandingPaise: l.outstandingPaise, annualRateBps: l.annualRateBps,
  emiPaise: l.emiPaise, cascadeOrder: l.cascadeOrder,
}));

describe('amortize', () => {
  it('reduces the balance to zero without overpaying the final instalment', () => {
    const rows = amortize(
      { id: 'x', outstandingPaise: rupees(100_000), annualRateBps: 795, emiPaise: rupees(10_000), cascadeOrder: 1 },
      { from: '2026-09-01' },
    );
    expect(rows.at(-1)!.closingPaise).toBe(0n);
    expect(rows.at(-1)!.paymentPaise).toBeLessThanOrEqual(rupees(10_000));
    expect(rows.every((r) => r.interestPaise >= 0n)).toBe(true);
  });

  it('charges interest on the opening balance at the monthly rate', () => {
    const [first] = amortize(
      { id: 'x', outstandingPaise: rupees(100_000), annualRateBps: 1200, emiPaise: rupees(10_000), cascadeOrder: 1 },
      { from: '2026-09-01' },
    );
    expect(first!.interestPaise).toBe(rupees(1_000)); // 12%/12 = 1% of 1,00,000
    expect(first!.principalPaise).toBe(rupees(9_000));
  });

  it('applies extra principal in the month it is supplied', () => {
    const rows = amortize(
      { id: 'x', outstandingPaise: rupees(100_000), annualRateBps: 1200, emiPaise: rupees(10_000), cascadeOrder: 1 },
      { from: '2026-09-01', extraByMonth: new Map([['2026-10-01', rupees(20_000)]]) },
    );
    expect(rows.find((r) => r.month === '2026-10-01')!.paymentPaise).toBe(rupees(30_000));
  });

  it('throws rather than looping forever when the EMI never amortises', () => {
    expect(() =>
      amortize(
        { id: 'bad', outstandingPaise: rupees(1_000_000), annualRateBps: 1200, emiPaise: rupees(100), cascadeOrder: 1 },
        { from: '2026-09-01' },
      ),
    ).toThrow(/never amortis/i);
  });
});

describe('the committed prepayment cascade', () => {
  const { rows, closures } = runCascade(inputs, '2026-09-01');

  it('closes car loan 1 in early 2028', () => {
    expect(closures.get('car1')!.slice(0, 4)).toBe('2028');
    expect(Number(closures.get('car1')!.slice(5, 7))).toBeLessThanOrEqual(3);
  });

  it('closes car loan 2 in 2028, ahead of its natural Apr 2029 end', () => {
    expect(closures.get('car2')!.slice(0, 4)).toBe('2028');
  });

  it('closes the home loan around Dec 2033, not its natural Feb 2047', () => {
    const home = closures.get('home')!;
    expect(home >= '2033-06-01' && home <= '2034-06-01').toBe(true);
  });

  it('keeps total monthly loan outflow flat at ~55,526 through the steady state', () => {
    const byMonth = new Map<string, bigint>();
    for (const r of rows) byMonth.set(r.month, (byMonth.get(r.month) ?? 0n) + r.paymentPaise);
    for (const [month, total] of byMonth) {
      if (month < '2026-10-01' || month > '2033-01-01') continue;
      expect(Number(total / 100n), `month ${month}`).toBeGreaterThan(55_000);
      expect(Number(total / 100n), `month ${month}`).toBeLessThan(56_100);
    }
  });

  it('saves roughly 17-21 lakh of home-loan interest versus the natural schedule', () => {
    const natural = amortize(inputs.find((l) => l.id === 'home')!, { from: '2026-09-01' });
    const saved = interestPaid(natural) - interestPaid(rows, 'home');
    expect(Number(saved / 100n)).toBeGreaterThan(1_700_000);
    expect(Number(saved / 100n)).toBeLessThan(2_100_000);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test tests/domain/loans.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/domain/loans.ts`**

```ts
import { type Paise } from '../money/paise.js';

export interface LoanInput {
  id: string;
  outstandingPaise: Paise;
  annualRateBps: number;
  emiPaise: Paise;
  cascadeOrder: number;
}

export interface ScheduleRow {
  loanId: string;
  /** First of the month, 'YYYY-MM-01'. */
  month: string;
  openingPaise: Paise;
  paymentPaise: Paise;
  interestPaise: Paise;
  principalPaise: Paise;
  closingPaise: Paise;
}

const MAX_MONTHS = 600; // 50-year guard, not a business rule.

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** Monthly interest on the opening balance: bps / 12, truncated to paise. */
function monthlyInterest(balance: Paise, annualRateBps: number): Paise {
  return ((balance * BigInt(annualRateBps)) / 120_000n) as Paise;
}

export function amortize(
  loan: LoanInput,
  opts: { from: string; extraByMonth?: Map<string, Paise> },
): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let balance = loan.outstandingPaise;
  let month = opts.from;

  while (balance > 0n) {
    if (rows.length >= MAX_MONTHS) {
      throw new Error(`loan ${loan.id} never amortises: EMI does not exceed monthly interest`);
    }
    const interest = monthlyInterest(balance, loan.annualRateBps);
    const extra = opts.extraByMonth?.get(month) ?? (0n as Paise);
    const scheduled = (loan.emiPaise + extra) as Paise;
    if (scheduled <= interest) {
      throw new Error(`loan ${loan.id} never amortises: EMI does not exceed monthly interest`);
    }
    const payment = (scheduled > balance + interest ? balance + interest : scheduled) as Paise;
    const principal = (payment - interest) as Paise;
    const closing = (balance - principal) as Paise;

    rows.push({
      loanId: loan.id, month,
      openingPaise: balance, paymentPaise: payment,
      interestPaise: interest, principalPaise: principal, closingPaise: closing,
    });

    balance = closing;
    month = nextMonth(month);
  }
  return rows;
}

/**
 * PRD §2.2 committed cascade: loans repay in cascadeOrder and every freed EMI is
 * redirected in full to the next open loan, so household loan outflow stays flat
 * until the last loan dies (Dec 2033 under the owner's plan).
 */
export function runCascade(
  loans: LoanInput[],
  from: string,
): { rows: ScheduleRow[]; closures: Map<string, string> } {
  const ordered = [...loans].sort((a, b) => a.cascadeOrder - b.cascadeOrder);
  const rows: ScheduleRow[] = [];
  const closures = new Map<string, string>();
  let freedEmi = 0n as Paise;
  let start = from;

  for (const loan of ordered) {
    const extraByMonth = new Map<string, Paise>();
    let cursor = start;
    for (let i = 0; i < MAX_MONTHS; i++) {
      extraByMonth.set(cursor, freedEmi);
      cursor = nextMonth(cursor);
    }

    const schedule = amortize(loan, { from: start, extraByMonth });
    rows.push(...schedule);
    const closingMonth = schedule.at(-1)!.month;
    closures.set(loan.id, closingMonth);
    freedEmi = (freedEmi + loan.emiPaise) as Paise;
    start = nextMonth(closingMonth);
  }

  return { rows, closures };
}

export function interestPaid(rows: ScheduleRow[], loanId?: string): Paise {
  return rows
    .filter((r) => !loanId || r.loanId === loanId)
    .reduce((sum, r) => sum + r.interestPaise, 0n) as Paise;
}
```

> **Implementer note:** loans amortise sequentially — a later loan pays only its own EMI while an earlier one is open, which is the owner's actual plan; the flat-outflow test verifies the aggregate. The month a loan closes pays a stub instalment; if the flat-outflow assertion trips on a boundary month, narrow the test's month range rather than smearing the stub across the model. The stub is real.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/domain/loans.test.ts`
Expected: PASS (9 tests). If home-loan closure lands outside Jun 2033 – Jun 2034, re-check `SEED_LOANS.home.outstandingPaise` against the owner's latest SBI statement before touching the model — the model is arithmetic; the input is the estimate.

- [ ] **Step 5: Persist schedules — write the failing test**

`tests/domain/loans.persist.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { persistSchedules } from '../../src/domain/loans.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

describe('persistSchedules', () => {
  it('stores both NATURAL and CASCADE scenarios and replaces on re-run', async () => {
    await persistSchedules(db, '2026-09-01');
    const scenarios = await db.query<{ scenario: string }>(
      'select distinct scenario from loan_schedule order by scenario',
    );
    expect(scenarios.map((s) => s.scenario)).toEqual(['CASCADE', 'NATURAL']);

    const before = Number(
      (await db.query<{ n: string }>('select count(*) as n from loan_schedule'))[0]!.n,
    );
    await persistSchedules(db, '2026-09-01');
    const after = Number(
      (await db.query<{ n: string }>('select count(*) as n from loan_schedule'))[0]!.n,
    );
    expect(after).toBe(before);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `pnpm test tests/domain/loans.persist.test.ts`
Expected: FAIL — `persistSchedules` is not exported.

- [ ] **Step 7: Add `persistSchedules` to `src/domain/loans.ts`**

```ts
import type { Db } from '../db/client.js';

interface LoanRow {
  id: string;
  outstanding_paise: string;
  annual_rate_bps: number;
  emi_paise: string;
  cascade_order: number;
}

/** Recomputes and replaces both scenarios. loan_schedule is derived state, not audit. */
export async function persistSchedules(db: Db, from: string): Promise<void> {
  const rows = await db.query<LoanRow>(
    'select id, outstanding_paise, annual_rate_bps, emi_paise, cascade_order from loans',
  );
  const loans: LoanInput[] = rows.map((r) => ({
    id: r.id,
    outstandingPaise: BigInt(r.outstanding_paise) as Paise,
    annualRateBps: Number(r.annual_rate_bps),
    emiPaise: BigInt(r.emi_paise) as Paise,
    cascadeOrder: Number(r.cascade_order),
  }));

  const natural = loans.flatMap((l) => amortize(l, { from }));
  const { rows: cascade } = runCascade(loans, from);

  await db.query('delete from loan_schedule');
  for (const [scenario, set] of [['NATURAL', natural], ['CASCADE', cascade]] as const) {
    for (const r of set) {
      await db.query(
        `insert into loan_schedule (loan_id, scenario, period_month, opening_paise,
           payment_paise, interest_paise, principal_paise, closing_paise)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.loanId, scenario, r.month, r.openingPaise.toString(), r.paymentPaise.toString(),
         r.interestPaise.toString(), r.principalPaise.toString(), r.closingPaise.toString()],
      );
    }
  }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test tests/domain`
Expected: PASS (10 tests).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(domain): loan amortization, prepayment cascade and persisted schedules"
```

---

### Task 7: Investable surplus curve

**Files:**
- Create: `src/domain/surplus.ts`
- Test: `tests/domain/surplus.test.ts`

**Interfaces:**
- Consumes: `Paise`, `rupees`, `mulP` (Task 4); `nextMonth`, `runCascade` (Task 6); `ASSUMPTIONS` (Task 1).
- Produces:
  - `interface SurplusMonth { month: string; takeHomePaise: Paise; loanOutflowPaise: Paise; fixedOutflowPaise: Paise; childDentPaise: Paise; investablePaise: Paise }`
  - `projectSurplus(opts: { from: string; months: number; closures: Map<string, string>; loanOutflowByMonth: Map<string, Paise> }): SurplusMonth[]`
  - `projectAnnualSurplus(opts: { fromYear: number; toYear: number; monthly: SurplusMonth[] }): { year: number; investablePaise: Paise }[]`
  - `FIXED_OUTFLOWS: { rent, motherSupport, wifeAllowance, maidAndMaintenance, misc }` (PRD §2.2)

**Model rules (PRD §2.2, §15.2):**
- Take-home ₹2,15,000/month, stepped up 10% each **April** (fiscal-year start).
- Non-loan fixed outflows: rent ₹31,500 + mother ₹20,000 + wife ₹10,000 + maid/maintenance ₹5,850 + misc ₹10,000. Rent converts to an equivalent EMI at the Hyderabad purchase — out of Phase 0's 24-month monthly horizon, so the annual projection flags it rather than modelling a mortgage.
- Child dent: ₹10,000/month from Jan 2028, ending when B4 activates (annual view only).
- Loan outflow comes from the cascade, so the Jan 2034 release is a consequence of the model, not a hardcoded date.
- Mother's support **never terminates**.

- [ ] **Step 1: Write the failing test**

`tests/domain/surplus.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runCascade } from '../../src/domain/loans.js';
import {
  FIXED_OUTFLOWS, loanOutflowByMonth, projectAnnualSurplus, projectSurplus,
} from '../../src/domain/surplus.js';
import { addP, rupees, subP } from '../../src/money/paise.js';
import { SEED_LOANS } from '../../src/seed/seed-data.js';

const inputs = SEED_LOANS.map((l) => ({
  id: l.id, outstandingPaise: l.outstandingPaise, annualRateBps: l.annualRateBps,
  emiPaise: l.emiPaise, cascadeOrder: l.cascadeOrder,
}));
const { rows, closures } = runCascade(inputs, '2026-09-01');
const outflow = loanOutflowByMonth(rows);

const project = (months: number) =>
  projectSurplus({ from: '2026-09-01', months, closures, loanOutflowByMonth: outflow });

describe('surplus curve', () => {
  // Every input here is a constant, so the first month is fully determined:
  //   215,000 take-home - 55,526 loan outflow - 77,350 fixed = 82,124, child dent 0.
  // Asserted EXACTLY rather than banded. An earlier draft of this plan banded it at
  // <82,000 while its own implementer note derived 82,124 - the test contradicted the
  // model it was testing. A band here buys nothing: there is no estimate to absorb.
  it('starts at the derived 82,124 investable surplus', () => {
    const [first] = project(1);
    expect(first!.investablePaise).toBe(rupees(82_124));
    // Bolted to the parts, so a change to any constant fails here rather than silently
    // shifting the curve.
    expect(first!.takeHomePaise).toBe(rupees(215_000));
    expect(first!.loanOutflowPaise).toBe(rupees(55_526));
    expect(first!.fixedOutflowPaise).toBe(rupees(77_350));
    expect(first!.childDentPaise).toBe(rupees(0));
  });

  it('steps take-home up 10% each April', () => {
    const months = project(24);
    const mar = months.find((m) => m.month === '2027-03-01')!;
    const apr = months.find((m) => m.month === '2027-04-01')!;
    expect(Number(apr.takeHomePaise) / Number(mar.takeHomePaise)).toBeCloseTo(1.1, 3);
  });

  it('applies the child dent from Jan 2028', () => {
    const months = projectSurplus({
      from: '2026-09-01', months: 24, closures, loanOutflowByMonth: outflow,
    });
    expect(months.find((m) => m.month === '2027-12-01')!.childDentPaise).toBe(0n);
    expect(Number(months.find((m) => m.month === '2028-01-01')!.childDentPaise / 100n)).toBe(10_000);
  });

  // Asserts the mother's-support COMPONENT, not the sum of all five fixed outflows. An
  // earlier draft checked `fixedOutflowPaise > 0n`, which no single-line change to
  // mother's support alone could ever fail - you would have had to zero all five. The
  // whole point of this rule (PRD §2.2) is that this one line never terminates, so the
  // test has to be able to see it on its own.
  it('never terminates the mother support line', () => {
    expect(FIXED_OUTFLOWS.motherSupport).toBe(rupees(20_000));
    const months = project(24);
    // Every month must carry at least the mother's-support line, and the fixed block must
    // still contain it: drop motherSupport from the sum and the residual has to shrink by
    // exactly that amount.
    const others = addP(
      FIXED_OUTFLOWS.rent, FIXED_OUTFLOWS.wifeAllowance,
      FIXED_OUTFLOWS.maidAndMaintenance, FIXED_OUTFLOWS.misc,
    );
    for (const m of months) {
      expect(subP(m.fixedOutflowPaise, others)).toBe(FIXED_OUTFLOWS.motherSupport);
    }
  });

  it('holds loan outflow flat until the home loan closes, then releases it', () => {
    const annual = projectAnnualSurplus({
      fromYear: 2026, toYear: 2050,
      monthly: projectSurplus({ from: '2026-09-01', months: 300, closures, loanOutflowByMonth: outflow }),
    });
    const y2033 = annual.find((a) => a.year === 2033)!.investablePaise;
    const y2035 = annual.find((a) => a.year === 2035)!.investablePaise;
    expect(y2035).toBeGreaterThan(y2033);
  });

  it('produces one row per month with no gaps', () => {
    const months = project(24);
    expect(months).toHaveLength(24);
    expect(months[0]!.month).toBe('2026-09-01');
    expect(months.at(-1)!.month).toBe('2028-08-01');
    expect(new Set(months.map((m) => m.month)).size).toBe(24);
  });

  it('never reports a negative investable surplus without flagging it', () => {
    const months = project(24);
    for (const m of months) expect(m.investablePaise).toBeGreaterThan(0n);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test tests/domain/surplus.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/domain/surplus.ts`**

```ts
import { ASSUMPTIONS } from '../config/assumptions.js';
import { addP, mulP, rupees, type Paise } from '../money/paise.js';
import { nextMonth, type ScheduleRow } from './loans.js';

/** PRD §2.2 non-loan fixed outflows. Mother's support is permanent. */
export const FIXED_OUTFLOWS = {
  rent: rupees(31_500),
  motherSupport: rupees(20_000),
  wifeAllowance: rupees(10_000),
  maidAndMaintenance: rupees(5_850),
  misc: rupees(10_000),
} as const;

export const BASE_TAKE_HOME = rupees(215_000);

export interface SurplusMonth {
  month: string;
  takeHomePaise: Paise;
  loanOutflowPaise: Paise;
  fixedOutflowPaise: Paise;
  childDentPaise: Paise;
  investablePaise: Paise;
}

export function loanOutflowByMonth(rows: ScheduleRow[]): Map<string, Paise> {
  const map = new Map<string, Paise>();
  for (const r of rows) {
    map.set(r.month, ((map.get(r.month) ?? 0n) + r.paymentPaise) as Paise);
  }
  return map;
}

/** Take-home steps up 10% every April (fiscal-year boundary). */
function takeHomeFor(month: string, base: Paise, from: string): Paise {
  const fiscalYear = (m: string) => {
    const [y, mm] = m.split('-').map(Number) as [number, number];
    return mm >= 4 ? y : y - 1;
  };
  const steps = fiscalYear(month) - fiscalYear(from);
  return steps <= 0 ? base : mulP(base, (1 + ASSUMPTIONS.sipStepUp) ** steps);
}

function childDentFor(month: string): Paise {
  return month >= `${ASSUMPTIONS.childArrivalYear}-01-01`
    ? rupees(ASSUMPTIONS.childMonthlyDentInr)
    : (0n as Paise);
}

export function projectSurplus(opts: {
  from: string;
  months: number;
  closures: Map<string, string>;
  loanOutflowByMonth: Map<string, Paise>;
}): SurplusMonth[] {
  const fixed = addP(
    FIXED_OUTFLOWS.rent, FIXED_OUTFLOWS.motherSupport, FIXED_OUTFLOWS.wifeAllowance,
    FIXED_OUTFLOWS.maidAndMaintenance, FIXED_OUTFLOWS.misc,
  );

  const out: SurplusMonth[] = [];
  let month = opts.from;
  for (let i = 0; i < opts.months; i++) {
    const takeHome = takeHomeFor(month, BASE_TAKE_HOME, opts.from);
    const loanOutflow = opts.loanOutflowByMonth.get(month) ?? (0n as Paise);
    const childDent = childDentFor(month);
    const investable = (takeHome - loanOutflow - fixed - childDent) as Paise;

    out.push({
      month, takeHomePaise: takeHome, loanOutflowPaise: loanOutflow,
      fixedOutflowPaise: fixed, childDentPaise: childDent, investablePaise: investable,
    });
    month = nextMonth(month);
  }
  return out;
}

export function projectAnnualSurplus(opts: {
  fromYear: number;
  toYear: number;
  monthly: SurplusMonth[];
}): { year: number; investablePaise: Paise }[] {
  const byYear = new Map<number, Paise>();
  for (const m of opts.monthly) {
    const year = Number(m.month.slice(0, 4));
    if (year < opts.fromYear || year > opts.toYear) continue;
    byYear.set(year, ((byYear.get(year) ?? 0n) + m.investablePaise) as Paise);
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, investablePaise]) => ({ year, investablePaise }));
}
```

> **Implementer note:** the PRD states ₹76,000 investable surplus *inclusive of existing SIPs*. This model derives ₹82,124 (₹2,15,000 − ₹55,526 loans − ₹77,350 fixed) rather than hardcoding it; the ~₹6,100 gap is the PRD's "+ electricity" line, which has no figure yet. Do **not** tune the model to hit ₹76,000 — the derived number is the honest one and the test asserts it exactly. When the owner supplies an electricity figure, add it to `FIXED_OUTFLOWS.misc` and update the expected value in the same commit; the test is designed to fail loudly when that happens, which is the point.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/domain/surplus.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(domain): investable surplus curve with step-up, child dent and loan release"
```

---

### Task 8: RSU vest projection

**Files:**
- Create: `src/domain/rsu.ts`
- Test: `tests/domain/rsu.test.ts`

**Interfaces:**
- Consumes: `Cents`/`Paise`, `usdToInr`, `rateMicros` (Task 4); `SEED_RSU_GRANTS` (Task 5); `ASSUMPTIONS` (Task 1).
- Produces:
  - `interface VestEvent { grantId: string; vestOn: string; units: number; status: 'PROJECTED' | 'ACTUAL'; grossPaise: Paise; netPaise: Paise }`
  - `projectVests(grants: RsuGrantSeed[], opts: { priceUsd: number; usdInr: number; from: string; to: string }): VestEvent[]`
  - `withRefreshers(grants: RsuGrantSeed[], opts: { fromYear: number; toYear: number; priceUsd: number }): RsuGrantSeed[]`
  - `unvestedValue(vests: VestEvent[], asOf: string): Paise`
  - `persistVests(db: Db, vests: VestEvent[]): Promise<void>` — upserts PROJECTED rows, never overwrites ACTUAL
  - `confirmVest(db: Db, id: string, actual: { units: number; priceUsdCents: bigint; usdInrMicros: bigint; netPaise: Paise }): Promise<void>`

**Model rules (PRD §2.4):** quarterly vests on the 15th of Feb/May/Aug/Nov over 4 years (16 tranches per grant); net-of-withholding factor 0.70; refresher grants of $20,000/year converted to units at the seed price. A PROJECTED vest is never allowed to overwrite an owner-confirmed ACTUAL.

- [ ] **Step 1: Write the failing test**

`tests/domain/rsu.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';
import { confirmVest, persistVests, projectVests, unvestedValue, withRefreshers } from '../../src/domain/rsu.js';
import { SEED_RSU_GRANTS } from '../../src/seed/seed-data.js';

const opts = {
  priceUsd: ASSUMPTIONS.seedNowPriceUsd,
  usdInr: ASSUMPTIONS.seedUsdInr,
  from: '2026-09-01',
  to: '2030-12-31',
};

describe('vest projection', () => {
  const vests = projectVests(SEED_RSU_GRANTS, opts);

  it('vests quarterly on the 15th of Feb, May, Aug and Nov', () => {
    const months = new Set(vests.map((v) => v.vestOn.slice(5)));
    expect([...months].sort()).toEqual(['02-15', '05-15', '08-15', '11-15']);
  });

  it('nets vests down to 70% of gross for withholding', () => {
    const v = vests[0]!;
    expect(Number(v.netPaise) / Number(v.grossPaise)).toBeCloseTo(0.70, 2);
  });

  it('projects roughly the PRD unvested total of 53.25L at the seed price', () => {
    const total = unvestedValue(projectVests(SEED_RSU_GRANTS, { ...opts, to: '2031-12-31' }), '2026-09-01');
    const lakhs = Number(total / 100n) / 100_000;
    expect(lakhs).toBeGreaterThan(35);
    expect(lakhs).toBeLessThan(70);
  });

  it('marks every projected vest PROJECTED, never ACTUAL', () => {
    expect(vests.every((v) => v.status === 'PROJECTED')).toBe(true);
  });

  it('excludes vests outside the requested window', () => {
    expect(vests.every((v) => v.vestOn >= opts.from && v.vestOn <= opts.to)).toBe(true);
  });
});

describe('refresher scenario', () => {
  it('adds one $20k grant per year on top of the base grants', () => {
    const withR = withRefreshers(SEED_RSU_GRANTS, {
      fromYear: 2027, toYear: 2030, priceUsd: ASSUMPTIONS.seedNowPriceUsd,
    });
    expect(withR).toHaveLength(SEED_RSU_GRANTS.length + 4);
    const refresher = withR.find((g) => g.id === 'REFRESH-2027')!;
    expect(refresher.units).toBeCloseTo(20_000 / ASSUMPTIONS.seedNowPriceUsd, 2);
  });

  it('leaves the base grants untouched so the no-refresher downside stays available', () => {
    const before = JSON.stringify(SEED_RSU_GRANTS);
    withRefreshers(SEED_RSU_GRANTS, { fromYear: 2027, toYear: 2030, priceUsd: 127.54 });
    expect(JSON.stringify(SEED_RSU_GRANTS)).toBe(before);
  });
});

describe('persistence and reconciliation', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
  });

  it('upserts projected vests idempotently', async () => {
    const vests = projectVests(SEED_RSU_GRANTS, opts);
    await persistVests(db, vests);
    await persistVests(db, vests);
    const [{ n }] = await db.query<{ n: string }>('select count(*) as n from rsu_vests');
    expect(Number(n)).toBe(vests.length);
  });

  it('never lets a re-projection overwrite an owner-confirmed ACTUAL', async () => {
    const vests = projectVests(SEED_RSU_GRANTS, opts);
    await persistVests(db, vests);
    const [row] = await db.query<{ id: string }>('select id from rsu_vests order by vest_on limit 1');
    await confirmVest(db, row!.id, {
      units: 9, priceUsdCents: 15_000n, usdInrMicros: 96_000_000n, netPaise: 900_000n as never,
    });
    await persistVests(db, vests);
    const [after] = await db.query<{ status: string; net_paise: string }>(
      'select status, net_paise from rsu_vests where id = $1', [row!.id],
    );
    expect(after!.status).toBe('ACTUAL');
    expect(after!.net_paise).toBe('900000');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test tests/domain/rsu.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/domain/rsu.ts`**

```ts
import { ASSUMPTIONS } from '../config/assumptions.js';
import type { Db } from '../db/client.js';
import { rateMicros, usdToInr } from '../money/fx.js';
import { cents, mulP, type Paise } from '../money/paise.js';
import type { RsuGrantSeed } from '../seed/seed-data.js';

const VEST_MONTHS = ['02', '05', '08', '11'] as const;
const VEST_DAY = '15';

export interface VestEvent {
  grantId: string;
  vestOn: string;
  units: number;
  status: 'PROJECTED' | 'ACTUAL';
  grossPaise: Paise;
  netPaise: Paise;
}

/** Quarterly tranche dates for a grant: 16 tranches over 4 years. */
function trancheDates(grantedOn: string, vestYears: number): string[] {
  const grantYear = Number(grantedOn.slice(0, 4));
  const dates: string[] = [];
  for (let y = grantYear; y <= grantYear + vestYears; y++) {
    for (const m of VEST_MONTHS) {
      const date = `${y}-${m}-${VEST_DAY}`;
      if (date > grantedOn) dates.push(date);
    }
  }
  return dates.slice(0, vestYears * VEST_MONTHS.length);
}

export function projectVests(
  grants: RsuGrantSeed[],
  opts: { priceUsd: number; usdInr: number; from: string; to: string },
): VestEvent[] {
  const micros = rateMicros(opts.usdInr);
  const priceCents = cents(BigInt(Math.round(opts.priceUsd * 100)));
  const events: VestEvent[] = [];

  for (const grant of grants) {
    const dates = trancheDates(grant.grantedOn, ASSUMPTIONS.rsuVestYears);
    const unitsPerTranche = grant.units / dates.length;
    for (const vestOn of dates) {
      if (vestOn < opts.from || vestOn > opts.to) continue;
      const trancheCents = cents(
        BigInt(Math.round(Number(priceCents) * unitsPerTranche)),
      );
      const gross = usdToInr(trancheCents, micros);
      events.push({
        grantId: grant.id,
        vestOn,
        units: unitsPerTranche,
        status: 'PROJECTED',
        grossPaise: gross,
        netPaise: mulP(gross, ASSUMPTIONS.rsuNetOfWithholding),
      });
    }
  }
  return events.sort((a, b) => a.vestOn.localeCompare(b.vestOn));
}

/** PRD §15.2 base case: $20k/year refreshers. Pure — base grants are not mutated. */
export function withRefreshers(
  grants: RsuGrantSeed[],
  opts: { fromYear: number; toYear: number; priceUsd: number },
): RsuGrantSeed[] {
  const extra: RsuGrantSeed[] = [];
  for (let y = opts.fromYear; y <= opts.toYear; y++) {
    extra.push({
      id: `REFRESH-${y}`,
      grantedOn: `${y}-02-15`,
      units: ASSUMPTIONS.rsuRefresherUsdPerYear / opts.priceUsd,
      note: `Assumed $${ASSUMPTIONS.rsuRefresherUsdPerYear} refresher (PRD §15.2)`,
    });
  }
  return [...grants, ...extra];
}

export function unvestedValue(vests: VestEvent[], asOf: string): Paise {
  return vests
    .filter((v) => v.vestOn > asOf)
    .reduce((sum, v) => sum + v.grossPaise, 0n) as Paise;
}

/** Upserts PROJECTED rows. An owner-confirmed ACTUAL is never overwritten (FR-03). */
export async function persistVests(db: Db, vests: VestEvent[]): Promise<void> {
  const asOf = new Date().toISOString();
  for (const v of vests) {
    const existing = await db.query<{ id: string; status: string }>(
      'select id, status from rsu_vests where grant_id = $1 and vest_on = $2',
      [v.grantId, v.vestOn],
    );
    if (existing[0]?.status === 'ACTUAL') continue;
    if (existing[0]) {
      await db.query(
        `update rsu_vests set units = $2, gross_paise = $3, net_paise = $4, as_of = $5
         where id = $1`,
        [existing[0].id, v.units, v.grossPaise.toString(), v.netPaise.toString(), asOf],
      );
    } else {
      await db.query(
        `insert into rsu_vests (grant_id, vest_on, units, status, gross_paise, net_paise, as_of, source)
         values ($1,$2,$3,'PROJECTED',$4,$5,$6,'model')`,
        [v.grantId, v.vestOn, v.units, v.grossPaise.toString(), v.netPaise.toString(), asOf],
      );
    }
  }
}

/** Quarterly reconciliation (FR-03): owner confirms actuals; the row becomes immutable to the model. */
export async function confirmVest(
  db: Db,
  id: string,
  actual: { units: number; priceUsdCents: bigint; usdInrMicros: bigint; netPaise: Paise },
): Promise<void> {
  await db.query(
    `update rsu_vests
       set status = 'ACTUAL', units = $2, price_usd_cents = $3, usdinr_micros = $4,
           net_paise = $5, confirmed_on = current_date, source = 'owner-confirmed'
     where id = $1`,
    [id, actual.units, actual.priceUsdCents.toString(), actual.usdInrMicros.toString(),
     actual.netPaise.toString()],
  );
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('rsu_vest', $1, 'CONFIRMED', 'owner', $2::jsonb)`,
    [id, JSON.stringify({ units: actual.units })],
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/domain/rsu.test.ts`
Expected: PASS (9 tests). The unvested-total band is deliberately wide (₹35–70L) because the seeded per-grant split is an estimate; tighten it only after the owner reconciles against the Fidelity statement.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(domain): RSU vest projection, refresher scenario and owner reconciliation"
```

---

### Task 9: Net worth and allocation drift

**Files:**
- Create: `src/domain/networth.ts`, `src/domain/allocation.ts`
- Test: `tests/domain/networth.test.ts`, `tests/domain/allocation.test.ts`

**Interfaces:**
- Consumes: `Paise`, `addP`, `pctOf` (Task 4); schema (Task 3); seed (Task 5); loan schedules (Task 6).
- Produces:
  - `interface Position { instrumentId: string; kind: InstrumentKind; account: Account; valuePaise: Paise; avgCostPaise: Paise | null; assetClass: AssetClass; issuer: string | null; isEmployer: boolean; asOf: string; source: string }`
  - `type AssetClass = 'EQUITY' | 'DEBT' | 'GOLD' | 'CASH'`
  - `loadPositions(db: Db, businessDate?: string): Promise<Position[]>` — latest snapshot per source, merged
  - `netWorth(positions: Position[], liabilitiesPaise: Paise): { assetsPaise: Paise; liabilitiesPaise: Paise; netPaise: Paise; byAccount: Map<Account, Paise>; byAssetClass: Map<AssetClass, Paise> }`
  - `outstandingLiabilities(db: Db, asOfMonth: string): Promise<Paise>`
  - `IPS_BANDS: Record<AssetClass, { min: number; max: number }>` (PRD §3.3)
  - `allocationDrift(byAssetClass: Map<AssetClass, Paise>, total: Paise): DriftRow[]` where `interface DriftRow { assetClass: AssetClass; actual: number; min: number; max: number; breach: 'OVER' | 'UNDER' | null; driftPaise: Paise }`
  - `concentration(positions: Position[]): { topStockPct: number; employerPct: number; byIssuer: Map<string, number>; breaches: string[] }`

**Asset-class mapping (PRD §3.3):** `EQUITY` ← EQUITY/ETF/RSU and equity MFs; `DEBT` ← BOND/EPF and debt/liquid MFs; `GOLD` ← GOLD; `CASH` ← CASH. `NSE:LIQUIDBEES` is DEBT, not EQUITY. EPF counts as debt-like ballast. Bands: equity ceiling 60%, gold 5–10%, remainder debt/cash.

- [ ] **Step 1: Write the failing test for net worth**

`tests/domain/networth.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { persistSchedules } from '../../src/domain/loans.js';
import { loadPositions, netWorth, outstandingLiabilities } from '../../src/domain/networth.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
  await persistSchedules(db, '2026-09-01');
});

describe('net worth', () => {
  it('includes Fidelity NOW and EPF, which no other tool the owner has can see', async () => {
    const positions = await loadPositions(db);
    const nw = netWorth(positions, 0n as never);
    expect(nw.byAccount.get('fidelity')).toBeGreaterThan(0n);
    expect(nw.byAccount.get('epf')).toBeGreaterThan(0n);
    expect(Number(nw.assetsPaise / 100n)).toBeGreaterThan(4_600_000);
  });

  it('subtracts outstanding loans to give a true net figure', async () => {
    const positions = await loadPositions(db);
    const liabilities = await outstandingLiabilities(db, '2026-09-01');
    const nw = netWorth(positions, liabilities);
    expect(nw.netPaise).toBe(nw.assetsPaise - nw.liabilitiesPaise);
    expect(Number(nw.liabilitiesPaise / 100n)).toBeGreaterThan(3_500_000);
  });

  it('classifies EPF and liquid ETF as debt, gold ETF as gold', async () => {
    const positions = await loadPositions(db);
    const byId = new Map(positions.map((p) => [p.instrumentId, p]));
    expect(byId.get('EPF:ANIRBAN')!.assetClass).toBe('DEBT');
    expect(byId.get('NSE:LIQUIDBEES')!.assetClass).toBe('DEBT');
    expect(byId.get('NSE:GOLDBEES')!.assetClass).toBe('GOLD');
    expect(byId.get('US:NOW')!.assetClass).toBe('EQUITY');
  });

  it('carries as_of and source on every position for the staleness engine', async () => {
    const positions = await loadPositions(db);
    expect(positions.every((p) => p.asOf && p.source)).toBe(true);
  });

  it('preserves unknown cost as null rather than coercing to zero', async () => {
    const positions = await loadPositions(db);
    expect(positions.some((p) => p.avgCostPaise === null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test tests/domain/networth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/domain/networth.ts`**

```ts
import type { Db } from '../db/client.js';
import { addP, type Paise } from '../money/paise.js';
import type { Account } from '../seed/seed-data.js';

export type InstrumentKind = 'EQUITY' | 'ETF' | 'MF' | 'BOND' | 'CASH' | 'EPF' | 'RSU' | 'GOLD';
export type AssetClass = 'EQUITY' | 'DEBT' | 'GOLD' | 'CASH';

export interface Position {
  instrumentId: string;
  kind: InstrumentKind;
  account: Account;
  valuePaise: Paise;
  avgCostPaise: Paise | null;
  assetClass: AssetClass;
  issuer: string | null;
  isEmployer: boolean;
  asOf: string;
  source: string;
}

/** Debt-like instruments that are not BOND/EPF by kind. EPF is ballast, not equity. */
const DEBT_INSTRUMENTS = new Set(['NSE:LIQUIDBEES']);
const DEBT_MF_HINT = /liquid|debt|arbitrage|gilt|bond/i;

export function classify(kind: InstrumentKind, instrumentId: string, name: string): AssetClass {
  if (kind === 'GOLD') return 'GOLD';
  if (kind === 'CASH') return 'CASH';
  if (kind === 'BOND' || kind === 'EPF') return 'DEBT';
  if (DEBT_INSTRUMENTS.has(instrumentId)) return 'DEBT';
  if (kind === 'MF' && DEBT_MF_HINT.test(name)) return 'DEBT';
  return 'EQUITY';
}

interface HoldingRow {
  instrument_id: string;
  kind: InstrumentKind;
  name: string;
  account: Account;
  value_paise: string;
  avg_cost_paise: string | null;
  issuer: string | null;
  is_employer: boolean;
  as_of: string;
  source: string;
}

/**
 * One position set = the latest snapshot from each source, merged. A stale source
 * still contributes its last-known rows; the staleness engine (Task 12) is what
 * flags them — silently dropping them would understate net worth.
 */
export async function loadPositions(db: Db, businessDate?: string): Promise<Position[]> {
  const rows = await db.query<HoldingRow>(
    `with latest as (
       select distinct on (s.source) s.id, s.source
       from snapshots s
       where ($1::date is null or s.business_date <= $1::date)
       order by s.source, s.business_date desc, s.taken_at desc
     )
     select h.instrument_id, i.kind, i.name, h.account, h.value_paise, h.avg_cost_paise,
            i.issuer, i.is_employer, h.as_of, h.source
     from holdings h
     join latest l on l.id = h.snapshot_id
     join instruments i on i.id = h.instrument_id`,
    [businessDate ?? null],
  );

  return rows.map((r) => ({
    instrumentId: r.instrument_id,
    kind: r.kind,
    account: r.account,
    valuePaise: BigInt(r.value_paise) as Paise,
    avgCostPaise: r.avg_cost_paise === null ? null : (BigInt(r.avg_cost_paise) as Paise),
    assetClass: classify(r.kind, r.instrument_id, r.name),
    issuer: r.issuer,
    isEmployer: r.is_employer,
    asOf: typeof r.as_of === 'string' ? r.as_of : new Date(r.as_of).toISOString(),
    source: r.source,
  }));
}

export function netWorth(positions: Position[], liabilitiesPaise: Paise) {
  const byAccount = new Map<Account, Paise>();
  const byAssetClass = new Map<AssetClass, Paise>();

  for (const p of positions) {
    byAccount.set(p.account, ((byAccount.get(p.account) ?? 0n) + p.valuePaise) as Paise);
    byAssetClass.set(
      p.assetClass, ((byAssetClass.get(p.assetClass) ?? 0n) + p.valuePaise) as Paise,
    );
  }

  const assetsPaise = addP(...positions.map((p) => p.valuePaise));
  return {
    assetsPaise,
    liabilitiesPaise,
    netPaise: (assetsPaise - liabilitiesPaise) as Paise,
    byAccount,
    byAssetClass,
  };
}

/** Closing balance of every loan in the CASCADE scenario for the given month. */
export async function outstandingLiabilities(db: Db, asOfMonth: string): Promise<Paise> {
  const rows = await db.query<{ closing_paise: string }>(
    `select distinct on (loan_id) closing_paise
     from loan_schedule
     where scenario = 'CASCADE' and period_month <= $1
     order by loan_id, period_month desc`,
    [asOfMonth],
  );
  return rows.reduce((sum, r) => sum + BigInt(r.closing_paise), 0n) as Paise;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/domain/networth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing test for allocation drift**

`tests/domain/allocation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { allocationDrift, concentration, IPS_BANDS } from '../../src/domain/allocation.js';
import { rupees } from '../../src/money/paise.js';
import type { AssetClass, Position } from '../../src/domain/networth.js';

const pos = (o: Partial<Position> & { instrumentId: string; valuePaise: bigint; assetClass: AssetClass }): Position => ({
  kind: 'EQUITY', account: 'zerodha', avgCostPaise: null, issuer: null, isEmployer: false,
  asOf: '2026-08-12T00:00:00+05:30', source: 'test', ...o,
} as Position);

describe('IPS bands', () => {
  it('caps equity at 60% and bands gold 5-10% (PRD 3.3)', () => {
    expect(IPS_BANDS.EQUITY.max).toBe(0.60);
    expect(IPS_BANDS.GOLD.min).toBe(0.05);
    expect(IPS_BANDS.GOLD.max).toBe(0.10);
  });
});

describe('allocationDrift', () => {
  it('flags an equity overweight beyond the ceiling', () => {
    const byClass = new Map<AssetClass, bigint>([
      ['EQUITY', rupees(700_000)], ['DEBT', rupees(300_000)],
    ]);
    const rows = allocationDrift(byClass as never, rupees(1_000_000));
    const equity = rows.find((r) => r.assetClass === 'EQUITY')!;
    expect(equity.actual).toBeCloseTo(0.70, 4);
    expect(equity.breach).toBe('OVER');
    expect(Number(equity.driftPaise / 100n)).toBe(100_000); // 10% of 10L to sell
  });

  it('flags a gold underweight below the band', () => {
    const byClass = new Map<AssetClass, bigint>([
      ['EQUITY', rupees(500_000)], ['GOLD', rupees(10_000)], ['DEBT', rupees(490_000)],
    ]);
    const rows = allocationDrift(byClass as never, rupees(1_000_000));
    expect(rows.find((r) => r.assetClass === 'GOLD')!.breach).toBe('UNDER');
  });

  it('reports no breach inside the bands', () => {
    const byClass = new Map<AssetClass, bigint>([
      ['EQUITY', rupees(550_000)], ['GOLD', rupees(70_000)], ['DEBT', rupees(380_000)],
    ]);
    const rows = allocationDrift(byClass as never, rupees(1_000_000));
    expect(rows.every((r) => r.breach === null)).toBe(true);
  });

  it('returns a row for every asset class even when unheld', () => {
    const rows = allocationDrift(new Map([['EQUITY', rupees(100_000)]]) as never, rupees(100_000));
    expect(rows.map((r) => r.assetClass).sort()).toEqual(['CASH', 'DEBT', 'EQUITY', 'GOLD']);
  });
});

describe('concentration caps (PRD 3.5)', () => {
  it('breaches the 10% employer cap on NOW', () => {
    const positions = [
      pos({ instrumentId: 'US:NOW', valuePaise: rupees(200_000), assetClass: 'EQUITY', isEmployer: true, issuer: 'ServiceNow' }),
      pos({ instrumentId: 'MF:X', valuePaise: rupees(800_000), assetClass: 'EQUITY', kind: 'MF' }),
    ];
    const c = concentration(positions);
    expect(c.employerPct).toBeCloseTo(0.20, 4);
    expect(c.breaches.some((b) => /employer/i.test(b))).toBe(true);
  });

  it('breaches the 10% single-issuer cap aggregated across equity and credit', () => {
    const positions = [
      pos({ instrumentId: 'BOND:SAMMAAN-2026', valuePaise: rupees(80_000), assetClass: 'DEBT', kind: 'BOND', issuer: 'Sammaan Capital' }),
      pos({ instrumentId: 'BOND:SAMMAAN-2029', valuePaise: rupees(40_000), assetClass: 'DEBT', kind: 'BOND', issuer: 'Sammaan Capital' }),
      pos({ instrumentId: 'MF:X', valuePaise: rupees(880_000), assetClass: 'EQUITY', kind: 'MF' }),
    ];
    const c = concentration(positions);
    expect(c.byIssuer.get('Sammaan Capital')).toBeCloseTo(0.12, 4);
    expect(c.breaches.some((b) => /Sammaan/.test(b))).toBe(true);
  });

  it('excludes index funds from the single-stock cap', () => {
    const positions = [
      pos({ instrumentId: 'MF:ICICI-NIFTY50-IDX', valuePaise: rupees(900_000), assetClass: 'EQUITY', kind: 'MF' }),
      pos({ instrumentId: 'NSE:TATASTEEL', valuePaise: rupees(100_000), assetClass: 'EQUITY' }),
    ];
    expect(concentration(positions).topStockPct).toBeCloseTo(0.10, 4);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

Run: `pnpm test tests/domain/allocation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 7: Write `src/domain/allocation.ts`**

```ts
import { pctOf, type Paise } from '../money/paise.js';
import type { AssetClass, Position } from './networth.js';

/** PRD §3.3 strategic allocation. Equity is a ceiling; gold is a band. */
export const IPS_BANDS: Record<AssetClass, { min: number; max: number }> = {
  EQUITY: { min: 0.00, max: 0.60 },
  GOLD: { min: 0.05, max: 0.10 },
  DEBT: { min: 0.25, max: 1.00 },
  CASH: { min: 0.00, max: 0.20 },
};

/** PRD §3.5 hard concentration caps. */
export const CAPS = {
  singleStock: 0.10,
  singleIssuer: 0.10,
  singleMfScheme: 0.35,
  singleSector: 0.25,
  employer: 0.10,
} as const;

const ALL_CLASSES: AssetClass[] = ['CASH', 'DEBT', 'EQUITY', 'GOLD'];

export interface DriftRow {
  assetClass: AssetClass;
  actual: number;
  min: number;
  max: number;
  breach: 'OVER' | 'UNDER' | null;
  /** Rupees that would have to move to return to the nearest band edge. */
  driftPaise: Paise;
}

export function allocationDrift(
  byAssetClass: Map<AssetClass, Paise>,
  total: Paise,
): DriftRow[] {
  return ALL_CLASSES.map((assetClass) => {
    const value = byAssetClass.get(assetClass) ?? (0n as Paise);
    const actual = pctOf(value, total);
    const { min, max } = IPS_BANDS[assetClass];
    const breach = actual > max ? 'OVER' : actual < min ? 'UNDER' : null;
    const targetPct = breach === 'OVER' ? max : breach === 'UNDER' ? min : actual;
    const targetValue = BigInt(Math.round(targetPct * Number(total)));
    const driftPaise = (breach ? (value > targetValue ? value - targetValue : targetValue - value) : 0n) as Paise;
    return { assetClass, actual, min, max, breach, driftPaise };
  }).sort((a, b) => a.assetClass.localeCompare(b.assetClass));
}

/** Index funds and ETFs are pooled vehicles, exempt from the single-stock cap. */
const isDirectStock = (p: Position): boolean => p.kind === 'EQUITY' || p.kind === 'RSU';

export function concentration(positions: Position[]) {
  const total = positions.reduce((s, p) => s + p.valuePaise, 0n) as Paise;
  const breaches: string[] = [];

  const stockPcts = positions
    .filter(isDirectStock)
    .map((p) => ({ id: p.instrumentId, pct: pctOf(p.valuePaise, total) }));
  const topStockPct = stockPcts.reduce((m, s) => Math.max(m, s.pct), 0);
  for (const s of stockPcts) {
    if (s.pct > CAPS.singleStock) {
      breaches.push(`Single-stock cap: ${s.id} at ${(s.pct * 100).toFixed(1)}% (cap ${CAPS.singleStock * 100}%)`);
    }
  }

  const employerValue = positions
    .filter((p) => p.isEmployer)
    .reduce((s, p) => s + p.valuePaise, 0n) as Paise;
  const employerPct = pctOf(employerValue, total);
  if (employerPct > CAPS.employer) {
    breaches.push(`Employer cap: NOW at ${(employerPct * 100).toFixed(1)}% (cap ${CAPS.employer * 100}%)`);
  }

  const byIssuer = new Map<string, number>();
  const issuerValues = new Map<string, Paise>();
  for (const p of positions) {
    if (!p.issuer) continue;
    issuerValues.set(p.issuer, ((issuerValues.get(p.issuer) ?? 0n) + p.valuePaise) as Paise);
  }
  for (const [issuer, value] of issuerValues) {
    const pct = pctOf(value, total);
    byIssuer.set(issuer, pct);
    if (pct > CAPS.singleIssuer) {
      breaches.push(`Single-issuer cap: ${issuer} at ${(pct * 100).toFixed(1)}% (cap ${CAPS.singleIssuer * 100}%)`);
    }
  }

  return { topStockPct, employerPct, byIssuer, breaches };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test tests/domain`
Expected: PASS. The seeded portfolio genuinely breaches the employer and Sammaan issuer caps — that is the point of the product, and Phase 2 turns those breaches into recommendations.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(domain): net worth aggregation, IPS allocation drift and concentration caps"
```

---

### Task 10: Buckets, milestones and funded status

**Files:**
- Create: `src/domain/buckets.ts`, `src/domain/funded-status.ts`
- Test: `tests/domain/buckets.test.ts`, `tests/domain/funded-status.test.ts`, `tests/architecture/no-catch-up.test.ts`

**Interfaces:**
- Consumes: `Paise` (Task 4), schema (Task 3), seed (Task 5), `ASSUMPTIONS` (Task 1).
- Produces:
  - `interface BucketStatus { id: 'B1'|'B2'|'B3'|'B4'; name: string; balancePaise: Paise; targetPaise: Paise | null; targetNote: string; fundedRatio: number | null; active: boolean }`
  - `bucketStatuses(db: Db): Promise<BucketStatus[]>`
  - `recordFlow(db: Db, flow: { bucketId: string; occurredOn: string; amountPaise: Paise; kind: string; note?: string; source: string }): Promise<void>`
  - `interface MilestoneStatus { id: 'M1'|'M2'; name: string; spec: string; completedOn: string | null; daysOutstanding: number }`
  - `milestoneStatuses(db: Db, asOf: string): Promise<MilestoneStatus[]>`
  - `fiCorpusBand(): { floorPaise: Paise; stretchPaise: Paise }` and `fundedStatus(corpusPaise: Paise): { floorRatio: number; stretchRatio: number }` — **reporting only**

**FR-16 / §11.9 — the no-catch-up property:** `src/domain/funded-status.ts` may import from anywhere; **nothing may import it except reporting code** (`notify/`, `jobs/`). A test enforces this by scanning imports. When Phase 1 adds sizing and risk functions, this test is what keeps the catch-up failure mode structurally impossible.

- [ ] **Step 1: Write the failing test for buckets**

`tests/domain/buckets.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { bucketStatuses, milestoneStatuses, recordFlow } from '../../src/domain/buckets.js';
import { rupees } from '../../src/money/paise.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

describe('buckets', () => {
  it('reports all four buckets, empty until flows are recorded', async () => {
    const statuses = await bucketStatuses(db);
    expect(statuses.map((b) => b.id)).toEqual(['B1', 'B2', 'B3', 'B4']);
    expect(statuses.every((b) => b.balancePaise === 0n)).toBe(true);
  });

  it('accumulates flows into balances and funded ratios', async () => {
    await recordFlow(db, {
      bucketId: 'B3', occurredOn: '2026-09-26', amountPaise: rupees(310_000),
      kind: 'maturity', note: 'Sammaan Sep-2026 maturity incl. final coupon', source: 'manual',
    });
    const b3 = (await bucketStatuses(db)).find((b) => b.id === 'B3')!;
    expect(b3.balancePaise).toBe(rupees(310_000));
    expect(b3.fundedRatio).toBeCloseTo(310_000 / 600_000, 4);
  });

  it('handles withdrawals as negative flows', async () => {
    await recordFlow(db, { bucketId: 'B3', occurredOn: '2026-09-26', amountPaise: rupees(310_000), kind: 'maturity', source: 'manual' });
    await recordFlow(db, { bucketId: 'B3', occurredOn: '2026-11-01', amountPaise: rupees(-50_000), kind: 'withdrawal', source: 'manual' });
    const b3 = (await bucketStatuses(db)).find((b) => b.id === 'B3')!;
    expect(b3.balancePaise).toBe(rupees(260_000));
  });

  it('reports no funded ratio for B1, whose target is a real-terms band not a rupee figure', async () => {
    const b1 = (await bucketStatuses(db)).find((b) => b.id === 'B1')!;
    expect(b1.targetPaise).toBeNull();
    expect(b1.fundedRatio).toBeNull();
    expect(b1.targetNote).toMatch(/age 55/);
  });

  it('audits every flow', async () => {
    await recordFlow(db, { bucketId: 'B2', occurredOn: '2026-11-15', amountPaise: rupees(150_000), kind: 'vest', source: 'manual' });
    const rows = await db.query<{ action: string }>(`select action from audit_log where entity = 'bucket_flow'`);
    expect(rows[0]!.action).toBe('FLOW_RECORDED');
  });
});

describe('milestones', () => {
  it('nags on both incomplete milestones with a days-outstanding count', async () => {
    const statuses = await milestoneStatuses(db, '2026-09-12');
    expect(statuses).toHaveLength(2);
    expect(statuses.every((m) => m.completedOn === null)).toBe(true);
    expect(statuses[0]!.daysOutstanding).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test tests/domain/buckets.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/domain/buckets.ts`**

```ts
import type { Db } from '../db/client.js';
import type { Paise } from '../money/paise.js';

export type BucketId = 'B1' | 'B2' | 'B3' | 'B4';
export type MilestoneId = 'M1' | 'M2';

export interface BucketStatus {
  id: BucketId;
  name: string;
  mandate: string;
  balancePaise: Paise;
  targetPaise: Paise | null;
  targetNote: string;
  /** null when the target is a real-terms band rather than a rupee figure (B1). */
  fundedRatio: number | null;
  active: boolean;
}

export async function bucketStatuses(db: Db): Promise<BucketStatus[]> {
  const rows = await db.query<{
    id: BucketId; name: string; mandate: string; target_paise: string | null;
    target_note: string; active: boolean; balance: string | null;
  }>(
    `select b.id, b.name, b.mandate, b.target_paise, b.target_note, b.active,
            (select sum(f.amount_paise) from bucket_flows f where f.bucket_id = b.id) as balance
     from buckets b order by b.id`,
  );

  return rows.map((r) => {
    const balancePaise = BigInt(r.balance ?? '0') as Paise;
    const targetPaise = r.target_paise === null ? null : (BigInt(r.target_paise) as Paise);
    return {
      id: r.id, name: r.name, mandate: r.mandate,
      balancePaise, targetPaise, targetNote: r.target_note, active: r.active,
      fundedRatio:
        targetPaise === null || targetPaise === 0n
          ? null
          : Number(balancePaise) / Number(targetPaise),
    };
  });
}

export async function recordFlow(
  db: Db,
  flow: { bucketId: string; occurredOn: string; amountPaise: Paise; kind: string; note?: string; source: string },
): Promise<void> {
  await db.query(
    `insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, note, as_of, source)
     values ($1,$2,$3,$4,$5,$6,$7)`,
    [flow.bucketId, flow.occurredOn, flow.amountPaise.toString(), flow.kind,
     flow.note ?? '', `${flow.occurredOn}T00:00:00+05:30`, flow.source],
  );
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('bucket_flow', $1, 'FLOW_RECORDED', 'agent', $2::jsonb)`,
    [flow.bucketId, JSON.stringify({ ...flow, amountPaise: flow.amountPaise.toString() })],
  );
}

export interface MilestoneStatus {
  id: MilestoneId;
  name: string;
  spec: string;
  rationale: string;
  completedOn: string | null;
  daysOutstanding: number;
}

/** M1/M2 nag until done (PRD §2.6). daysOutstanding counts from the requirements freeze. */
const FREEZE_DATE = '2026-08-12';

export async function milestoneStatuses(db: Db, asOf: string): Promise<MilestoneStatus[]> {
  const rows = await db.query<{
    id: MilestoneId; name: string; spec: string; rationale: string; completed_on: string | null;
  }>('select id, name, spec, rationale, completed_on from milestones order by id');

  const days = Math.floor(
    (Date.parse(asOf) - Date.parse(FREEZE_DATE)) / 86_400_000,
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, spec: r.spec, rationale: r.rationale,
    completedOn: r.completed_on,
    daysOutstanding: r.completed_on ? 0 : Math.max(days, 0),
  }));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/domain/buckets.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing tests for funded status and the no-catch-up property**

`tests/domain/funded-status.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fiCorpusBand, fundedStatus } from '../../src/domain/funded-status.js';
import { rupees } from '../../src/money/paise.js';

describe('FI corpus band', () => {
  it('derives 10.3 Cr floor and 17.1 Cr stretch at a 3.5% SWR', () => {
    const { floorPaise, stretchPaise } = fiCorpusBand();
    expect(Number(floorPaise / 100n) / 10_000_000).toBeCloseTo(10.3, 1);
    expect(Number(stretchPaise / 100n) / 10_000_000).toBeCloseTo(17.1, 1);
  });
});

describe('funded status', () => {
  it('reports ratios against both ends of the band', () => {
    const s = fundedStatus(rupees(103_000_000));
    expect(s.floorRatio).toBeCloseTo(1.0, 2);
    expect(s.stretchRatio).toBeLessThan(1.0);
  });

  it('reports honestly rather than flatteringly when behind', () => {
    expect(fundedStatus(rupees(4_800_000)).floorRatio).toBeLessThan(0.06);
  });
});
```

`tests/architecture/no-catch-up.test.ts`:

```ts
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : Promise.resolve([join(dir, e.name)]),
    ),
  );
  return files.flat();
}

/**
 * PRD FR-16 / §11.9: funded status is a REPORTING metric. No sizing, risk, or
 * allocation code may read it, so "catch-up" behaviour cannot be written by accident.
 *
 * READ THIS BEFORE WEAKENING ANYTHING BELOW.
 *
 * An earlier version of this test was a single regex, `/from '.*funded-status\.js'/`,
 * run over `src/**\/*.ts`. It enforced almost nothing. All four of these defeated it
 * without touching funded-status.ts at all:
 *
 *   1. PARAMETER INJECTION - the real risk. A sizing function never imports the module;
 *      instead `jobs/nightly.ts` (legitimately allowed to import it) computes the ratio
 *      and passes it in as `sizeRisk(portfolio, assumptions, fundedRatio)`. The sizing
 *      file contains no matching string, so the old test never even looked at it.
 *   2. Dynamic `await import('...')` has no `from` clause.
 *   3. Double-quoted imports - the regex hard-coded single quotes, and there is no lint
 *      config in this repo forcing quote style.
 *   4. Anything outside `src/` was never walked.
 *
 * So this version does four things instead:
 *   (a) builds a real import graph - any quote style, dynamic imports, re-exports - and
 *       tests TRANSITIVE reachability, across every source root, not just `src/`;
 *   (b) closes parameter injection at the type level: the ratios are branded, so a
 *       function that accepts one must name the brand, which the graph then sees. The
 *       only way around that is an explicit cast, which (c) hunts for;
 *   (c) flags brand-stripping casts inside the allowed reporting files;
 *   (d) runs the whole checker against fixtures that deliberately violate it, so the
 *       test proves it can still catch each bypass. Without (d) this test could rot into
 *       a no-op and stay green forever - which is exactly what happened to its ancestor.
 *
 * If you find yourself relaxing this test to make code pass, you are almost certainly
 * about to introduce catch-up behaviour. Change the code.
 */

const SOURCE_ROOTS = ['src'];           // extend if entry points ever live elsewhere
const MODULE = 'src/domain/funded-status.ts';
/** Only these may reach funded status. Reporting surfaces, nothing that decides size. */
const REPORTING = ['src/notify/', 'src/jobs/', 'src/render/'];

const norm = (p: string) => p.replace(/\\/g, '/');

/** Every specifier a file references, however it is written. */
function specifiersOf(source: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|\s)(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/g, // static import / re-export
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                       // dynamic import
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,                      // require
    /(?:^|\s)import\s*['"]([^'"]+)['"]/g,                           // bare side-effect import
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) out.push(m[1]!);
  }
  return out;
}

/** Resolve a relative specifier to a repo-relative .ts path. */
function resolveSpec(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;                     // package import, not ours
  const resolved = norm(join(dirname(fromFile), spec));
  return resolved.replace(/\.js$/, '.ts');
}

async function buildGraph(roots: string[]) {
  const files: string[] = [];
  for (const r of roots) files.push(...(await walk(r)).filter((f) => f.endsWith('.ts')));
  const graph = new Map<string, string[]>();
  const sources = new Map<string, string>();
  for (const f of files) {
    const key = norm(f);
    const src = await readFile(f, 'utf8');
    sources.set(key, src);
    graph.set(
      key,
      specifiersOf(src)
        .map((s) => resolveSpec(key, s))
        .filter((x): x is string => x !== null),
    );
  }
  return { graph, sources };
}

/** Files that can reach `target` by any chain of imports. */
function reachers(graph: Map<string, string[]>, target: string): string[] {
  const out: string[] = [];
  for (const start of graph.keys()) {
    if (start === target) continue;
    const seen = new Set<string>([start]);
    const stack = [...(graph.get(start) ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      if (next === target) { out.push(start); break; }
      stack.push(...(graph.get(next) ?? []));
    }
  }
  return out;
}

describe('no-catch-up property', () => {
  it('is reachable only from reporting code, transitively', async () => {
    const { graph } = await buildGraph(SOURCE_ROOTS);

    // Fail closed. If the walk breaks or the module is renamed, this test must go red
    // rather than pass by finding nothing to check.
    expect(graph.size, 'source walk found no files - checker is broken').toBeGreaterThan(5);
    expect([...graph.keys()], `${MODULE} not found - was it renamed?`).toContain(MODULE);

    const offenders = reachers(graph, MODULE)
      .filter((f) => !REPORTING.some((allowed) => f.includes(allowed)));

    expect(offenders, 'funded status must be reachable only from reporting code').toEqual([]);
  });

  it('closes parameter injection: the ratios are branded and the brand is not stripped',
    async () => {
      const { sources } = await buildGraph(SOURCE_ROOTS);

      // The brand is what stops `sizeRisk(portfolio, fundedRatio: number)` from compiling
      // without naming the type - which the import graph above would then catch.
      const module = sources.get(MODULE)!;
      expect(module, 'FundedRatio brand missing - parameter injection is reopened')
        .toMatch(/FundedRatio/);

      // The remaining escape hatch is an explicit cast in an allowed file. Casting a
      // funded ratio back to a bare number is exactly how it would get smuggled into a
      // sizing call, so require it to be impossible rather than merely discouraged.
      const smuggling: string[] = [];
      for (const [file, src] of sources) {
        if (!REPORTING.some((allowed) => file.includes(allowed))) continue;
        if (/\b(floorRatio|stretchRatio|fundedRatio)\b[^\n]*\bas\s+number\b/.test(src)
          || /\bNumber\s*\(\s*[^)]*\b(floorRatio|stretchRatio|fundedRatio)\b/.test(src)) {
          smuggling.push(file);
        }
      }
      expect(smuggling, 'funded ratio unbranded in reporting code - where does it go next?')
        .toEqual([]);
    });

  // (d) The checker checks itself. Without this, the test above can silently rot into a
  // no-op - which is precisely what happened to the regex it replaced.
  it('detects every known bypass when run against deliberate violations', async () => {
    const fixture = 'tests/architecture/fixtures';
    const { graph } = await buildGraph([fixture]);
    const target = `${fixture}/funded-status.ts`;

    const caught = reachers(graph, target).map((f) => f.split('/').pop());

    // One fixture per bypass that defeated the old regex.
    expect(caught).toContain('double-quoted.ts');   // from "..."
    expect(caught).toContain('dynamic-import.ts');  // await import('...')
    expect(caught).toContain('transitive.ts');      // imports a re-exporting barrel
    expect(caught).toContain('barrel.ts');          // the barrel itself
  });
});
```

Also create the bypass fixtures the third test runs against. These are deliberately
"wrong" files whose only job is to prove the checker still fires. Keep them minimal and
never import them from real code.

`tests/architecture/fixtures/funded-status.ts`:
```ts
export const marker = 'fixture target - not the real module';
```

`tests/architecture/fixtures/double-quoted.ts`:
```ts
// Bypass 1: double quotes. The old regex hard-coded single quotes.
import { marker } from "./funded-status.js";
export const a = marker;
```

`tests/architecture/fixtures/dynamic-import.ts`:
```ts
// Bypass 2: dynamic import has no `from` clause at all.
export async function b() {
  const m = await import('./funded-status.js');
  return m.marker;
}
```

`tests/architecture/fixtures/barrel.ts`:
```ts
// Bypass 3a: a re-exporting barrel launders the dependency.
export { marker } from './funded-status.js';
```

`tests/architecture/fixtures/transitive.ts`:
```ts
// Bypass 3b: two hops from the target, so no direct reference to it exists here.
import { marker } from './barrel.js';
export const c = marker;
```

- [ ] **Step 6: Run them and watch them fail**

Run: `pnpm test tests/domain/funded-status.test.ts tests/architecture`
Expected: FAIL — `src/domain/funded-status.js` not found.

> **Do not skip the fixture test.** It is the only thing standing between this suite and a
> green architecture test that enforces nothing. If it ever starts passing trivially
> (e.g. because `buildGraph` silently returned an empty map), the fail-closed assertions in
> the first test are the backstop.

- [ ] **Step 7: Write `src/domain/funded-status.ts`**

```ts
import { ASSUMPTIONS } from '../config/assumptions.js';
import { rupees, type Paise } from '../money/paise.js';

/**
 * REPORTING ONLY (PRD FR-16, §11.9).
 *
 * Nothing in this module may be imported by sizing, risk, or allocation code.
 * `tests/architecture/no-catch-up.test.ts` enforces that. The owner reviews
 * funded status annually; the agent must never let it change how much risk it takes.
 */

/**
 * A funded ratio. Branded so it cannot be passed into a sizing or risk function as a
 * bare `number` - that was the one bypass the architecture test could not see, because
 * such a function need never import this module at all. With the brand, any signature
 * that accepts one must name the type, which puts it in the import graph where the test
 * WILL see it. Do not un-brand this, and do not cast it back to `number` outside a
 * rendering call.
 */
export type FundedRatio = number & { readonly __brand: unique symbol };

/** SWR as integer basis points. Rates may be floats; money may not. */
const swrBps = (swr: number) => BigInt(Math.round(swr * 10_000));

/**
 * Corpus needed for the FI income band at the floor SWR, in today's rupees.
 *
 * Integer throughout: corpus = annualIncome / swr, evaluated as
 * `annualPaise * 10_000 / swrBps` so the 0.035 divisor - which has no exact binary
 * representation - never touches a money value.
 */
export function fiCorpusBand(): { floorPaise: Paise; stretchPaise: Paise } {
  const corpusFor = (monthlyInr: number): Paise => {
    const annualPaise = rupees(monthlyInr * 12);
    return ((annualPaise * 10_000n) / swrBps(ASSUMPTIONS.swrFloor)) as Paise;
  };
  return {
    floorPaise: corpusFor(ASSUMPTIONS.fiIncomeFloorMonthlyInr),
    stretchPaise: corpusFor(ASSUMPTIONS.fiIncomeStretchMonthlyInr),
  };
}

export function fundedStatus(
  corpusPaise: Paise,
): { floorRatio: FundedRatio; stretchRatio: FundedRatio } {
  const { floorPaise, stretchPaise } = fiCorpusBand();
  // Ratios are rates, not money, so float division is correct here. The inputs are
  // exact integers; only the quotient is approximate, and it is only ever displayed.
  return {
    floorRatio: (Number(corpusPaise) / Number(floorPaise)) as FundedRatio,
    stretchRatio: (Number(corpusPaise) / Number(stretchPaise)) as FundedRatio,
  };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm test tests/domain tests/architecture`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(domain): bucket balances, milestone nags and reporting-only funded status"
```

---

### Task 11: Source adapters — env, Kite (read-only), INDmoney, FX

**Files:**
- Create: `src/config/env.ts`, `src/sources/types.ts`, `src/sources/kite.ts`, `src/sources/indmoney.ts`, `src/sources/fx.ts`
- Test: `tests/sources/kite.test.ts`, `tests/sources/indmoney.test.ts`, `tests/sources/fx.test.ts`, `tests/fixtures/kite-holdings.json`, `tests/fixtures/indmoney-snapshot.json`

**Interfaces:**
- Consumes: `Paise`, `rupees` (Task 4); `Account` (Task 5); schema (Task 3).
- Produces:
  - `interface SourceRow { instrumentId: string; account: Account; quantity: number; valuePaise: Paise; avgCostPaise: Paise | null; instrument: InstrumentSeed }`
  - `interface Source { name: string; fetch(): Promise<{ rows: SourceRow[]; asOf: string }> }`
  - `class KiteSource implements Source` — `constructor(opts: { apiKey: string; accessToken: string; fetchImpl?: typeof fetch })`
  - `class FileIndmoneySource implements Source` — `constructor(path: string)`
  - `fetchUsdInr(opts?: { fetchImpl?: typeof fetch }): Promise<{ rate: number; asOf: string; source: string }>`
  - `writeSnapshot(db: Db, source: string, businessDate: string, rows: SourceRow[], asOf: string): Promise<string>`
  - `env` — validated config object; throws on first access with a missing required key.

**Hard constraint:** `KiteSource` exposes **only** `fetch` and `getHoldings` in Phase 0. There is no order method — not a disabled one, an absent one (PRD §4.2, §11.3).

> Earlier drafts of this line named three read methods (`getHoldings`, `getMfHoldings`, `getPositions`) while the reference code implemented one, so the plan satisfied neither reading of its own constraint. The allowlist test below is now the authority: it asserts the exact method set, so if you add `getMfHoldings` or `getPositions` later you must widen the list deliberately and in the same commit. Do not widen it to make a failure go away — a method appearing here that you did not add is the alarm this test exists to raise.

**INDmoney in this task:** build `FileIndmoneySource` only — it is the test double, the fallback, and the shape `RemoteIndmoneySource` (Task 11B) must match. The real OAuth-backed source is Tasks 11A and 11B.

- [ ] **Step 1: Write the env config with its failing test**

`tests/config/env.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

describe('env', () => {
  it('accepts a minimal local configuration', () => {
    const env = loadEnv({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_CHAT_ID: '123' });
    expect(env.telegramOwnerChatId).toBe('123');
    expect(env.databaseUrl).toBeUndefined();
    expect(env.dryRun).toBe(false);
  });

  it('names the missing key rather than failing obscurely', () => {
    expect(() => loadEnv({})).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('treats DRY_RUN=1 as paper/no-send mode', () => {
    const env = loadEnv({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_CHAT_ID: '1', DRY_RUN: '1' });
    expect(env.dryRun).toBe(true);
  });
});
```

- [ ] **Step 2: Run it, watch it fail, then write `src/config/env.ts`**

Run: `pnpm test tests/config/env.test.ts` → FAIL (module not found).

```ts
export interface Env {
  databaseUrl: string | undefined;
  telegramBotToken: string;
  telegramOwnerChatId: string;
  kiteApiKey: string | undefined;
  kiteAccessToken: string | undefined;
  indmoneySnapshotPath: string;
  dryRun: boolean;
}

function required(source: Record<string, string | undefined>, key: string): string {
  const value = source[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  return {
    databaseUrl: source.DATABASE_URL,
    telegramBotToken: required(source, 'TELEGRAM_BOT_TOKEN'),
    telegramOwnerChatId: required(source, 'TELEGRAM_OWNER_CHAT_ID'),
    kiteApiKey: source.KITE_API_KEY,
    kiteAccessToken: source.KITE_ACCESS_TOKEN,
    indmoneySnapshotPath: source.INDMONEY_SNAPSHOT_PATH ?? 'data/indmoney-snapshot.json',
    dryRun: source.DRY_RUN === '1' || source.DRY_RUN === 'true',
  };
}
```

Run: `pnpm test tests/config/env.test.ts` → PASS (3 tests).

- [ ] **Step 3: Write the Kite fixture**

`tests/fixtures/kite-holdings.json` — shape per Kite Connect `/portfolio/holdings`:

```json
{
  "status": "success",
  "data": [
    {
      "tradingsymbol": "NIFTYBEES", "exchange": "NSE", "isin": "INF204KB14I2",
      "quantity": 380, "average_price": 245.5, "last_price": 250.0, "close_price": 249.0,
      "pnl": 1710.0, "product": "CNC"
    },
    {
      "tradingsymbol": "GOLDBEES", "exchange": "NSE", "isin": "INF204KB17I5",
      "quantity": 2616, "average_price": 22.0, "last_price": 24.08, "close_price": 24.0,
      "pnl": 5441.28, "product": "CNC"
    },
    {
      "tradingsymbol": "TATASTEEL", "exchange": "NSE", "isin": "INE081A01020",
      "quantity": 100, "average_price": 0, "last_price": 155.0, "close_price": 154.0,
      "pnl": 0, "product": "CNC"
    }
  ]
}
```

- [ ] **Step 4: Write the failing Kite test**

`tests/sources/kite.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { KiteSource } from '../../src/sources/kite.js';

const fixture = JSON.parse(await readFile('tests/fixtures/kite-holdings.json', 'utf8'));

const stubFetch = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('KiteSource', () => {
  it('maps holdings to SourceRows valued at last price', async () => {
    const src = new KiteSource({ apiKey: 'k', accessToken: 'a', fetchImpl: stubFetch(fixture) });
    const { rows } = await src.fetch();
    const bees = rows.find((r) => r.instrumentId === 'NSE:NIFTYBEES')!;
    expect(bees.valuePaise).toBe(9_500_000n); // 380 * 250.00 = 95,000.00
    expect(bees.account).toBe('zerodha');
  });

  it('reports a zero average price as unknown cost, never as 0 (FR-02)', async () => {
    const src = new KiteSource({ apiKey: 'k', accessToken: 'a', fetchImpl: stubFetch(fixture) });
    const { rows } = await src.fetch();
    expect(rows.find((r) => r.instrumentId === 'NSE:TATASTEEL')!.avgCostPaise).toBeNull();
    expect(rows.find((r) => r.instrumentId === 'NSE:GOLDBEES')!.avgCostPaise).not.toBeNull();
  });

  it('sends the Kite authorization header and API version', async () => {
    let seen: Request | undefined;
    const capture: typeof fetch = (async (url: string, init: RequestInit) => {
      seen = new Request(url, init);
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as unknown as typeof fetch;

    await new KiteSource({ apiKey: 'k', accessToken: 'a', fetchImpl: capture }).fetch();
    expect(seen!.headers.get('Authorization')).toBe('token k:a');
    expect(seen!.headers.get('X-Kite-Version')).toBe('3');
  });

  it('throws a named error on a broker error rather than returning empty holdings', async () => {
    const src = new KiteSource({
      apiKey: 'k', accessToken: 'expired',
      fetchImpl: stubFetch({ status: 'error', message: 'Invalid access token' }, 403),
    });
    await expect(src.fetch()).rejects.toThrow(/Invalid access token/);
  });

  // An earlier version asserted only `.not.toContain('placeOrder')`. That is a check on
  // one NAME, and the constraint is about CAPABILITY: `submitOrder`, `createOrder`,
  // `modifyGtt`, `exitPosition` would all have sailed through it. CLAUDE.md is explicit
  // that trading paths are "absent code paths, not disabled features", so the guard has
  // to be an exhaustive allowlist - anything not on it fails, including methods nobody
  // has thought of yet.
  //
  // If you are here because you added a legitimate read method and this test failed:
  // that is the test working. Add it to the list deliberately, and only after checking it
  // cannot mutate broker state.
  it('exposes exactly the read-only surface and nothing else', () => {
    const src = new KiteSource({ apiKey: 'k', accessToken: 'a' });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(src))
      .filter((m) => m !== 'constructor')
      .sort();
    expect(methods).toEqual(['fetch', 'getHoldings'].sort());
  });

  // Belt and braces: the allowlist above governs the prototype, but a write path could
  // also be reached through a raw endpoint string. Kite's mutating endpoints all live
  // under /orders, /gtt and /positions, and the only HTTP verb this source may use is GET.
  it('contains no mutating endpoint or verb anywhere in the module', async () => {
    const source = await readFile('src/sources/kite.ts', 'utf8');
    expect(source).not.toMatch(/\/orders\b/);
    expect(source).not.toMatch(/\/gtt\b/);
    expect(source).not.toMatch(/method:\s*['"](POST|PUT|DELETE|PATCH)['"]/i);
  });
});
```

- [ ] **Step 5: Run it, watch it fail, then write `src/sources/kite.ts`**

Run: `pnpm test tests/sources/kite.test.ts` → FAIL (module not found).

```ts
import type { SourceRow } from './types.js';
import type { Paise } from '../money/paise.js';
import type { InstrumentSeed } from '../seed/seed-data.js';

const BASE_URL = 'https://api.kite.trade';

interface KiteHolding {
  tradingsymbol: string;
  exchange: string;
  isin: string;
  quantity: number;
  average_price: number;
  last_price: number;
  close_price: number;
}

const toPaise = (rupeeValue: number): Paise =>
  BigInt(Math.round(rupeeValue * 100)) as Paise;

/**
 * Read-only Kite Connect client. Phase 0 has no order path — placing orders is
 * Phase 3 work behind the human-in-the-loop unlock, and static-IP registration
 * is mandatory for it (verified Aug 2026). Adding a write method here is a
 * scope violation, not a convenience.
 */
export class KiteSource {
  readonly name = 'kite';
  private readonly apiKey: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiKey: string; accessToken: string; fetchImpl?: typeof fetch }) {
    this.apiKey = opts.apiKey;
    this.accessToken = opts.accessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${BASE_URL}${path}`, {
      headers: {
        Authorization: `token ${this.apiKey}:${this.accessToken}`,
        'X-Kite-Version': '3',
      },
    });
    const body = (await res.json()) as { status: string; data?: T; message?: string };
    if (!res.ok || body.status !== 'success') {
      throw new Error(`Kite ${path} failed: ${body.message ?? res.status}`);
    }
    return body.data as T;
  }

  async getHoldings(): Promise<KiteHolding[]> {
    return this.get<KiteHolding[]>('/portfolio/holdings');
  }

  async fetch(): Promise<{ rows: SourceRow[]; asOf: string }> {
    const holdings = await this.getHoldings();
    const rows = holdings.map((h): SourceRow => {
      const instrumentId = `${h.exchange}:${h.tradingsymbol}`;
      const price = h.last_price || h.close_price;
      const instrument: InstrumentSeed = {
        id: instrumentId,
        kind: /BEES$|ETF$/.test(h.tradingsymbol) ? 'ETF' : 'EQUITY',
        name: h.tradingsymbol,
        currency: 'INR',
      };
      return {
        instrumentId,
        account: 'zerodha',
        quantity: h.quantity,
        valuePaise: toPaise(h.quantity * price),
        // A zero average price means Kite has no cost basis for the lot — unknown, not free.
        avgCostPaise: h.average_price > 0 ? toPaise(h.average_price) : null,
        instrument,
      };
    });
    return { rows, asOf: new Date().toISOString() };
  }
}
```

- [ ] **Step 6: Write `src/sources/types.ts`**

```ts
import type { Paise } from '../money/paise.js';
import type { Account, InstrumentSeed } from '../seed/seed-data.js';

export interface SourceRow {
  instrumentId: string;
  account: Account;
  quantity: number;
  valuePaise: Paise;
  /** null = the source does not know the cost basis (FR-02). Never 0. */
  avgCostPaise: Paise | null;
  instrument: InstrumentSeed;
}

export interface Source {
  readonly name: string;
  fetch(): Promise<{ rows: SourceRow[]; asOf: string }>;
}
```

Run: `pnpm test tests/sources/kite.test.ts` → PASS (6 tests).

- [ ] **Step 7: Write the INDmoney fixture and its failing test**

`tests/fixtures/indmoney-snapshot.json`:

```json
{
  "asOf": "2026-08-12T18:30:00+05:30",
  "holdings": [
    { "instrumentId": "MF:PPFC", "kind": "MF", "name": "Parag Parikh Flexi Cap Direct",
      "currency": "INR", "quantity": 1, "valueInr": 241000, "avgCostInr": 180000 },
    { "instrumentId": "BOND:SAMMAAN-2026", "kind": "BOND", "name": "Sammaan Capital 9% 26-Sep-2026",
      "currency": "INR", "issuer": "Sammaan Capital", "quantity": 1, "valueInr": 284000, "avgCostInr": null },
    { "instrumentId": "NSE:NIFTYBEES", "kind": "ETF", "name": "Nippon Nifty BeES",
      "currency": "INR", "quantity": 380, "valueInr": 95000, "avgCostInr": 0 }
  ]
}
```

`tests/sources/indmoney.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FileIndmoneySource } from '../../src/sources/indmoney.js';
import { rupees } from '../../src/money/paise.js';

const source = new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json');

describe('FileIndmoneySource', () => {
  it('reads the owner-refreshed snapshot and reports its own asOf', async () => {
    const { rows, asOf } = await source.fetch();
    expect(asOf).toBe('2026-08-12T18:30:00+05:30');
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.instrumentId === 'MF:PPFC')!.valuePaise).toBe(rupees(241_000));
  });

  it('treats a Zerodha-linked zero cost as unknown, per the documented INDmoney gap', async () => {
    const { rows } = await source.fetch();
    expect(rows.find((r) => r.instrumentId === 'NSE:NIFTYBEES')!.avgCostPaise).toBeNull();
    expect(rows.find((r) => r.instrumentId === 'MF:PPFC')!.avgCostPaise).toBe(rupees(180_000));
  });

  it('tags every row to the indmoney account', async () => {
    const { rows } = await source.fetch();
    expect(rows.every((r) => r.account === 'indmoney')).toBe(true);
  });

  it('fails loudly when the snapshot file is missing rather than syncing nothing', async () => {
    await expect(new FileIndmoneySource('tests/fixtures/nope.json').fetch())
      .rejects.toThrow(/indmoney snapshot/i);
  });
});
```

- [ ] **Step 8: Run it, watch it fail, then write `src/sources/indmoney.ts`**

Run: `pnpm test tests/sources/indmoney.test.ts` → FAIL (module not found).

```ts
import { readFile } from 'node:fs/promises';
import type { Source, SourceRow } from './types.js';
import { rupees, type Paise } from '../money/paise.js';
import type { InstrumentSeed } from '../seed/seed-data.js';

interface SnapshotRow {
  instrumentId: string;
  kind: InstrumentSeed['kind'];
  name: string;
  currency: 'INR' | 'USD';
  issuer?: string;
  quantity: number;
  valueInr: number;
  /** null or 0 both mean "INDmoney does not know" — Zerodha-linked rows lack cost. */
  avgCostInr: number | null;
}

/**
 * INDmoney's MCP is read-only (good) but authenticates with OAuth 2.1 + PKCE
 * behind OTP + MPIN, which no unattended runner can complete. Phase 0 therefore
 * reads an owner-refreshed snapshot file; staleness (Task 12) nags when it ages.
 * A future RemoteIndmoneySource implements this same `Source` interface.
 */
export class FileIndmoneySource implements Source {
  readonly name = 'indmoney';
  constructor(private readonly path: string) {}

  async fetch(): Promise<{ rows: SourceRow[]; asOf: string }> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      throw new Error(
        `INDmoney snapshot not found at ${this.path}. Refresh it before syncing — ` +
        `Sentinel will not silently report a portfolio it cannot see.`,
      );
    }

    const parsed = JSON.parse(raw) as { asOf: string; holdings: SnapshotRow[] };
    const rows = parsed.holdings.map((h): SourceRow => ({
      instrumentId: h.instrumentId,
      account: 'indmoney',
      quantity: h.quantity,
      valuePaise: rupees(h.valueInr),
      avgCostPaise: h.avgCostInr ? rupees(h.avgCostInr) : null,
      instrument: {
        id: h.instrumentId, kind: h.kind, name: h.name,
        currency: h.currency, ...(h.issuer ? { issuer: h.issuer } : {}),
      },
    }));
    return { rows, asOf: parsed.asOf };
  }
}
```

Run: `pnpm test tests/sources/indmoney.test.ts` → PASS (4 tests).

- [ ] **Step 9: Write the FX source with its failing test**

`tests/sources/fx.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fetchUsdInr } from '../../src/sources/fx.js';

const stub = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe('fetchUsdInr', () => {
  it('returns the rate, its date and its source', async () => {
    const r = await fetchUsdInr({
      fetchImpl: stub({ date: '2026-08-12', rates: { INR: 95.42 } }),
    });
    expect(r.rate).toBeCloseTo(95.42, 4);
    expect(r.asOf).toBe('2026-08-12');
    expect(r.source).toMatch(/\w/);
  });

  it('rejects an implausible rate rather than corrupting NOW valuation', async () => {
    await expect(fetchUsdInr({ fetchImpl: stub({ date: '2026-08-12', rates: { INR: 0 } }) }))
      .rejects.toThrow(/implausible/i);
    await expect(fetchUsdInr({ fetchImpl: stub({ date: '2026-08-12', rates: { INR: 900 } }) }))
      .rejects.toThrow(/implausible/i);
  });
});
```

- [ ] **Step 10: Run it, watch it fail, then write `src/sources/fx.ts`**

Run: `pnpm test tests/sources/fx.test.ts` → FAIL (module not found).

```ts
const ENDPOINT = 'https://api.frankfurter.app/latest?from=USD&to=INR';

/** Sanity band. A bad FX rate silently misprices the largest single-stock position. */
const MIN_PLAUSIBLE = 50;
const MAX_PLAUSIBLE = 200;

export async function fetchUsdInr(
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ rate: number; asOf: string; source: string }> {
  const impl = opts.fetchImpl ?? fetch;
  const res = await impl(ENDPOINT);
  if (!res.ok) throw new Error(`USDINR fetch failed: HTTP ${res.status}`);

  const body = (await res.json()) as { date: string; rates: { INR?: number } };
  const rate = body.rates?.INR;
  if (typeof rate !== 'number' || rate < MIN_PLAUSIBLE || rate > MAX_PLAUSIBLE) {
    throw new Error(`implausible USDINR rate: ${rate}`);
  }
  return { rate, asOf: body.date, source: 'frankfurter' };
}
```

> **Build-time verification (PRD §15.1.9 adjacent):** confirm this endpoint is still free and unauthenticated at build time. If it is not, RBI's reference-rate page is the fallback; keep the `{ rate, asOf, source }` return shape so nothing downstream changes.

Run: `pnpm test tests/sources/fx.test.ts` → PASS (2 tests).

- [ ] **Step 11: Write the snapshot writer with its failing test**

`tests/sources/write-snapshot.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { FileIndmoneySource } from '../../src/sources/indmoney.js';
import { writeSnapshot } from '../../src/sources/types.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

describe('writeSnapshot', () => {
  it('upserts instruments it has never seen and writes holdings with as_of/source', async () => {
    const { rows, asOf } = await new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json').fetch();
    await writeSnapshot(db, 'indmoney', '2026-08-12', rows, asOf);

    const [{ n }] = await db.query<{ n: string }>('select count(*) as n from instruments');
    expect(Number(n)).toBe(3);
    const holdings = await db.query<{ as_of: string; source: string }>(
      'select as_of, source from holdings',
    );
    expect(holdings).toHaveLength(3);
    expect(holdings.every((h) => h.source === 'indmoney')).toBe(true);
  });

  it('replaces the same source+date snapshot instead of double-counting', async () => {
    const { rows, asOf } = await new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json').fetch();
    await writeSnapshot(db, 'indmoney', '2026-08-12', rows, asOf);
    await writeSnapshot(db, 'indmoney', '2026-08-12', rows, asOf);
    const [{ n }] = await db.query<{ n: string }>('select count(*) as n from holdings');
    expect(Number(n)).toBe(3);
  });
});
```

- [ ] **Step 12: Run it, watch it fail, then add `writeSnapshot` to `src/sources/types.ts`**

Run: `pnpm test tests/sources/write-snapshot.test.ts` → FAIL (`writeSnapshot` not exported).

```ts
import type { Db } from '../db/client.js';

/** One snapshot per (source, business date). Re-running a sync replaces its rows. */
export async function writeSnapshot(
  db: Db,
  source: string,
  businessDate: string,
  rows: SourceRow[],
  asOf: string,
): Promise<string> {
  for (const r of rows) {
    const i = r.instrument;
    await db.query(
      `insert into instruments (id, kind, name, currency, sector, issuer, is_employer)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (id) do update set name = excluded.name`,
      [i.id, i.kind, i.name, i.currency, i.sector ?? null, i.issuer ?? null, i.isEmployer ?? false],
    );
  }

  const existing = await db.query<{ id: string }>(
    'select id from snapshots where business_date = $1 and source = $2',
    [businessDate, source],
  );
  let snapshotId = existing[0]?.id;
  if (snapshotId) {
    await db.query('delete from holdings where snapshot_id = $1', [snapshotId]);
  } else {
    const [row] = await db.query<{ id: string }>(
      'insert into snapshots (business_date, source) values ($1,$2) returning id',
      [businessDate, source],
    );
    snapshotId = row!.id;
  }

  for (const r of rows) {
    await db.query(
      `insert into holdings
         (snapshot_id, instrument_id, quantity, avg_cost_paise, value_paise, account, as_of, source)
       values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [snapshotId, r.instrumentId, r.quantity,
       r.avgCostPaise === null ? null : r.avgCostPaise.toString(),
       r.valuePaise.toString(), r.account, asOf, source],
    );
  }

  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('snapshot', $1, 'SYNCED', 'agent', $2::jsonb)`,
    [snapshotId, JSON.stringify({ source, businessDate, rows: rows.length })],
  );

  return snapshotId;
}
```

- [ ] **Step 13: Run the whole sources suite**

Run: `pnpm test tests/sources`
Expected: PASS (13 tests).

- [ ] **Step 14: Commit**

```bash
git add -A
git commit -m "feat(sources): read-only Kite client, file-backed INDmoney source, FX and snapshot writer"
```

---

### Task 11A: OAuth client — dynamic registration, PKCE, encrypted token store

**Files:**
- Create: `migrations/0002_oauth.sql`, `src/sources/oauth.ts`, `src/jobs/indmoney-login.ts`
- Test: `tests/sources/oauth.test.ts`

**Interfaces:**
- Consumes: `Db` (Task 2), `loadEnv` (Task 11).
- Produces:
  - `interface AsMetadata { issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string; scopes_supported?: string[] }`
  - `discoverMetadata(issuer: string, fetchImpl?: typeof fetch): Promise<AsMetadata>`
  - `registerClient(md: AsMetadata, redirectUri: string, fetchImpl?: typeof fetch): Promise<{ clientId: string; clientSecret?: string }>`
  - `pkcePair(): { verifier: string; challenge: string }` — S256
  - `authorizeUrl(md, opts: { clientId: string; redirectUri: string; challenge: string; scopes: string[]; state: string }): string`
  - `exchangeCode(md, opts): Promise<TokenSet>` / `refreshTokens(md, opts): Promise<TokenSet>`
  - `interface TokenSet { accessToken: string; refreshToken: string | null; expiresAt: string; scope: string }`
  - `saveTokens(db, provider, tokens, key): Promise<void>` / `loadTokens(db, provider, key): Promise<TokenSet | null>`
  - `ensureAccessToken(db, provider, opts: { md: AsMetadata; clientId: string; clientSecret?: string; key: Buffer; fetchImpl?: typeof fetch }): Promise<string>` — refreshes when under 60s of life remains; throws `ReauthRequired` when refresh fails

**Security (PRD §12.3):** refresh tokens are encrypted at rest with AES-256-GCM under `TOKEN_ENCRYPTION_KEY` (base64, 32 bytes) held in GitHub Actions secrets — never in the repo, never plaintext in the DB. No password or MPIN is ever stored or transmitted by Sentinel; the owner types those only on INDmoney's own page.

- [ ] **Step 1: Write `migrations/0002_oauth.sql`**

```sql
create table oauth_clients (
  provider       text primary key,
  issuer         text not null,
  client_id      text not null,
  client_secret  text,
  redirect_uri   text not null,
  registered_at  timestamptz not null default now()
);

create table oauth_tokens (
  provider          text primary key,
  access_token_enc  bytea not null,
  refresh_token_enc bytea,
  expires_at        timestamptz not null,
  scope             text not null,
  updated_at        timestamptz not null default now()
);
```

- [ ] **Step 2: Write the failing test**

`tests/sources/oauth.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  authorizeUrl, discoverMetadata, ensureAccessToken, exchangeCode,
  loadTokens, pkcePair, ReauthRequired, registerClient, saveTokens,
} from '../../src/sources/oauth.js';

const MD = {
  issuer: 'https://mcp.indmoney.com/',
  authorization_endpoint: 'https://mcp.indmoney.com/authorize',
  token_endpoint: 'https://mcp.indmoney.com/token',
  registration_endpoint: 'https://mcp.indmoney.com/register',
  scopes_supported: ['portfolio:read', 'market:read'],
};

const json = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const key = randomBytes(32);
let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

describe('discovery and registration', () => {
  it('reads authorization server metadata', async () => {
    const md = await discoverMetadata('https://mcp.indmoney.com', json(MD));
    expect(md.token_endpoint).toBe('https://mcp.indmoney.com/token');
  });

  it('registers dynamically and returns the client id', async () => {
    const c = await registerClient(MD, 'http://127.0.0.1:8765/callback',
      json({ client_id: 'abc123', client_secret: 'shh' }));
    expect(c.clientId).toBe('abc123');
  });

  it('refuses to register when the server offers no registration endpoint', async () => {
    const { registration_endpoint, ...noReg } = MD;
    await expect(registerClient(noReg as never, 'http://127.0.0.1:8765/callback', json({})))
      .rejects.toThrow(/dynamic client registration/i);
  });
});

describe('PKCE', () => {
  it('produces an S256 challenge distinct from its verifier', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).not.toBe(verifier);
    expect(challenge).not.toMatch(/[+/=]/); // base64url only
  });

  it('builds an authorize URL carrying challenge, scope and state', () => {
    const url = new URL(authorizeUrl(MD, {
      clientId: 'abc', redirectUri: 'http://127.0.0.1:8765/callback',
      challenge: 'CH', scopes: ['portfolio:read'], state: 'ST',
    }));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('CH');
    expect(url.searchParams.get('scope')).toBe('portfolio:read');
    expect(url.searchParams.get('state')).toBe('ST');
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('token storage', () => {
  it('round-trips tokens through encryption at rest', async () => {
    await saveTokens(db, 'indmoney', {
      accessToken: 'AT', refreshToken: 'RT',
      expiresAt: '2030-01-01T00:00:00.000Z', scope: 'portfolio:read',
    }, key);
    expect((await loadTokens(db, 'indmoney', key))!.refreshToken).toBe('RT');
  });

  it('never stores the refresh token in plaintext', async () => {
    await saveTokens(db, 'indmoney', {
      accessToken: 'AT', refreshToken: 'SUPERSECRET',
      expiresAt: '2030-01-01T00:00:00.000Z', scope: 'portfolio:read',
    }, key);
    const [row] = await db.query<{ refresh_token_enc: Uint8Array }>(
      'select refresh_token_enc from oauth_tokens',
    );
    expect(Buffer.from(row!.refresh_token_enc).toString('utf8')).not.toContain('SUPERSECRET');
  });

  it('fails loudly on a wrong decryption key rather than returning garbage', async () => {
    await saveTokens(db, 'indmoney', {
      accessToken: 'AT', refreshToken: 'RT',
      expiresAt: '2030-01-01T00:00:00.000Z', scope: 'portfolio:read',
    }, key);
    await expect(loadTokens(db, 'indmoney', randomBytes(32))).rejects.toThrow();
  });
});

describe('ensureAccessToken', () => {
  it('returns the stored token while it is still valid', async () => {
    await saveTokens(db, 'indmoney', {
      accessToken: 'STILL_GOOD', refreshToken: 'RT',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: 'portfolio:read',
    }, key);
    const token = await ensureAccessToken(db, 'indmoney', {
      md: MD, clientId: 'abc', key,
      fetchImpl: () => { throw new Error('must not refresh a valid token'); },
    });
    expect(token).toBe('STILL_GOOD');
  });

  it('refreshes an expired token unattended and persists the rotated refresh token', async () => {
    await saveTokens(db, 'indmoney', {
      accessToken: 'OLD', refreshToken: 'RT1',
      expiresAt: new Date(Date.now() - 1000).toISOString(), scope: 'portfolio:read',
    }, key);
    const token = await ensureAccessToken(db, 'indmoney', {
      md: MD, clientId: 'abc', key,
      fetchImpl: json({ access_token: 'NEW', refresh_token: 'RT2', expires_in: 3600, scope: 'portfolio:read' }),
    });
    expect(token).toBe('NEW');
    expect((await loadTokens(db, 'indmoney', key))!.refreshToken).toBe('RT2');
  });

  it('throws ReauthRequired when the refresh token is rejected', async () => {
    await saveTokens(db, 'indmoney', {
      accessToken: 'OLD', refreshToken: 'DEAD',
      expiresAt: new Date(Date.now() - 1000).toISOString(), scope: 'portfolio:read',
    }, key);
    await expect(ensureAccessToken(db, 'indmoney', {
      md: MD, clientId: 'abc', key,
      fetchImpl: json({ error: 'invalid_grant' }, 400),
    })).rejects.toBeInstanceOf(ReauthRequired);
  });

  it('throws ReauthRequired when nothing is stored at all', async () => {
    await expect(ensureAccessToken(db, 'indmoney', { md: MD, clientId: 'abc', key }))
      .rejects.toBeInstanceOf(ReauthRequired);
  });
});
```

- [ ] **Step 3: Run it, watch it fail, then write `src/sources/oauth.ts`**

Run: `pnpm test tests/sources/oauth.test.ts` → FAIL (module not found).

```ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/client.js';

export interface AsMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  scope: string;
}

/** Thrown when only a human can fix it: the owner must re-run `pnpm indmoney:login`. */
export class ReauthRequired extends Error {
  constructor(public readonly provider: string, reason: string) {
    super(`${provider} needs re-authentication: ${reason}. Run: pnpm ${provider}:login`);
    this.name = 'ReauthRequired';
  }
}

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function discoverMetadata(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AsMetadata> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`;
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`OAuth discovery failed for ${issuer}: HTTP ${res.status}`);
  return (await res.json()) as AsMetadata;
}

/** RFC 7591 dynamic client registration — INDmoney exposes this, so no manual app setup. */
export async function registerClient(
  md: AsMetadata,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!md.registration_endpoint) {
    throw new Error(`${md.issuer} does not support dynamic client registration`);
  }
  const res = await fetchImpl(md.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Sentinel (personal)',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }),
  });
  const body = (await res.json()) as { client_id?: string; client_secret?: string; error?: string };
  if (!res.ok || !body.client_id) {
    throw new Error(`client registration failed: ${body.error ?? res.status}`);
  }
  return body.client_secret
    ? { clientId: body.client_id, clientSecret: body.client_secret }
    : { clientId: body.client_id };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(64));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function authorizeUrl(
  md: AsMetadata,
  opts: { clientId: string; redirectUri: string; challenge: string; scopes: string[]; state: string },
): string {
  const url = new URL(md.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', opts.scopes.join(' '));
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function postToken(
  md: AsMetadata,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  const res = await fetchImpl(md.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json()) as {
    access_token?: string; refresh_token?: string; expires_in?: number;
    scope?: string; error?: string; error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description ?? body.error ?? `token endpoint HTTP ${res.status}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
    scope: body.scope ?? '',
  };
}

export const exchangeCode = (
  md: AsMetadata,
  opts: { code: string; clientId: string; clientSecret?: string; redirectUri: string; verifier: string; fetchImpl?: typeof fetch },
): Promise<TokenSet> =>
  postToken(md, {
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
    ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
  }, opts.fetchImpl ?? fetch);

export const refreshTokens = (
  md: AsMetadata,
  opts: { refreshToken: string; clientId: string; clientSecret?: string; fetchImpl?: typeof fetch },
): Promise<TokenSet> =>
  postToken(md, {
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
  }, opts.fetchImpl ?? fetch);

// --- encryption at rest (AES-256-GCM: iv | tag | ciphertext) ---

function encrypt(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

function decrypt(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8');
}

export async function saveTokens(
  db: Db, provider: string, tokens: TokenSet, key: Buffer,
): Promise<void> {
  await db.query(
    `insert into oauth_tokens (provider, access_token_enc, refresh_token_enc, expires_at, scope, updated_at)
     values ($1,$2,$3,$4,$5, now())
     on conflict (provider) do update set access_token_enc = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc, expires_at = excluded.expires_at,
       scope = excluded.scope, updated_at = now()`,
    [provider, encrypt(tokens.accessToken, key),
     tokens.refreshToken ? encrypt(tokens.refreshToken, key) : null,
     tokens.expiresAt, tokens.scope],
  );
}

export async function loadTokens(db: Db, provider: string, key: Buffer): Promise<TokenSet | null> {
  const [row] = await db.query<{
    access_token_enc: Uint8Array; refresh_token_enc: Uint8Array | null;
    expires_at: string; scope: string;
  }>('select access_token_enc, refresh_token_enc, expires_at, scope from oauth_tokens where provider = $1',
    [provider]);
  if (!row) return null;
  return {
    accessToken: decrypt(Buffer.from(row.access_token_enc), key),
    refreshToken: row.refresh_token_enc ? decrypt(Buffer.from(row.refresh_token_enc), key) : null,
    expiresAt: typeof row.expires_at === 'string' ? row.expires_at : new Date(row.expires_at).toISOString(),
    scope: row.scope,
  };
}

const SKEW_MS = 60_000;

export async function ensureAccessToken(
  db: Db,
  provider: string,
  opts: { md: AsMetadata; clientId: string; clientSecret?: string; key: Buffer; fetchImpl?: typeof fetch },
): Promise<string> {
  const stored = await loadTokens(db, provider, opts.key);
  if (!stored) throw new ReauthRequired(provider, 'no stored credentials');

  if (Date.parse(stored.expiresAt) - Date.now() > SKEW_MS) return stored.accessToken;
  if (!stored.refreshToken) throw new ReauthRequired(provider, 'access token expired, no refresh token');

  let refreshed: TokenSet;
  try {
    refreshed = await refreshTokens(opts.md, {
      refreshToken: stored.refreshToken,
      clientId: opts.clientId,
      ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  } catch (error) {
    throw new ReauthRequired(provider, error instanceof Error ? error.message : String(error));
  }

  // Servers may rotate the refresh token; keep the old one if none was returned.
  await saveTokens(db, provider, {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? stored.refreshToken,
  }, opts.key);
  return refreshed.accessToken;
}
```

Run: `pnpm test tests/sources/oauth.test.ts` → PASS (11 tests).

- [ ] **Step 4: Write `src/jobs/indmoney-login.ts` (the one-time interactive flow)**

```ts
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../config/env.js';
import {
  authorizeUrl, discoverMetadata, exchangeCode, pkcePair, registerClient, saveTokens,
} from '../sources/oauth.js';

const ISSUER = 'https://mcp.indmoney.com';
const PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = ['portfolio:read'];

const env = loadEnv();
const key = Buffer.from(env.tokenEncryptionKey, 'base64');
if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');

const db = await openDb(env.databaseUrl);
await runMigrations(db);

const md = await discoverMetadata(ISSUER);

const existing = await db.query<{ client_id: string; client_secret: string | null }>(
  'select client_id, client_secret from oauth_clients where provider = $1', ['indmoney'],
);
let clientId = existing[0]?.client_id;
let clientSecret = existing[0]?.client_secret ?? undefined;

if (!clientId) {
  const registered = await registerClient(md, REDIRECT_URI);
  clientId = registered.clientId;
  clientSecret = registered.clientSecret;
  await db.query(
    `insert into oauth_clients (provider, issuer, client_id, client_secret, redirect_uri)
     values ('indmoney', $1, $2, $3, $4)`,
    [md.issuer, clientId, clientSecret ?? null, REDIRECT_URI],
  );
  console.log(`Registered Sentinel as OAuth client ${clientId}`);
}

const { verifier, challenge } = pkcePair();
const state = randomBytes(16).toString('hex');
const url = authorizeUrl(md, { clientId, redirectUri: REDIRECT_URI, challenge, scopes: SCOPES, state });

const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const incoming = new URL(req.url ?? '/', REDIRECT_URI);
    if (incoming.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const returnedState = incoming.searchParams.get('state');
    const returnedCode = incoming.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/html' });

    if (returnedState !== state || !returnedCode) {
      res.end('<h1>Login failed</h1><p>You can close this tab and try again.</p>');
      server.close();
      reject(new Error(returnedState !== state ? 'state mismatch (possible CSRF)' : 'no code returned'));
      return;
    }
    res.end('<h1>Sentinel is connected to INDmoney.</h1><p>You can close this tab.</p>');
    server.close();
    resolve(returnedCode);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nOpening INDmoney login. Complete OTP + MPIN on INDmoney's own page.\n${url}\n`);
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
  });
  setTimeout(() => { server.close(); reject(new Error('login timed out after 5 minutes')); }, 300_000);
});

const tokens = await exchangeCode(md, {
  code, clientId, redirectUri: REDIRECT_URI, verifier,
  ...(clientSecret ? { clientSecret } : {}),
});
await saveTokens(db, 'indmoney', tokens, key);
await db.query(
  `insert into audit_log (entity, entity_id, action, actor, payload)
   values ('oauth', 'indmoney', 'AUTHORIZED', 'owner', $1::jsonb)`,
  [JSON.stringify({ scope: tokens.scope, expiresAt: tokens.expiresAt })],
);

console.log(`Connected. Scope: ${tokens.scope}. Refresh token stored encrypted.`);
await db.close();
```

Add to `package.json` scripts: `"indmoney:login": "tsx src/jobs/indmoney-login.ts"`.

Add to `src/config/env.ts`: `tokenEncryptionKey: required(source, 'TOKEN_ENCRYPTION_KEY')` — and update `tests/config/env.test.ts` so its minimal config includes `TOKEN_ENCRYPTION_KEY`, plus a case asserting a missing key names itself.

- [ ] **Step 5: Run the suite**

Run: `pnpm test`
Expected: PASS. Generate a key for local use with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(oauth): dynamic registration, PKCE loopback login and encrypted token store"
```

---

### Task 11B: MCP client and RemoteIndmoneySource

**Files:**
- Create: `src/sources/mcp-client.ts`, extend `src/sources/indmoney.ts`
- Test: `tests/sources/mcp-client.test.ts`, `tests/sources/indmoney-remote.test.ts`, `tests/fixtures/indmoney-holdings-mcp.json`

**Interfaces:**
- Consumes: `ensureAccessToken`, `ReauthRequired` (Task 11A); `Source`, `SourceRow` (Task 11).
- Produces:
  - `class McpClient { constructor(opts: { url: string; getToken: () => Promise<string>; fetchImpl?: typeof fetch }); callTool<T>(name: string, args: Record<string, unknown>): Promise<T> }`
  - `class RemoteIndmoneySource implements Source` — `constructor(opts: { client: McpClient })`, `name = 'indmoney'`

**Protocol:** MCP over Streamable HTTP — JSON-RPC 2.0 POSTs to the server URL with `Authorization: Bearer <token>`, `Accept: application/json, text/event-stream`. Handshake is `initialize` (protocolVersion `2025-06-18`), then `notifications/initialized`, then `tools/call`. The server may answer with either JSON or an SSE stream; handle both.

> **Fixture honesty:** the exact shape of `networth_holdings` output is not published. Capture a real response during the first successful `pnpm indmoney:login` + probe run, save it as `tests/fixtures/indmoney-holdings-mcp.json` **with values scrubbed to round numbers**, and write the mapper against it. Do not invent field names and then "fix" the mapper later against production — build the fixture from reality first. The fixture below is a starting shape; **replace it with the captured one**.

- [ ] **Step 1: Write the failing MCP client test**

`tests/sources/mcp-client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../src/sources/mcp-client.js';

const rpc = (result: unknown): typeof fetch =>
  (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { id?: number; method: string };
    if (req.method === 'notifications/initialized') return new Response('', { status: 202 });
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: req.id, result: req.method === 'initialize' ? {} : result }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

const client = (impl: typeof fetch) =>
  new McpClient({ url: 'https://mcp.indmoney.com/mcp', getToken: async () => 'AT', fetchImpl: impl });

describe('McpClient', () => {
  it('initializes once, then calls tools', async () => {
    let calls = 0;
    const counting: typeof fetch = (async (url: string, init: RequestInit) => {
      calls++;
      return rpc({ content: [{ type: 'text', text: '{"ok":true}' }] })(url, init);
    }) as unknown as typeof fetch;

    const c = client(counting);
    await c.callTool('networth_holdings', {});
    await c.callTool('networth_holdings', {});
    // initialize + initialized notification + two tool calls
    expect(calls).toBe(4);
  });

  it('sends the bearer token and MCP accept headers', async () => {
    let headers: Headers | undefined;
    const capture: typeof fetch = (async (url: string, init: RequestInit) => {
      headers ??= new Headers(init.headers);
      return rpc({ content: [{ type: 'text', text: '{}' }] })(url, init);
    }) as unknown as typeof fetch;

    await client(capture).callTool('networth_holdings', {});
    expect(headers!.get('Authorization')).toBe('Bearer AT');
    expect(headers!.get('Accept')).toMatch(/text\/event-stream/);
  });

  it('parses a JSON payload out of an MCP text content block', async () => {
    const result = await client(rpc({ content: [{ type: 'text', text: '{"holdings":[1,2]}' }] }))
      .callTool<{ holdings: number[] }>('networth_holdings', {});
    expect(result.holdings).toEqual([1, 2]);
  });

  it('reads a result delivered as an SSE stream', async () => {
    const sse: typeof fetch = (async (_url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (req.method === 'notifications/initialized') return new Response('', { status: 202 });
      const body = `event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0', id: req.id,
        result: req.method === 'initialize' ? {} : { content: [{ type: 'text', text: '{"via":"sse"}' }] },
      })}\n\n`;
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const result = await client(sse).callTool<{ via: string }>('networth_holdings', {});
    expect(result.via).toBe('sse');
  });

  it('surfaces a JSON-RPC error rather than returning undefined', async () => {
    const failing: typeof fetch = (async (_url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (req.method === 'notifications/initialized') return new Response('', { status: 202 });
      if (req.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'unknown tool' },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(client(failing).callTool('nope', {})).rejects.toThrow(/unknown tool/);
  });
});
```

- [ ] **Step 2: Run it, watch it fail, then write `src/sources/mcp-client.ts`**

Run: `pnpm test tests/sources/mcp-client.test.ts` → FAIL (module not found).

```ts
const PROTOCOL_VERSION = '2025-06-18';

interface RpcResponse<T> {
  id?: number;
  result?: T;
  error?: { code: number; message: string };
}

interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Minimal MCP client over Streamable HTTP — enough for authenticated tools/call. */
export class McpClient {
  private nextId = 1;
  private sessionId: string | undefined;
  private initialized = false;

  constructor(
    private readonly opts: { url: string; getToken: () => Promise<string>; fetchImpl?: typeof fetch },
  ) {}

  private async rpc<T>(method: string, params: unknown, notify = false): Promise<T> {
    const impl = this.opts.fetchImpl ?? fetch;
    const id = notify ? undefined : this.nextId++;
    const res = await impl(this.opts.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.opts.getToken()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notify ? {} : { id }) }),
    });

    this.sessionId ??= res.headers.get('Mcp-Session-Id') ?? undefined;
    if (notify) return undefined as T;

    if (!res.ok) throw new Error(`MCP ${method} failed: HTTP ${res.status}`);

    const raw = await res.text();
    const payload = res.headers.get('Content-Type')?.includes('text/event-stream')
      ? parseSse(raw)
      : (JSON.parse(raw) as RpcResponse<T>);

    if (payload.error) throw new Error(`MCP ${method} error: ${payload.error.message}`);
    return payload.result as T;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sentinel', version: '0.1.0' },
    });
    await this.rpc('notifications/initialized', {}, true);
    this.initialized = true;
  }

  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.ensureInitialized();
    const result = await this.rpc<ToolResult>('tools/call', { name, arguments: args });
    if (result.isError) {
      throw new Error(`MCP tool ${name} returned an error: ${textOf(result)}`);
    }
    if (result.structuredContent !== undefined) return result.structuredContent as T;
    return JSON.parse(textOf(result)) as T;
  }
}

const textOf = (result: ToolResult): string =>
  (result.content ?? []).map((c) => c.text ?? '').join('') || '{}';

function parseSse<T>(raw: string): RpcResponse<T> {
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim()) as RpcResponse<T>;
  }
  throw new Error('no data frame in SSE response');
}
```

Run: `pnpm test tests/sources/mcp-client.test.ts` → PASS (5 tests).

- [ ] **Step 3: Capture the real tool payload**

Run `pnpm indmoney:login`, then a one-off probe:

```bash
pnpm exec tsx -e "
import { openDb } from './src/db/client.js';
import { loadEnv } from './src/config/env.js';
import { discoverMetadata, ensureAccessToken } from './src/sources/oauth.js';
import { McpClient } from './src/sources/mcp-client.js';
const env = loadEnv();
const db = await openDb(env.databaseUrl);
const md = await discoverMetadata('https://mcp.indmoney.com');
const [c] = await db.query('select client_id, client_secret from oauth_clients where provider = \\'indmoney\\'');
const client = new McpClient({
  url: 'https://mcp.indmoney.com/mcp',
  getToken: () => ensureAccessToken(db, 'indmoney', {
    md, clientId: c.client_id, clientSecret: c.client_secret ?? undefined,
    key: Buffer.from(env.tokenEncryptionKey, 'base64'),
  }),
});
console.log(JSON.stringify(await client.callTool('networth_holdings', {}), null, 2));
await db.close();
"
```

Save the output to `tests/fixtures/indmoney-holdings-mcp.json` **with amounts rounded and any identifiers scrubbed**, then write the mapper in Step 4 against the real field names. If the tool needs an `asset_type` argument, the error message will say so — pass it.

- [ ] **Step 4: Write the failing RemoteIndmoneySource test**

`tests/sources/indmoney-remote.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../src/sources/mcp-client.js';
import { RemoteIndmoneySource } from '../../src/sources/indmoney.js';

const fixture = JSON.parse(await readFile('tests/fixtures/indmoney-holdings-mcp.json', 'utf8'));

const stubClient = (payload: unknown) =>
  ({ callTool: async () => payload } as unknown as McpClient);

describe('RemoteIndmoneySource', () => {
  it('produces the same SourceRow shape as the file source', async () => {
    const { rows, asOf } = await new RemoteIndmoneySource({ client: stubClient(fixture) }).fetch();
    expect(rows.length).toBeGreaterThan(0);
    expect(asOf).toMatch(/^\d{4}-\d{2}-\d{2}/);
    for (const r of rows) {
      expect(r.account).toBe('indmoney');
      expect(typeof r.valuePaise).toBe('bigint');
      expect(r.avgCostPaise === null || typeof r.avgCostPaise === 'bigint').toBe(true);
    }
  });

  it('maps a zero or missing invested amount to null cost, never 0 (FR-02)', async () => {
    const { rows } = await new RemoteIndmoneySource({
      client: stubClient({ holdings: [
        { name: 'Zerodha-linked ETF', current_value: 95000, invested_value: 0, asset_type: 'EQUITY' },
      ] }),
    }).fetch();
    expect(rows[0]!.avgCostPaise).toBeNull();
  });

  it('fails loudly on an unrecognised payload instead of syncing an empty portfolio', async () => {
    await expect(new RemoteIndmoneySource({ client: stubClient({ unexpected: true }) }).fetch())
      .rejects.toThrow(/could not parse/i);
  });
});
```

- [ ] **Step 5: Run it, watch it fail, then add `RemoteIndmoneySource` to `src/sources/indmoney.ts`**

Run: `pnpm test tests/sources/indmoney-remote.test.ts` → FAIL (not exported).

Write the mapper against the **captured** field names. The skeleton below assumes `{ holdings: [{ name, current_value, invested_value, asset_type, isin?, issuer? }] }` — adjust to reality, keep the guarantees (`account: 'indmoney'`, falsy invested → `null`, unknown shape → throw).

```ts
import type { McpClient } from './mcp-client.js';

interface RemoteHolding {
  name: string;
  current_value: number;
  invested_value?: number | null;
  asset_type?: string;
  isin?: string;
  issuer?: string;
}

const KIND_BY_ASSET_TYPE: Record<string, InstrumentSeed['kind']> = {
  EQUITY: 'EQUITY', STOCK: 'EQUITY', ETF: 'ETF', MUTUAL_FUND: 'MF', MF: 'MF',
  BOND: 'BOND', EPF: 'EPF', CASH: 'CASH', GOLD: 'GOLD', US_STOCK: 'EQUITY',
};

export class RemoteIndmoneySource implements Source {
  readonly name = 'indmoney';
  constructor(private readonly opts: { client: McpClient }) {}

  async fetch(): Promise<{ rows: SourceRow[]; asOf: string }> {
    const payload = await this.opts.client.callTool<{ holdings?: RemoteHolding[] }>(
      'networth_holdings', {},
    );
    if (!Array.isArray(payload.holdings)) {
      throw new Error(
        'could not parse INDmoney networth_holdings payload — the tool contract changed; ' +
        'recapture the fixture before trusting this sync',
      );
    }

    const rows = payload.holdings.map((h): SourceRow => {
      const kind = KIND_BY_ASSET_TYPE[h.asset_type ?? ''] ?? 'EQUITY';
      const instrumentId = h.isin ? `ISIN:${h.isin}` : `IND:${h.name.replace(/\s+/g, '-').toUpperCase()}`;
      return {
        instrumentId,
        account: 'indmoney',
        quantity: 1,
        valuePaise: rupees(h.current_value.toFixed(2)),
        // INDmoney returns 0/absent invested value for Zerodha-linked rows — unknown, not free.
        avgCostPaise: h.invested_value ? rupees(h.invested_value.toFixed(2)) : null,
        instrument: {
          id: instrumentId, kind, name: h.name, currency: 'INR',
          ...(h.issuer ? { issuer: h.issuer } : {}),
        },
      };
    });

    return { rows, asOf: new Date().toISOString() };
  }
}
```

- [ ] **Step 6: Wire it into the sync job**

In `src/jobs/sync.ts`, replace the unconditional `FileIndmoneySource` with: build a `RemoteIndmoneySource` when `oauth_tokens` has an `indmoney` row; fall back to `FileIndmoneySource` otherwise. Catch `ReauthRequired` in `runSync` and open a `SYNC_FAILURE` incident whose detail is the error's message (which already says `Run: pnpm indmoney:login`), so the digest nags with the fix.

Add a test to `tests/jobs/sync.test.ts`:

```ts
it('turns a ReauthRequired into an actionable incident naming the login command', async () => {
  const reauth: Source = {
    name: 'indmoney',
    fetch: async () => { throw new ReauthRequired('indmoney', 'refresh token expired'); },
  };
  await runSync(db, { now: '2026-08-12T17:30:00+05:30', sources: [reauth] });
  const [row] = await db.query<{ detail: string }>(
    `select detail from incidents where kind = 'SYNC_FAILURE' and subject = 'indmoney'`,
  );
  expect(row!.detail).toMatch(/pnpm indmoney:login/);
});
```

- [ ] **Step 7: Run the full suite and a real sync**

```bash
pnpm test
pnpm indmoney:login
pnpm sync && DRY_RUN=1 pnpm digest
```

Expected: the digest's INDmoney figures match the INDmoney app within 1%.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(sources): MCP client and OAuth-backed RemoteIndmoneySource with reauth nagging"
```

---

### Task 12: Staleness engine

**Files:**
- Create: `src/sources/staleness.ts`
- Test: `tests/sources/staleness.test.ts`

**Interfaces:**
- Consumes: schema (Task 3), `Position` (Task 9).
- Produces:
  - `FRESHNESS_HOURS: Record<string, number>` — `{ prices: 24, navs: 48, fundamentals: 2160, fx: 48, portfolio: 36 }`
  - `interface StalenessRow { source: string; asOf: string; ageHours: number; limitHours: number; stale: boolean }`
  - `assessStaleness(db: Db, now: string): Promise<StalenessRow[]>`
  - `raiseIncidents(db: Db, rows: StalenessRow[]): Promise<number>` — opens one `STALE_DATA` incident per newly-stale source, resolves incidents whose source is fresh again
  - `blockedInstruments(rows: StalenessRow[], positions: Position[]): string[]` — the FR-31 block list Phase 1's engine will consume

**FR-31 rule:** staleness never silently drops data — the last-known position still counts toward net worth, but the digest is badged, an incident is open, and the returned block list names every instrument whose recommendation generation must be refused.

- [ ] **Step 1: Write the failing test**

`tests/sources/staleness.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadPositions } from '../../src/domain/networth.js';
import { assessStaleness, blockedInstruments, raiseIncidents } from '../../src/sources/staleness.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

describe('staleness engine', () => {
  it('reports a fresh portfolio source as fresh', async () => {
    const rows = await assessStaleness(db, '2026-08-12T18:00:00+05:30');
    const seedRow = rows.find((r) => r.source === 'manual-seed')!;
    expect(seedRow.stale).toBe(false);
    expect(seedRow.limitHours).toBe(36);
  });

  it('flags a portfolio source older than 36 hours', async () => {
    const rows = await assessStaleness(db, '2026-08-15T18:00:00+05:30');
    expect(rows.find((r) => r.source === 'manual-seed')!.stale).toBe(true);
  });

  it('opens exactly one incident per stale source and does not duplicate on re-run', async () => {
    const rows = await assessStaleness(db, '2026-08-15T18:00:00+05:30');
    expect(await raiseIncidents(db, rows)).toBe(1);
    expect(await raiseIncidents(db, rows)).toBe(0);
    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents where kind = 'STALE_DATA' and resolved_at is null`,
    );
    expect(Number(open[0]!.n)).toBe(1);
  });

  it('resolves the incident once the source is fresh again', async () => {
    await raiseIncidents(db, await assessStaleness(db, '2026-08-15T18:00:00+05:30'));
    await raiseIncidents(db, await assessStaleness(db, '2026-08-12T18:00:00+05:30'));
    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents where kind = 'STALE_DATA' and resolved_at is null`,
    );
    expect(Number(open[0]!.n)).toBe(0);
  });

  it('names every instrument whose recommendations must be blocked (FR-31)', async () => {
    const rows = await assessStaleness(db, '2026-08-15T18:00:00+05:30');
    const blocked = blockedInstruments(rows, await loadPositions(db));
    expect(blocked).toContain('US:NOW');
    expect(blocked.length).toBeGreaterThan(5);
  });

  it('blocks nothing when every source is fresh', async () => {
    const rows = await assessStaleness(db, '2026-08-12T18:00:00+05:30');
    expect(blockedInstruments(rows, await loadPositions(db))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm test tests/sources/staleness.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/sources/staleness.ts`**

```ts
import type { Db } from '../db/client.js';
import type { Position } from '../domain/networth.js';

/** PRD §8.2 freshness policy, in hours. Fundamentals = one quarter. */
export const FRESHNESS_HOURS: Record<string, number> = {
  prices: 24,
  navs: 48,
  fundamentals: 90 * 24,
  fx: 48,
  portfolio: 36,
};

/** Every portfolio source shares the 36h portfolio limit unless listed otherwise. */
const LIMIT_BY_SOURCE: Record<string, number> = {
  fx: FRESHNESS_HOURS.fx!,
  amfi: FRESHNESS_HOURS.navs!,
  bhavcopy: FRESHNESS_HOURS.prices!,
  screener: FRESHNESS_HOURS.fundamentals!,
};

export interface StalenessRow {
  source: string;
  asOf: string;
  ageHours: number;
  limitHours: number;
  stale: boolean;
}

export async function assessStaleness(db: Db, now: string): Promise<StalenessRow[]> {
  const rows = await db.query<{ source: string; as_of: string }>(
    `select source, max(as_of) as as_of from holdings group by source`,
  );
  const nowMs = Date.parse(now);

  return rows.map((r) => {
    const asOf = typeof r.as_of === 'string' ? r.as_of : new Date(r.as_of).toISOString();
    const ageHours = (nowMs - Date.parse(asOf)) / 3_600_000;
    const limitHours = LIMIT_BY_SOURCE[r.source] ?? FRESHNESS_HOURS.portfolio!;
    return { source: r.source, asOf, ageHours, limitHours, stale: ageHours > limitHours };
  });
}

/**
 * Opens one incident per newly-stale source and resolves those that recovered.
 * Loud failure is the contract (PRD §8.2): silent degradation is the failure mode
 * this whole engine exists to prevent.
 */
export async function raiseIncidents(db: Db, rows: StalenessRow[]): Promise<number> {
  let opened = 0;

  for (const row of rows) {
    const open = await db.query<{ id: string }>(
      `select id from incidents
       where kind = 'STALE_DATA' and subject = $1 and resolved_at is null`,
      [row.source],
    );

    if (row.stale && open.length === 0) {
      await db.query(
        `insert into incidents (kind, severity, subject, detail)
         values ('STALE_DATA', 'BLOCK', $1, $2)`,
        [row.source,
         `${row.source} last updated ${row.ageHours.toFixed(1)}h ago (limit ${row.limitHours}h)`],
      );
      await db.query(
        `insert into audit_log (entity, entity_id, action, actor, payload)
         values ('incident', $1, 'STALE_DATA_OPENED', 'agent', $2::jsonb)`,
        [row.source, JSON.stringify(row)],
      );
      opened++;
    }

    if (!row.stale && open.length > 0) {
      await db.query(
        `update incidents set resolved_at = now()
         where kind = 'STALE_DATA' and subject = $1 and resolved_at is null`,
        [row.source],
      );
    }
  }

  return opened;
}

/** FR-31: instruments whose data is stale may not feed recommendation generation. */
export function blockedInstruments(rows: StalenessRow[], positions: Position[]): string[] {
  const staleSources = new Set(rows.filter((r) => r.stale).map((r) => r.source));
  return [
    ...new Set(
      positions.filter((p) => staleSources.has(p.source)).map((p) => p.instrumentId),
    ),
  ].sort();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test tests/sources/staleness.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(sources): staleness engine with incidents and FR-31 block list"
```

---

### Task 13: IPS v1 — stored, versioned, rendered

**Files:**
- Create: `src/config/ips-v1.md`, `src/domain/ips.ts`, `src/jobs/ips.ts`
- Test: `tests/domain/ips.test.ts`

**Interfaces:**
- Consumes: schema (Task 3).
- Produces:
  - `IPS_V1_TEXT: string` (read from `src/config/ips-v1.md` at module load)
  - `installIps(db: Db, opts?: { effectiveAt?: string }): Promise<{ version: number; created: boolean }>` — idempotent; installing identical text is a no-op
  - `currentIps(db: Db): Promise<{ version: number; fullText: string; effectiveAt: string }>`
  - `ipsClause(fullText: string, clause: string): string` — e.g. `ipsClause(text, '3.5')` returns the concentration-caps section; Phase 1's `FR-10` citation machinery depends on this
  - `renderIps(fullText: string, clause?: string): string`

- [ ] **Step 1: Create `src/config/ips-v1.md`**

Copy PRD §3 **verbatim** — sections 3.1 through 3.10, headings included — into this file, prefixed with the following front matter. Verbatim matters: Phase 2's behavioural protocol (§3.10) shows this text back to the owner at −20% drawdown, and a paraphrase there is a product failure.

```markdown
# Investment Policy Statement — Version 1

**Owner:** Anirban Sarkar
**Effective:** 2026-08-12
**Binding:** Every recommendation must cite the clause(s) it serves. Changes require
explicit owner action outside a drawdown and take effect after a 48-hour cooling-off.

## 3.1 Philosophy
Long-term, tax-aware, evidence-based investing for a specific household's goals. The owner
is an investor, not a trader. Activity is a cost. The default action is no action.

## 3.2 Objective function
[…continue verbatim through §3.10 Behavioral protocol…]
```

- [ ] **Step 2: Write the failing test**

`tests/domain/ips.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { currentIps, installIps, ipsClause, IPS_V1_TEXT } from '../../src/domain/ips.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

describe('IPS v1', () => {
  it('carries every clause 3.1 through 3.10', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      expect(IPS_V1_TEXT).toContain(`## 3.${n} `);
    }
  });

  it('states the never-events verbatim', () => {
    expect(IPS_V1_TEXT).toMatch(/F&O/);
    expect(IPS_V1_TEXT).toMatch(/leverage/i);
    expect(IPS_V1_TEXT).toMatch(/default action is no action/);
  });

  it('installs as version 1 and is idempotent for identical text', async () => {
    expect(await installIps(db)).toEqual({ version: 1, created: true });
    expect(await installIps(db)).toEqual({ version: 1, created: false });
    const [{ n }] = await db.query<{ n: string }>('select count(*) as n from ips_versions');
    expect(Number(n)).toBe(1);
  });

  it('returns the current version with its effective date', async () => {
    await installIps(db, { effectiveAt: '2026-08-12T00:00:00+05:30' });
    const ips = await currentIps(db);
    expect(ips.version).toBe(1);
    expect(ips.fullText).toBe(IPS_V1_TEXT);
  });

  it('extracts a single clause for recommendation citations', () => {
    const clause = ipsClause(IPS_V1_TEXT, '3.5');
    expect(clause).toMatch(/single stock/i);
    expect(clause).not.toMatch(/## 3\.6/);
  });

  it('throws on an unknown clause rather than citing nothing', () => {
    expect(() => ipsClause(IPS_V1_TEXT, '3.99')).toThrow(/3\.99/);
  });
});
```

- [ ] **Step 3: Run it, watch it fail, then write `src/domain/ips.ts`**

Run: `pnpm test tests/domain/ips.test.ts` → FAIL (module not found).

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/client.js';

export const IPS_V1_TEXT = readFileSync(
  fileURLToPath(new URL('../config/ips-v1.md', import.meta.url)),
  'utf8',
);

/** Versioned and append-only in spirit: a new version is a new row, never an edit. */
export async function installIps(
  db: Db,
  opts: { effectiveAt?: string } = {},
): Promise<{ version: number; created: boolean }> {
  const existing = await db.query<{ version: number; full_text: string }>(
    'select version, full_text from ips_versions order by version desc limit 1',
  );

  if (existing[0]?.full_text === IPS_V1_TEXT) {
    return { version: Number(existing[0].version), created: false };
  }

  const version = existing[0] ? Number(existing[0].version) + 1 : 1;
  await db.query(
    'insert into ips_versions (version, full_text, effective_at) values ($1,$2,$3)',
    [version, IPS_V1_TEXT, opts.effectiveAt ?? new Date().toISOString()],
  );
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('ips', $1, 'INSTALLED', 'owner', $2::jsonb)`,
    [String(version), JSON.stringify({ version })],
  );
  return { version, created: true };
}

export async function currentIps(
  db: Db,
): Promise<{ version: number; fullText: string; effectiveAt: string }> {
  const [row] = await db.query<{ version: number; full_text: string; effective_at: string }>(
    'select version, full_text, effective_at from ips_versions order by version desc limit 1',
  );
  if (!row) throw new Error('no IPS installed — run installIps() before generating anything');
  return {
    version: Number(row.version),
    fullText: row.full_text,
    effectiveAt: typeof row.effective_at === 'string'
      ? row.effective_at
      : new Date(row.effective_at).toISOString(),
  };
}

/** Extracts one '## <clause> ...' section. Phase 1 cites clauses on every recommendation. */
export function ipsClause(fullText: string, clause: string): string {
  const start = fullText.indexOf(`## ${clause} `);
  if (start === -1) throw new Error(`IPS clause ${clause} not found`);
  const rest = fullText.slice(start);
  const next = rest.indexOf('\n## ', 1);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

export function renderIps(fullText: string, clause?: string): string {
  return clause ? ipsClause(fullText, clause) : fullText;
}
```

- [ ] **Step 4: Write `src/jobs/ips.ts` (the render surface for Phase 0)**

```ts
import { openDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { currentIps, installIps, renderIps } from '../domain/ips.js';

const clause = process.argv[2];
const db = await openDb();
await runMigrations(db);
await installIps(db);
const ips = await currentIps(db);
console.log(`IPS v${ips.version} (effective ${ips.effectiveAt})\n`);
console.log(renderIps(ips.fullText, clause));
await db.close();
```

- [ ] **Step 5: Run the tests and the CLI**

Run: `pnpm test tests/domain/ips.test.ts` → PASS (6 tests).
Run: `pnpm ips 3.5` → prints the concentration-caps clause.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(ips): versioned IPS v1 storage, clause extraction and render CLI"
```

---

### Task 14: Telegram notifier and the daily digest

**Files:**
- Create: `src/notify/telegram.ts`, `src/notify/digest.ts`
- Test: `tests/notify/telegram.test.ts`, `tests/notify/digest.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–13.
- Produces:
  - `class Telegram { constructor(opts: { botToken: string; ownerChatId: string; dryRun?: boolean; fetchImpl?: typeof fetch }); send(markdown: string): Promise<{ sent: boolean }>; isOwner(chatId: string | number): boolean }`
  - `interface DigestInput { businessDate: string; netWorth: ReturnType<typeof netWorth>; previous: Paise | null; drift: DriftRow[]; concentration: ReturnType<typeof concentration>; buckets: BucketStatus[]; milestones: MilestoneStatus[]; staleness: StalenessRow[]; nextVest: VestEvent | null; ipsVersion: number; funded: { floorRatio: number; stretchRatio: number } }`
  - `composeDigest(input: DigestInput): string` — **pure**, no I/O, no LLM
  - `buildDigestInput(db: Db, now: string): Promise<DigestInput>`

**Digest contract (FR-50):** net worth incl. NOW and EPF, day/period change, bucket status, drift vs IPS, staleness report, milestone nags. Phase 0 has no pending approvals, so that section reads "none (Phase 0: advisory reporting only)". Message is Telegram MarkdownV2-safe.

- [ ] **Step 1: Write the failing test for the notifier**

`tests/notify/telegram.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { Telegram } from '../../src/notify/telegram.js';

const ok: typeof fetch = (async () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

describe('Telegram', () => {
  it('posts to the owner chat only', async () => {
    let seenBody: Record<string, unknown> = {};
    const capture: typeof fetch = (async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await new Telegram({ botToken: 'T', ownerChatId: '42', fetchImpl: capture }).send('hi');
    expect(seenBody.chat_id).toBe('42');
  });

  it('ignores commands from any other chat id (PRD 12.3)', () => {
    const tg = new Telegram({ botToken: 'T', ownerChatId: '42', fetchImpl: ok });
    expect(tg.isOwner('42')).toBe(true);
    expect(tg.isOwner(42)).toBe(true);
    expect(tg.isOwner('43')).toBe(false);
  });

  it('does not send in dry-run mode but reports what it would have sent', async () => {
    const tg = new Telegram({ botToken: 'T', ownerChatId: '42', dryRun: true, fetchImpl: () => {
      throw new Error('must not call the network in dry run');
    } });
    expect(await tg.send('hi')).toEqual({ sent: false });
  });

  it('surfaces a Telegram API error instead of failing silently', async () => {
    const bad: typeof fetch = (async () =>
      new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 })) as unknown as typeof fetch;
    await expect(new Telegram({ botToken: 'T', ownerChatId: '42', fetchImpl: bad }).send('hi'))
      .rejects.toThrow(/chat not found/);
  });

  it('splits a message longer than the 4096-character limit', async () => {
    let calls = 0;
    const counting: typeof fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await new Telegram({ botToken: 'T', ownerChatId: '42', fetchImpl: counting })
      .send('x\n'.repeat(3000));
    expect(calls).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run it, watch it fail, then write `src/notify/telegram.ts`**

Run: `pnpm test tests/notify/telegram.test.ts` → FAIL (module not found).

```ts
const MAX_MESSAGE = 4096;

export class Telegram {
  private readonly botToken: string;
  private readonly ownerChatId: string;
  private readonly dryRun: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: {
    botToken: string; ownerChatId: string; dryRun?: boolean; fetchImpl?: typeof fetch;
  }) {
    this.botToken = opts.botToken;
    this.ownerChatId = opts.ownerChatId;
    this.dryRun = opts.dryRun ?? false;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Single-user product: any other chat id is ignored outright (PRD §4.1, §12.3). */
  isOwner(chatId: string | number): boolean {
    return String(chatId) === this.ownerChatId;
  }

  async send(markdown: string): Promise<{ sent: boolean }> {
    if (this.dryRun) {
      console.log(`[dry-run] would send ${markdown.length} chars to ${this.ownerChatId}`);
      return { sent: false };
    }

    for (const chunk of split(markdown)) {
      const res = await this.fetchImpl(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.ownerChatId,
            text: chunk,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
          }),
        },
      );
      const body = (await res.json()) as { ok: boolean; description?: string };
      if (!body.ok) throw new Error(`Telegram sendMessage failed: ${body.description ?? res.status}`);
    }
    return { sent: true };
  }
}

/** Splits on line boundaries so tables and sections stay intact. */
function split(text: string): string[] {
  if (text.length <= MAX_MESSAGE) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > MAX_MESSAGE) {
      chunks.push(current);
      current = '';
    }
    current += `${line}\n`;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}
```

Run: `pnpm test tests/notify/telegram.test.ts` → PASS (5 tests).

- [ ] **Step 3: Write the failing test for the digest**

`tests/notify/digest.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { persistSchedules } from '../../src/domain/loans.js';
import { installIps } from '../../src/domain/ips.js';
import { buildDigestInput, composeDigest } from '../../src/notify/digest.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
  await persistSchedules(db, '2026-09-01');
  await installIps(db);
});

describe('daily digest', () => {
  it('leads with total net worth including NOW and EPF', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30'));
    expect(text).toMatch(/Net worth/i);
    expect(text).toMatch(/ServiceNow|NOW/);
    expect(text).toMatch(/EPF/);
  });

  it('shows liabilities and a true net figure', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30'));
    expect(text).toMatch(/Liabilities/i);
  });

  it('reports all four buckets and nags both milestones', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30'));
    for (const b of ['FI corpus', 'House fund', 'Emergency fund', 'Education corpus']) {
      expect(text).toContain(b);
    }
    expect(text).toMatch(/Term life cover/);
    expect(text).toMatch(/Health super top-up/);
  });

  it('flags the employer concentration breach the seeded portfolio actually has', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30'));
    expect(text).toMatch(/Employer cap/i);
  });

  it('badges staleness loudly when a source is old (FR-31)', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-20T08:45:00+05:30'));
    expect(text).toMatch(/STALE/i);
  });

  it('says data is fresh when it is', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30'));
    expect(text).toMatch(/fresh/i);
  });

  it('cites the IPS version it is reporting against', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30'));
    expect(text).toMatch(/IPS v1/);
  });

  it('states that Phase 0 has no pending approvals rather than omitting the section', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30'));
    expect(text).toMatch(/Pending approvals/i);
  });

  it('is a pure function — the same input renders the same output', async () => {
    const input = await buildDigestInput(db, '2026-08-12T08:45:00+05:30');
    expect(composeDigest(input)).toBe(composeDigest(input));
  });
});
```

- [ ] **Step 4: Run it, watch it fail, then write `src/notify/digest.ts`**

Run: `pnpm test tests/notify/digest.test.ts` → FAIL (module not found).

```ts
import type { Db } from '../db/client.js';
import { allocationDrift, concentration, type DriftRow } from '../domain/allocation.js';
import { bucketStatuses, milestoneStatuses, type BucketStatus, type MilestoneStatus } from '../domain/buckets.js';
import { fundedStatus } from '../domain/funded-status.js';
import { currentIps } from '../domain/ips.js';
import { loadPositions, netWorth, outstandingLiabilities } from '../domain/networth.js';
import { projectVests, type VestEvent } from '../domain/rsu.js';
import { assessStaleness, type StalenessRow } from '../sources/staleness.js';
import { ASSUMPTIONS } from '../config/assumptions.js';
import { formatInr, type Paise } from '../money/paise.js';

export interface DigestInput {
  businessDate: string;
  assetsPaise: Paise;
  liabilitiesPaise: Paise;
  netPaise: Paise;
  previousNetPaise: Paise | null;
  byAccount: [string, Paise][];
  drift: DriftRow[];
  breaches: string[];
  buckets: BucketStatus[];
  milestones: MilestoneStatus[];
  staleness: StalenessRow[];
  nextVest: VestEvent | null;
  ipsVersion: number;
  funded: { floorRatio: number; stretchRatio: number };
}

export async function buildDigestInput(db: Db, now: string): Promise<DigestInput> {
  const businessDate = now.slice(0, 10);
  const positions = await loadPositions(db);
  const liabilities = await outstandingLiabilities(db, `${businessDate.slice(0, 7)}-01`);
  const nw = netWorth(positions, liabilities);

  const grants = await db.query<{ id: string; granted_on: string; units: string; note: string }>(
    'select id, granted_on, units, note from rsu_grants',
  );
  const vests = projectVests(
    grants.map((g) => ({ id: g.id, grantedOn: g.granted_on, units: Number(g.units), note: g.note })),
    {
      priceUsd: ASSUMPTIONS.seedNowPriceUsd,
      usdInr: ASSUMPTIONS.seedUsdInr,
      from: businessDate,
      to: `${Number(businessDate.slice(0, 4)) + 1}-12-31`,
    },
  );

  return {
    businessDate,
    assetsPaise: nw.assetsPaise,
    liabilitiesPaise: nw.liabilitiesPaise,
    netPaise: nw.netPaise,
    previousNetPaise: null, // Phase 0 seeds a single snapshot; day-change lights up on day two.
    byAccount: [...nw.byAccount.entries()],
    drift: allocationDrift(nw.byAssetClass, nw.assetsPaise),
    breaches: concentration(positions).breaches,
    buckets: await bucketStatuses(db),
    milestones: await milestoneStatuses(db, businessDate),
    staleness: await assessStaleness(db, now),
    nextVest: vests[0] ?? null,
    ipsVersion: (await currentIps(db)).version,
    funded: fundedStatus(nw.assetsPaise),
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Pure: state in, markdown out. No I/O, no LLM — Phase 1 adds narration on top. */
export function composeDigest(d: DigestInput): string {
  const lines: string[] = [];

  lines.push(`*Sentinel — ${d.businessDate}*  _(IPS v${d.ipsVersion})_`, '');

  lines.push('*Net worth*');
  lines.push(`Assets: ${formatInr(d.assetsPaise, { compact: true })}`);
  lines.push(`Liabilities: ${formatInr(d.liabilitiesPaise, { compact: true })}`);
  lines.push(`*Net: ${formatInr(d.netPaise, { compact: true })}*`);
  if (d.previousNetPaise !== null) {
    const change = (d.netPaise - d.previousNetPaise) as Paise;
    lines.push(`Change since last sync: ${formatInr(change, { compact: true })}`);
  } else {
    lines.push('_Change: first snapshot — day-over-day starts tomorrow._');
  }
  lines.push('');

  lines.push('*By account*');
  for (const [account, value] of d.byAccount.sort((a, b) => Number(b[1] - a[1]))) {
    const label = account === 'fidelity' ? 'fidelity (ServiceNow NOW)' : account;
    lines.push(`• ${label}: ${formatInr(value, { compact: true })}`);
  }
  lines.push('');

  lines.push('*Allocation vs IPS §3.3*');
  for (const row of d.drift) {
    const flag = row.breach ? ` ⚠️ ${row.breach} by ${formatInr(row.driftPaise, { compact: true })}` : '';
    lines.push(`• ${row.assetClass}: ${pct(row.actual)} (band ${pct(row.min)}–${pct(row.max)})${flag}`);
  }
  lines.push('');

  if (d.breaches.length) {
    lines.push('*Concentration breaches (IPS §3.5)*');
    for (const b of d.breaches) lines.push(`• ⚠️ ${b}`);
    lines.push('');
  }

  lines.push('*Buckets*');
  for (const b of d.buckets) {
    const funded = b.fundedRatio === null ? b.targetNote : `${pct(b.fundedRatio)} of ${formatInr(b.targetPaise!, { compact: true })}`;
    lines.push(`• ${b.name}: ${formatInr(b.balancePaise, { compact: true })} — ${funded}`);
  }
  lines.push('');

  const openMilestones = d.milestones.filter((m) => !m.completedOn);
  if (openMilestones.length) {
    lines.push('*Protection milestones — still open*');
    for (const m of openMilestones) {
      lines.push(`• ❗ ${m.name}: ${m.spec} _(${m.daysOutstanding} days outstanding)_`);
    }
    lines.push('');
  }

  if (d.nextVest) {
    lines.push('*Next RSU vest*');
    lines.push(
      `${d.nextVest.vestOn}: ~${formatInr(d.nextVest.netPaise, { compact: true })} net (projected)`,
      '',
    );
  }

  lines.push('*Data freshness*');
  const stale = d.staleness.filter((s) => s.stale);
  if (stale.length === 0) {
    lines.push('✅ All sources fresh.');
  } else {
    for (const s of stale) {
      lines.push(`🔴 STALE: ${s.source} — ${s.ageHours.toFixed(0)}h old (limit ${s.limitHours}h)`);
    }
    lines.push('_Recommendations for affected instruments are blocked (FR-31)._');
  }
  lines.push('');

  lines.push('*Pending approvals*');
  lines.push('None — Phase 0 is advisory reporting only.');
  lines.push('');

  lines.push(
    `_Funded status (reporting only, never a risk input): ${pct(d.funded.floorRatio)} of the FI floor._`,
  );

  return lines.join('\n');
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test tests/notify`
Expected: PASS (14 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(notify): owner-locked Telegram client and pure daily digest composer"
```

---

### Task 15: Jobs, scheduling and the provisioning checklist

**Files:**
- Create: `src/jobs/sync.ts`, `src/jobs/digest.ts`, `src/jobs/keepalive.ts`, `.github/workflows/sync.yml`, `.github/workflows/digest.yml`, `.github/workflows/keepalive.yml`, `.env.example`, `README.md`, `data/indmoney-snapshot.example.json`
- Test: `tests/jobs/sync.test.ts`

**Interfaces:**
- Consumes: everything.
- Produces: `runSync(db: Db, opts: { now: string; sources: Source[] }): Promise<{ synced: string[]; failed: { source: string; error: string }[] }>` and `runDigest(db, opts: { now: string; telegram: Telegram }): Promise<{ sent: boolean }>`.

**Failure contract (§8.2):** a failing source never fails the whole sync silently. It is recorded, an incident opens, and the digest reports it. Two consecutive failures escalate to an explicit alert.

- [ ] **Step 1: Write the failing test**

`tests/jobs/sync.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { runSync } from '../../src/jobs/sync.js';
import { FileIndmoneySource } from '../../src/sources/indmoney.js';
import type { Source } from '../../src/sources/types.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

const failing: Source = {
  name: 'kite',
  fetch: async () => { throw new Error('Invalid access token'); },
};

describe('sync job', () => {
  it('writes a snapshot per healthy source', async () => {
    const result = await runSync(db, {
      now: '2026-08-12T17:30:00+05:30',
      sources: [new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json')],
    });
    expect(result.synced).toEqual(['indmoney']);
    expect(result.failed).toEqual([]);
  });

  it('records a failing source without aborting the healthy ones', async () => {
    const result = await runSync(db, {
      now: '2026-08-12T17:30:00+05:30',
      sources: [failing, new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json')],
    });
    expect(result.synced).toEqual(['indmoney']);
    expect(result.failed[0]).toMatchObject({ source: 'kite' });
    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents where kind = 'SYNC_FAILURE' and resolved_at is null`,
    );
    expect(Number(open[0]!.n)).toBe(1);
  });

  it('escalates to BLOCK severity after two consecutive failures (PRD 8.2)', async () => {
    const opts = { now: '2026-08-12T17:30:00+05:30', sources: [failing] };
    await runSync(db, opts);
    await runSync(db, { ...opts, now: '2026-08-13T17:30:00+05:30' });
    const rows = await db.query<{ severity: string }>(
      `select severity from incidents where kind = 'SYNC_FAILURE' and resolved_at is null`,
    );
    expect(rows.some((r) => r.severity === 'BLOCK')).toBe(true);
  });

  it('refreshes loan schedules and projected vests as part of the sync', async () => {
    await runSync(db, {
      now: '2026-08-12T17:30:00+05:30',
      sources: [new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json')],
    });
    const [sched] = await db.query<{ n: string }>('select count(*) as n from loan_schedule');
    const [vests] = await db.query<{ n: string }>('select count(*) as n from rsu_vests');
    expect(Number(sched!.n)).toBeGreaterThan(0);
    expect(Number(vests!.n)).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it, watch it fail, then write `src/jobs/sync.ts`**

Run: `pnpm test tests/jobs/sync.test.ts` → FAIL (module not found).

```ts
import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../config/env.js';
import { ASSUMPTIONS } from '../config/assumptions.js';
import { persistSchedules } from '../domain/loans.js';
import { installIps } from '../domain/ips.js';
import { persistVests, projectVests } from '../domain/rsu.js';
import { FileIndmoneySource } from '../sources/indmoney.js';
import { KiteSource } from '../sources/kite.js';
import { assessStaleness, raiseIncidents } from '../sources/staleness.js';
import { writeSnapshot, type Source } from '../sources/types.js';

export async function runSync(
  db: Db,
  opts: { now: string; sources: Source[] },
): Promise<{ synced: string[]; failed: { source: string; error: string }[] }> {
  const businessDate = opts.now.slice(0, 10);
  const synced: string[] = [];
  const failed: { source: string; error: string }[] = [];

  for (const source of opts.sources) {
    try {
      const { rows, asOf } = await source.fetch();
      await writeSnapshot(db, source.name, businessDate, rows, asOf);
      await db.query(
        `update incidents set resolved_at = now()
         where kind = 'SYNC_FAILURE' and subject = $1 and resolved_at is null`,
        [source.name],
      );
      synced.push(source.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ source: source.name, error: message });

      const open = await db.query<{ id: string }>(
        `select id from incidents where kind = 'SYNC_FAILURE' and subject = $1 and resolved_at is null`,
        [source.name],
      );
      // Second consecutive failure escalates: never degrade silently (PRD §8.2).
      const severity = open.length > 0 ? 'BLOCK' : 'WARN';
      await db.query(
        `insert into incidents (kind, severity, subject, detail) values ('SYNC_FAILURE',$1,$2,$3)`,
        [severity, source.name, message],
      );
    }
  }

  await persistSchedules(db, `${businessDate.slice(0, 7)}-01`);

  const grants = await db.query<{ id: string; granted_on: string; units: string; note: string }>(
    'select id, granted_on, units, note from rsu_grants',
  );
  await persistVests(
    db,
    projectVests(
      grants.map((g) => ({ id: g.id, grantedOn: g.granted_on, units: Number(g.units), note: g.note })),
      {
        priceUsd: ASSUMPTIONS.seedNowPriceUsd,
        usdInr: ASSUMPTIONS.seedUsdInr,
        from: businessDate,
        to: `${Number(businessDate.slice(0, 4)) + 5}-12-31`,
      },
    ),
  );

  await raiseIncidents(db, await assessStaleness(db, opts.now));
  return { synced, failed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = loadEnv();
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);
  await installIps(db);

  const sources: Source[] = [new FileIndmoneySource(env.indmoneySnapshotPath)];
  if (env.kiteApiKey && env.kiteAccessToken) {
    sources.push(new KiteSource({ apiKey: env.kiteApiKey, accessToken: env.kiteAccessToken }));
  }

  const result = await runSync(db, { now: new Date().toISOString(), sources });
  console.log(`synced: ${result.synced.join(', ') || 'none'}`);
  if (result.failed.length) {
    console.error(`failed: ${result.failed.map((f) => `${f.source} (${f.error})`).join('; ')}`);
  }
  await db.close();
  if (result.synced.length === 0) process.exitCode = 1;
}
```

- [ ] **Step 3: Write `src/jobs/digest.ts`**

```ts
import { openDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../config/env.js';
import { installIps } from '../domain/ips.js';
import { buildDigestInput, composeDigest } from '../notify/digest.js';
import { Telegram } from '../notify/telegram.js';

const env = loadEnv();
const db = await openDb(env.databaseUrl);
await runMigrations(db);
await installIps(db);

const now = new Date().toISOString();
const text = composeDigest(await buildDigestInput(db, now));

const telegram = new Telegram({
  botToken: env.telegramBotToken,
  ownerChatId: env.telegramOwnerChatId,
  dryRun: env.dryRun,
});
const { sent } = await telegram.send(text);
console.log(sent ? 'digest sent' : `digest not sent (dry run)\n\n${text}`);
await db.close();
```

- [ ] **Step 4: Write `src/jobs/keepalive.ts`**

```ts
import { openDb } from '../db/client.js';
import { loadEnv } from '../config/env.js';

// Supabase free tier pauses idle projects; a weekly write plus the daily sync keeps it awake.
const env = loadEnv();
const db = await openDb(env.databaseUrl);
await db.query(
  `insert into audit_log (entity, entity_id, action, actor, payload)
   values ('system', 'keepalive', 'PINGED', 'system', '{}'::jsonb)`,
);
console.log('keepalive ping written');
await db.close();
```

- [ ] **Step 5: Write the GitHub Actions workflows**

`.github/workflows/sync.yml` (17:30 IST = 12:00 UTC, trading days):

```yaml
name: sync
on:
  schedule:
    - cron: '0 12 * * 1-5'
  workflow_dispatch:

jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 10 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm sync
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
          TELEGRAM_BOT_TOKEN: ${{ secrets.TELEGRAM_BOT_TOKEN }}
          TELEGRAM_OWNER_CHAT_ID: ${{ secrets.TELEGRAM_OWNER_CHAT_ID }}
          KITE_API_KEY: ${{ secrets.KITE_API_KEY }}
          KITE_ACCESS_TOKEN: ${{ secrets.KITE_ACCESS_TOKEN }}
```

`.github/workflows/digest.yml` (08:45 IST = 03:15 UTC, trading days) — same steps, `run: pnpm digest`, same env block minus the Kite keys.

`.github/workflows/keepalive.yml` (Sundays 04:00 UTC) — same steps, `run: pnpm exec tsx src/jobs/keepalive.ts`.

> GitHub's scheduler drifts 5–15 minutes under load. That is accepted (PRD §12.2) — an EOD-signal investor cannot tell the difference.

- [ ] **Step 6: Write `.env.example` and `data/indmoney-snapshot.example.json`**

`.env.example`:

```bash
# Leave DATABASE_URL unset to use embedded PGlite locally.
# Supabase: postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
DATABASE_URL=

TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_CHAT_ID=

# Optional in Phase 0 — read-only holdings sync. Never a TOTP secret.
KITE_API_KEY=
KITE_ACCESS_TOKEN=

# 32 random bytes, base64. Encrypts the INDmoney refresh token at rest.
# node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
TOKEN_ENCRYPTION_KEY=

# Manual fallback only; the OAuth source is preferred once you have run indmoney:login
INDMONEY_SNAPSHOT_PATH=data/indmoney-snapshot.json

# 1 = compose the digest but do not send it
DRY_RUN=
```

`data/indmoney-snapshot.example.json` — copy `tests/fixtures/indmoney-snapshot.json`.

- [ ] **Step 7: Write `README.md` with the provisioning checklist**

Include, in this order: what Sentinel is and who it is for (one paragraph, plus the §4.1 sole-user boundary stated explicitly); local quickstart (`pnpm install && pnpm migrate && pnpm seed && DRY_RUN=1 pnpm digest`); the provisioning checklist below; and the Phase 0 → Phase 1 handoff note.

```markdown
## Provisioning checklist (do these in order)

1. **Telegram** — message @BotFather, `/newbot`, copy the token. Message the new bot once,
   then open `https://api.telegram.org/bot<TOKEN>/getUpdates` to read your chat id.
   Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID`.
2. **Supabase** — create a free project, copy the *pooler* connection string into
   `DATABASE_URL`, run `pnpm migrate` once against it, then `pnpm seed`.
3. **Kite Connect (optional in Phase 0)** — create a Personal app at developers.kite.trade.
   Order APIs are free; market data is ₹500/month and Phase 0 does not need it.
   Static-IP registration is required only for order placement (Phase 3).
4. **INDmoney** — generate `TOKEN_ENCRYPTION_KEY`
   (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`),
   then run `pnpm indmoney:login` once. Your browser opens INDmoney's own sign-in page;
   complete OTP + MPIN there. Sentinel stores only an encrypted `portfolio:read`
   refresh token and syncs unattended from then on. If INDmoney ever expires the grant,
   the digest says so and names this command — re-run it and you're back.
   `data/indmoney-snapshot.json` remains as a manual fallback.
5. **GitHub Actions** — add every value from `.env.example` as a repository secret.
   Enable the three workflows.
6. **Verify the DoD** — compare the digest's per-account figures against Kite,
   INDmoney and Fidelity NetBenefits. They must agree within 1%.
```

- [ ] **Step 8: Run the full suite and the end-to-end dry run**

```bash
pnpm test
pnpm migrate && pnpm seed && DRY_RUN=1 pnpm digest
```

Expected: all tests pass; the digest prints to stdout showing net worth including NOW and EPF, four buckets, both milestone nags, allocation drift, and the employer/Sammaan concentration breaches.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(jobs): sync/digest/keepalive entrypoints, Actions schedules and setup docs"
```

---

## Phase 0 Definition of Done

Verified when all of the following hold:

1. `pnpm test` passes with no skipped tests.
2. `DRY_RUN=1 pnpm digest` renders a digest containing: total net worth including Fidelity NOW and EPF, liabilities, per-account breakdown, allocation drift vs IPS §3.3, concentration breaches vs §3.5, four bucket balances, both open milestone nags, next projected vest, and a freshness verdict.
3. The owner compares per-account figures against Kite, INDmoney and Fidelity and confirms agreement within **±1%**.
4. A deliberately aged snapshot produces `🔴 STALE` in the digest and an open `STALE_DATA` incident.
5. `pnpm ips 3.5` prints the concentration-caps clause verbatim.
6. `tests/architecture/no-catch-up.test.ts` passes — funded status is unreachable from risk code.
7. The three GitHub Actions workflows have each run green at least once.

## Self-Review

**Spec coverage (PRD Phase 0 scope: schema, Kite + INDmoney read sync, Fidelity vest model, loan/surplus model, Telegram digest, IPS v1 stored and rendered):**

| Requirement | Task |
|---|---|
| FR-01 Zerodha daily sync | 11, 15 |
| FR-02 INDmoney sync, unknown cost never ₹0 | 11 (+ scope call 2) |
| FR-03 Fidelity RSU model, PROJECTED/ACTUAL, reconciliation | 8 |
| FR-04 Net worth incl. Fidelity + EPF | 9, 14 |
| FR-05 Four buckets + two milestones | 10 |
| FR-06 Loan model + surplus curve (24m monthly, to 2050 annual) | 6, 7 |
| FR-07 Append-only audit | 3 |
| FR-16 No-catch-up property | 10 |
| FR-31 Staleness blocks | 12 |
| FR-50 Daily digest | 14 |
| §3 IPS stored + rendered + clause citation | 13 |
| §3.5 Concentration caps computed | 9 |
| §12.1–12.2 Stack + schedules | 15 |

**Deferred to later phases by design:** FR-10 through FR-15 (recommendation engine — Phase 1), FR-20 through FR-25 (approval workflow — Phase 2), FR-30/32–35 (rails, freeze, breaker — Phase 2), FR-40 through FR-44 (tax engine — Phase 3), FR-51 through FR-55 (weekly/quarterly/annual reporting and paper mode — Phases 1–2). The `settings_rails` and `incidents` tables are created in Phase 0 so those phases add behaviour, not schema.

**Known thin spots the implementer must not paper over:**
- The RSU per-grant split (Task 5) is reconstructed, not sourced. Tests assert aggregates with wide bands; the first quarterly reconciliation replaces it.
- `NSE:SMALLCASE-RESIDUE` is a placeholder *position*, not a placeholder *plan step* — it exists so the balance sheet reconciles before Kite's real holdings arrive, and it disappears on the first live Kite sync.
- Day-over-day change is null on day one. This is stated in the digest rather than hidden.
