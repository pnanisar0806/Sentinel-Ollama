# SIP tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sentinel reads the owner's live INDmoney SIPs every day, and every sizing path deploys only `budget − live SIPs` instead of a flat ₹50,000.

**Architecture:**
- A daily sync step writes an append-only `sip_snapshots` header plus `sips` rows.
- `src/domain/sips.ts` turns the latest snapshot into a commitment, step-up projections and the free monthly envelope.
- Sizing, the rebalance tranche, the order-rail gate, the allocation engine, the advisor prompt and three web surfaces read that one module.

**Tech Stack:** TypeScript, vitest, PGlite (tests) / postgres-js (Supabase), Next.js app in `web/`, INDmoney MCP via `McpClient`.

**Spec:** `docs/superpowers/specs/2026-10-14-sips-goals-advisor-design.md` §1. Read §0 (owner decisions) and §1 before starting.

## Global Constraints

- Money is never a float: branded `bigint` paise only (`src/money/paise.ts`). Source rupees convert with `rupees()` / exact integer maths.
- Every externally sourced row carries `as_of` and `source`.
- An unknown is `NULL`, never `0`, and renders as `unknown` / `—`, never `₹0`.
- Every new table is append-only: UPDATE, DELETE and TRUNCATE are refused by `sentinel_append_only()` triggers, and RLS is enabled.
- A failed or unparseable `mf_sips` call is a **failed sync step**, never "no SIPs".
- SIP data older than **7 days** makes the commitment `null`, and every sizing consumer then withholds. It never falls back to the full budget.
- `freeEnvelopePaise = max(0, min(tactical_monthly_paise, monthly_budget_paise − sipTotal))`.
- No module added or edited here may import `src/domain/buckets.ts` or `src/domain/funded-status.ts` (the no-catch-up architecture test must stay green; piece 2 changes it, not this plan).
- The `Db` interface is `{ query<T>(sql, params?): Promise<T[]>; exec(sql); withTransaction<T>(fn: (tx: Db) => Promise<T>); close() }` (`src/db/client.ts`). PGlite returns `bigint` columns as JS numbers and `date`/`timestamptz` as `Date`; postgres-js returns strings. Normalise both.
- Tests never touch a real DB: `tests/setup.ts` deletes `DATABASE_URL`; use `openDb()` + `runMigrations(db)`.
- Never widen a test band or edit an expected constant to make a red test green. Derive expected values from fixture rows.
- New web UI uses only `web/lib/ui.tsx` primitives (`PageHead`, `Card`, `DataTable`, `Badge`, `Stat`, `Notice`, `Money`) and is designed with the `ui-ux-pro-max` skill against `design-system/sentinel/MASTER.md`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

Failure modes the spec implies that no happy-path test would catch, most likely first. Each has an owning test below.

1. **INDmoney returns `mf_sips: []` on a bad day** (e.g. a mandate glitch) → a real `sip_count = 0` snapshot, envelope = full budget. Expected: that is a stated answer, so it is stored. The Overview card must still show "INDmoney reports no active SIPs (as of …)" rather than a blank card. *Owner: Task 9, empty-state test.*
2. **The SIP sync has not run since the 7-day limit** (OAuth expired, falling back to the file source, which has no SIPs) → envelope null → the advisor and the rebalance must withhold every BUY with a reason naming the last SIP sync date. *Owner: Task 5 (`loadFreeEnvelope` stale test), Task 7 (report suppression test).*
3. **SIPs exceed the budget** (owner raises SIPs before raising the budget) → envelope 0, every BUY withheld "SIPs already use the whole budget", and no negative number anywhere. *Owner: Task 5.*
4. **A step-up of `100` or below that was meant as rupees** → read as percent and shown "inferred". *Owner: Task 3 boundary test; the ceiling is stated in a `ponytail:` comment.*
5. **`sip_start_date` in the future** (all three today: 12-11-2026) → the SIP still counts in this month's commitment, and its first step-up is the start date's first anniversary (2027-11-12), not 2026-11-12. *Owner: Task 3.*

---

## File map

| file | change | responsibility |
|---|---|---|
| `migrations/0032_sips.sql` | create | `sip_snapshots`, `sips`, append-only triggers, RLS |
| `src/sources/indmoney.ts` | modify | `parseMfSips()`, `RemoteIndmoneySource.fetchSips()`, throttle retry (fix-on-touch minor #9) |
| `src/domain/sips.ts` | create | step-up inference, projection, `persistSipSnapshot`, `loadSipCommitment`, `loadFreeEnvelope` |
| `src/jobs/sync.ts` | modify | `fetchSips` option, `indmoney-sips` step, allowlist `mf_sips`, main wiring |
| `src/sources/staleness.ts` | modify | assess `indmoney-sips` at 168h |
| `src/domain/rails.ts` | modify | `monthly_budget_paise` default rail; both tactical checks against the envelope; delete the hard-coded ₹50k whole-book comparison |
| `src/domain/sizing.ts`, `src/domain/sizing-input.ts` | modify | envelope replaces the tactical rail; `envelopeReason` |
| `src/domain/alloc-engine.ts` | modify | SIP inflow into an overweight class reduces its dilution capacity |
| `src/notify/report.ts` | modify | SIP routes; tranche from the envelope; suppress BUYs when the envelope is null/0 |
| `src/advisor/recommend.ts`, `src/jobs/report.ts` | modify | `budget` context block; prompt `advise-v2` |
| `web/lib/data.ts`, `web/app/page.tsx`, `web/app/funds/page.tsx`, `web/app/cleanup/controls-panel.tsx`, `web/lib/product.ts` | modify | Monthly-investing card, SIP label per fund, budget in rail editor, product row |
| tests (listed per task) | create/modify | — |

---

### Task 1: Migration — `sip_snapshots` and `sips`

**Files:**
- Create: `migrations/0032_sips.sql`
- Modify: `tests/db/immutability.test.ts`

**Interfaces:**
- Produces: tables `sip_snapshots(id bigserial, as_of timestamptz, source text, sip_count int, created_at)` and `sips(...)` exactly as below. Later tasks insert and select by these column names.

- [ ] **Step 1: Write the failing test.** In `tests/db/immutability.test.ts`, do **not** add to `APPEND_ONLY`. Its companion test pins that list to the PRD's four audit tables, and the SIP tables are not among them. Add a separate test inside the same `describe`:

```ts
  it.each(['sip_snapshots', 'sips'])('the SIP ledger %s refuses UPDATE, DELETE and TRUNCATE', async (t) => {
    await expect(db.query(`update ${t} set source = source`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from ${t}`)).rejects.toThrow(/append-only/);
    await expect(db.query(`truncate ${t} cascade`)).rejects.toThrow(/append-only/);
  });
```

- [ ] **Step 2: Run it and verify it fails.**
Run: `pnpm vitest run tests/db/immutability.test.ts`
Expected: FAIL, `relation "sip_snapshots" does not exist`.

- [ ] **Step 3: Write the migration.** `migrations/0032_sips.sql`:

```sql
-- Live MF SIPs from INDmoney `mf_sips` (spec 2026-10-14 §1.3).
--
-- One sip_snapshots row per successful fetch; its sips rows are the ACTIVE SIPs at that
-- moment. The latest snapshot is the current set. sip_count = 0 is INDmoney saying "no
-- active SIPs" — a real answer — while NO snapshot means unknown. A SIP present in one
-- snapshot and absent from the next stopped between them; nothing is ever updated.

create table sip_snapshots (
  id          bigserial primary key,
  as_of       timestamptz not null,
  source      text not null default 'indmoney',
  sip_count   integer not null check (sip_count >= 0),
  created_at  timestamptz not null default now()
);
create index sip_snapshots_as_of_idx on sip_snapshots (as_of desc, id desc);

create table sips (
  id                bigserial primary key,
  snapshot_id       bigint not null references sip_snapshots(id),
  sip_id            text not null,
  -- 'IND:' || fund_id, the same id holdings use. Not a foreign key: a newly registered
  -- SIP's fund may not be an instrument yet (Invesco Midcap, 2026-10-13).
  instrument_id     text not null,
  isin              text,
  fund_name         text not null,
  fund_type         text,
  category          text,
  frequency         text not null,
  amount_paise      bigint not null check (amount_paise > 0),
  -- Exactly what INDmoney said. It carries no unit: 1000 meant Rs 1,000, 10 means 10%.
  step_up_raw       numeric,
  step_up_kind      text check (step_up_kind in ('percent', 'rupees', 'unknown')),
  step_up_inferred  boolean not null default false,
  step_up_freq      text,
  start_date        date not null,
  as_of             timestamptz not null,
  source            text not null default 'indmoney',
  unique (snapshot_id, sip_id)
);

do $$
declare t text;
begin
  foreach t in array array['sip_snapshots', 'sips'] loop
    execute format('create trigger %I before update or delete on %I for each statement execute function sentinel_append_only()', t || '_append_only', t);
    execute format('create trigger %I before truncate on %I for each statement execute function sentinel_append_only()', t || '_truncate_only', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I using (true) with check (true)', t || '_owner', t);
  end loop;
end $$;
```

- [ ] **Step 4: Run the tests and verify they pass.**
Run: `pnpm vitest run tests/db`
Expected: PASS (including `migrate.test.ts` and `trigger-integrity.test.ts`; if `trigger-integrity` enumerates tables lacking triggers, the new ones now have them).

- [ ] **Step 5: Commit.**

```bash
git add migrations/0032_sips.sql tests/db/immutability.test.ts
git commit -m "feat(db): append-only sip_snapshots and sips tables"
```

---

### Task 2: Source — parse and fetch `mf_sips`

**Files:**
- Modify: `src/sources/indmoney.ts`
- Create: `tests/sources/indmoney-sips.test.ts`
- Modify: `tests/sources/indmoney-remote.test.ts` (throttle retry)
- Fixture (already committed): `tests/fixtures/indmoney-mf-sips-2026-10-14.json`

**Interfaces:**
- Produces:

```ts
export interface SipRow {
  sipId: string; instrumentId: string; isin: string | null; fundName: string;
  fundType: string | null; category: string | null; frequency: string;
  amountPaise: bigint; stepUpRaw: number | null; stepUpFreq: string | null;
  startDate: string; // YYYY-MM-DD
}
export function parseMfSips(envelope: unknown): SipRow[];
// RemoteIndmoneySource:
fetchSips(): Promise<{ rows: SipRow[]; asOf: string }>;
```

- [ ] **Step 1: Write the failing tests.** `tests/sources/indmoney-sips.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseMfSips, RemoteIndmoneySource } from '../../src/sources/indmoney.js';
import type { McpClient } from '../../src/sources/mcp-client.js';

const fixture = JSON.parse(await readFile('tests/fixtures/indmoney-mf-sips-2026-10-14.json', 'utf8')) as {
  payload: { mf_sips: { name: string; isin: string; active_sips: { amount: number; fund_id: string; sip_id: string }[] }[] };
  _rateLimitedResponse: Record<string, unknown>;
};
const envelope = (p: unknown) => ({ result: JSON.stringify(p) });

describe('parseMfSips', () => {
  it('returns one row per active SIP, amounts in exact paise', () => {
    const rows = parseMfSips(envelope(fixture.payload));
    const expected = fixture.payload.mf_sips.flatMap((f) => f.active_sips.map((s) => ({
      sipId: s.sip_id, instrumentId: `IND:${s.fund_id}`, amountPaise: BigInt(s.amount) * 100n, isin: f.isin,
    })));
    expect(rows.map((r) => ({ sipId: r.sipId, instrumentId: r.instrumentId, amountPaise: r.amountPaise, isin: r.isin })))
      .toEqual(expected);
  });

  it('keeps the step-up exactly as given and converts the date to ISO', () => {
    const [nifty] = parseMfSips(envelope(fixture.payload));
    expect(nifty).toMatchObject({ stepUpRaw: 10, stepUpFreq: 'YEARLY', startDate: '2026-11-12', frequency: 'MONTHLY' });
  });

  it('a non-step-up SIP has a null step-up', () => {
    const p = structuredClone(fixture.payload) as { mf_sips: { active_sips: Record<string, unknown>[] }[] };
    p.mf_sips[0]!.active_sips[0]!['is_step_up_sip'] = false;
    expect(parseMfSips(envelope(p))[0]!.stepUpRaw).toBeNull();
  });

  it('an empty list is a real answer, not an error', () => {
    expect(parseMfSips(envelope({ mf_sips: [] }))).toEqual([]);
  });

  it.each([
    ['a throttle body', fixture._rateLimitedResponse],
    ['a missing list', { something: 'else' }],
  ])('refuses %s rather than reading it as no SIPs', (_label, payload) => {
    expect(() => parseMfSips(envelope(payload))).toThrow(/mf_sips/);
  });

  it('refuses an unparseable envelope', () => {
    expect(() => parseMfSips({ nope: 1 })).toThrow(/mf_sips/);
  });

  it('refuses a non-integer or non-positive rupee amount', () => {
    const p = structuredClone(fixture.payload) as { mf_sips: { active_sips: Record<string, unknown>[] }[] };
    p.mf_sips[0]!.active_sips[0]!['amount'] = 0;
    expect(() => parseMfSips(envelope(p))).toThrow(/amount/);
  });
});

describe('RemoteIndmoneySource.fetchSips', () => {
  it('calls mf_sips once and stamps as_of', async () => {
    const called: string[] = [];
    const client = { callTool: async (name: string) => { called.push(name); return envelope(fixture.payload); } } as unknown as McpClient;
    const { rows, asOf } = await new RemoteIndmoneySource({ client, spacingMs: 0 }).fetchSips();
    expect(called).toEqual(['mf_sips']);
    expect(rows).toHaveLength(3);
    expect(Number.isNaN(Date.parse(asOf))).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and verify they fail.**
Run: `pnpm vitest run tests/sources/indmoney-sips.test.ts`
Expected: FAIL, `parseMfSips is not exported`.

- [ ] **Step 3: Implement.** In `src/sources/indmoney.ts`, export near the other parsers:

```ts
export interface SipRow {
  sipId: string; instrumentId: string; isin: string | null; fundName: string;
  fundType: string | null; category: string | null; frequency: string;
  amountPaise: bigint; stepUpRaw: number | null; stepUpFreq: string | null;
  /** YYYY-MM-DD. INDmoney sends DD-MM-YYYY. */
  startDate: string;
}

/**
 * The owner's ACTIVE mutual fund SIPs (spec 2026-10-14 §1.2). Stopped and paused SIPs
 * are absent by design. An error body or a missing list throws: reading either as "no
 * SIPs" would hand the sizer the whole budget.
 */
export function parseMfSips(envelope: unknown): SipRow[] {
  const raw = (envelope as { result?: unknown } | null)?.result;
  if (typeof raw !== 'string') throw new Error('could not parse INDmoney mf_sips envelope — recapture the fixture before trusting this sync');
  const payload = JSON.parse(raw) as { mf_sips?: unknown; error?: string; message?: string };
  if (payload.error) throw new Error(`INDmoney refused mf_sips: ${payload.error} — ${payload.message ?? '(no message)'}`);
  if (!Array.isArray(payload.mf_sips)) throw new Error('INDmoney mf_sips payload has no mf_sips list — the tool contract changed');

  const rows: SipRow[] = [];
  for (const fund of payload.mf_sips as Record<string, unknown>[]) {
    for (const s of (Array.isArray(fund['active_sips']) ? fund['active_sips'] : []) as Record<string, unknown>[]) {
      const amount = s['amount'];
      if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
        throw new Error(`mf_sips: SIP ${String(s['sip_id'])} has amount ${String(amount)}, not a positive whole rupee figure`);
      }
      const [dd, mm, yyyy] = String(s['sip_start_date'] ?? '').split('-');
      if (!dd || !mm || !yyyy) throw new Error(`mf_sips: SIP ${String(s['sip_id'])} has start date ${String(s['sip_start_date'])}`);
      const str = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
      rows.push({
        sipId: String(s['sip_id']),
        instrumentId: `IND:${String(s['fund_id'])}`,
        isin: str(fund['isin']),
        fundName: String(fund['name']),
        fundType: str(fund['fundType']),
        category: str(fund['category']),
        frequency: String(s['sip_frequency'] ?? 'MONTHLY'),
        amountPaise: rupees(amount),
        stepUpRaw: s['is_step_up_sip'] === true && typeof s['step_up_by'] === 'number' ? s['step_up_by'] : null,
        stepUpFreq: s['is_step_up_sip'] === true ? str(s['step_up_freq']) : null,
        startDate: `${yyyy}-${mm}-${dd}`,
      });
    }
  }
  return rows;
}
```

Check that `rupees` is already imported in this file. If not, add `import { rupees } from '../money/paise.js';`. `rupees(n)` returns `bigint` paise for an integer rupee count.

Then add this method to `RemoteIndmoneySource`:

```ts
  async fetchSips(): Promise<{ rows: SipRow[]; asOf: string }> {
    const envelope = await this.opts.client.callTool<{ result?: string }>('mf_sips', {});
    return { rows: parseMfSips(envelope), asOf: new Date().toISOString() };
  }
```

- [ ] **Step 4: Run the tests and verify they pass.**
Run: `pnpm vitest run tests/sources/indmoney-sips.test.ts tests/sources/indmoney-remote.test.ts`
Expected: PASS.

- [ ] **Step 5: Fix-on-touch, deferred minor #9 — write the failing test.** `RemoteIndmoneySource` paces holdings calls with a fixed 9 s and treats a throttle as fatal. It should wait out `retry_after_seconds` and retry once. Add to `tests/sources/indmoney-remote.test.ts`:

```ts
it('waits out a throttle once using retry_after_seconds, then succeeds', async () => {
  const waits: number[] = [];
  let calls = 0;
  const client = {
    callTool: async (_n: string, args: { asset_type: string }) => {
      calls += 1;
      return calls === 1 ? envelope(fixture._rateLimitedResponse) : envelope(capture(args.asset_type));
    },
  } as unknown as McpClient;
  const s = new RemoteIndmoneySource({ client, spacingMs: 0, assetTypes: ['MF'], sleep: async (ms) => { waits.push(ms); } });
  await s.fetch();
  expect(waits).toEqual([((fixture._rateLimitedResponse['retry_after_seconds'] as number) + 1) * 1000]);
});

it('a second consecutive throttle is still fatal', async () => {
  const client = { callTool: async () => envelope(fixture._rateLimitedResponse) } as unknown as McpClient;
  const s = new RemoteIndmoneySource({ client, spacingMs: 0, assetTypes: ['MF'], sleep: async () => {} });
  await expect(s.fetch()).rejects.toThrow(/refused networth_holdings/);
});
```

Use whatever asset-type key the fixture actually has instead of `'MF'`; `capture()` throws if it is missing.

- [ ] **Step 6: Run it and verify it fails.**
Run: `pnpm vitest run tests/sources/indmoney-remote.test.ts`
Expected: FAIL. `sleep` is not an option, and the first throttle throws.

- [ ] **Step 7: Implement.** Add `sleep?: (ms: number) => Promise<void>;` to the constructor options, defaulting to `(ms) => new Promise((r) => setTimeout(r, ms))`. In `fetchOne`, keep the existing parse logic, but wrap the call so that when `payload.error === 'rate_limit_exceeded'` and `typeof payload.retry_after_seconds === 'number'` on the **first** attempt, it calls `await sleep((retry_after_seconds + 1) * 1000)` and calls the tool again. On the second attempt, fall through to the existing fatal `throw`. Use the same wrapper in `fetchSips`, so `mf_sips` gets the same retry. Add a comment naming the change: "deferred minor #9, fixed on touch 2026-10-15".

- [ ] **Step 8: Run all source tests and verify they pass.**
Run: `pnpm vitest run tests/sources`
Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add src/sources/indmoney.ts tests/sources/indmoney-sips.test.ts tests/sources/indmoney-remote.test.ts tests/fixtures/indmoney-mf-sips-2026-10-14.json
git commit -m "feat(indmoney): fetch live MF SIPs; retry one throttle using retry_after_seconds"
```

---

### Task 3: Domain — step-up inference and projection (pure)

**Files:**
- Create: `src/domain/sips.ts`
- Create: `tests/domain/sips.test.ts`

**Interfaces:**
- Consumes: `SipRow` (Task 2).
- Produces:

```ts
export type StepUpKind = 'percent' | 'rupees' | 'unknown';
export function inferStepUp(raw: number | null): { kind: StepUpKind | null; inferred: boolean };
export interface ActiveSip {
  sipId: string; instrumentId: string; fundName: string; fundType: string | null; category: string | null;
  amountPaise: bigint; stepUpRaw: number | null; stepUpKind: StepUpKind | null; stepUpInferred: boolean;
  stepUpFreq: string | null; startDate: string; asOf: string;
}
/** The next step-up on or after `asOf`, and the amount it steps to. Null fields when unknowable. */
export function nextStepUp(s: ActiveSip, asOf: string): { on: string | null; amountPaise: bigint | null };
```

- [ ] **Step 1: Write the failing tests.** `tests/domain/sips.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { inferStepUp, nextStepUp, type ActiveSip } from '../../src/domain/sips.js';

const sip = (over: Partial<ActiveSip> = {}): ActiveSip => ({
  sipId: '1', instrumentId: 'IND:5536', fundName: 'Nifty', fundType: 'Equity', category: 'Index Funds',
  amountPaise: 1_400_100n, stepUpRaw: 10, stepUpKind: 'percent', stepUpInferred: true,
  stepUpFreq: 'YEARLY', startDate: '2026-11-12', asOf: '2026-10-14T00:00:00Z', ...over,
});

describe('inferStepUp', () => {
  it.each([
    [null, { kind: null, inferred: false }],
    [0, { kind: 'unknown', inferred: false }],
    [10, { kind: 'percent', inferred: true }],
    [100, { kind: 'percent', inferred: true }],
    [101, { kind: 'rupees', inferred: true }],
    [1000, { kind: 'rupees', inferred: true }],
    [-5, { kind: 'unknown', inferred: false }],
  ])('%s -> %o', (raw, expected) => {
    expect(inferStepUp(raw as number | null)).toEqual(expected);
  });
});

describe('nextStepUp', () => {
  it('a SIP that has not started yet first steps up one year after its start', () => {
    expect(nextStepUp(sip(), '2026-10-14').on).toBe('2027-11-12');
  });

  it('percent: the amount rises by that share, rounded down to the rupee', () => {
    const s = sip();
    const expected = ((s.amountPaise * 110n) / 100n / 100n) * 100n;
    expect(nextStepUp(s, '2026-10-14').amountPaise).toBe(expected); // ₹15,401
  });

  it('rupees: the amount rises by that many rupees', () => {
    const s = sip({ stepUpRaw: 1000, stepUpKind: 'rupees', startDate: '2023-08-12' });
    expect(nextStepUp(s, '2026-10-14')).toEqual({ on: '2027-08-12', amountPaise: s.amountPaise + 100_000n });
  });

  it('on the anniversary itself, the next step-up is that day', () => {
    expect(nextStepUp(sip({ startDate: '2025-10-14' }), '2026-10-14').on).toBe('2026-10-14');
  });

  it('an unknown kind is unknowable, never guessed', () => {
    expect(nextStepUp(sip({ stepUpKind: 'unknown' }), '2026-10-14')).toEqual({ on: '2027-11-12', amountPaise: null });
  });

  it('no step-up: nothing to project', () => {
    expect(nextStepUp(sip({ stepUpRaw: null, stepUpKind: null, stepUpFreq: null }), '2026-10-14'))
      .toEqual({ on: null, amountPaise: null });
  });

  it('a frequency other than YEARLY is not projected', () => {
    expect(nextStepUp(sip({ stepUpFreq: 'HALF_YEARLY' }), '2026-10-14')).toEqual({ on: null, amountPaise: null });
  });
});
```

- [ ] **Step 2: Run them and verify they fail.**
Run: `pnpm vitest run tests/domain/sips.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** `src/domain/sips.ts` (pure part):

```ts
import type { Db } from '../db/client.js';

/**
 * Live SIP commitment (spec 2026-10-14 §1.4–1.6). Reads only `sip_snapshots`, `sips` and
 * `settings_rails`. Must never import buckets.ts or funded-status.ts: the free envelope
 * feeds sizing, and sizing is behind the no-catch-up firewall.
 */

export type StepUpKind = 'percent' | 'rupees' | 'unknown';

/**
 * INDmoney's `step_up_by` carries no unit: 1000 meant ₹1,000 and 10 means 10%.
 * ponytail: ≤100 is read as percent, so a genuine ₹100-or-less rupee step-up is misread.
 * Use the unit if INDmoney ever exposes one. Overview shows the guess as "inferred".
 */
export function inferStepUp(raw: number | null): { kind: StepUpKind | null; inferred: boolean } {
  if (raw === null) return { kind: null, inferred: false };
  if (!Number.isFinite(raw) || raw <= 0) return { kind: 'unknown', inferred: false };
  return { kind: raw <= 100 ? 'percent' : 'rupees', inferred: true };
}

export interface ActiveSip {
  sipId: string; instrumentId: string; fundName: string; fundType: string | null; category: string | null;
  amountPaise: bigint; stepUpRaw: number | null; stepUpKind: StepUpKind | null; stepUpInferred: boolean;
  stepUpFreq: string | null; startDate: string; asOf: string;
}

/** First anniversary of `startDate` (whole years after it, at least one) on or after `asOf`. */
function nextAnniversary(startDate: string, asOf: string): string {
  const [y, m, d] = startDate.split('-').map(Number) as [number, number, number];
  for (let year = Math.max(y + 1, Number(asOf.slice(0, 4))); ; year++) {
    const on = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (on >= asOf.slice(0, 10)) return on;
  }
}

export function nextStepUp(s: ActiveSip, asOf: string): { on: string | null; amountPaise: bigint | null } {
  if (s.stepUpKind === null || s.stepUpFreq !== 'YEARLY') return { on: null, amountPaise: null };
  const on = nextAnniversary(s.startDate, asOf);
  if (s.stepUpKind === 'unknown' || s.stepUpRaw === null) return { on, amountPaise: null };
  if (s.stepUpKind === 'rupees') return { on, amountPaise: s.amountPaise + BigInt(Math.round(s.stepUpRaw)) * 100n };
  const bps = BigInt(Math.round(s.stepUpRaw * 100));
  return { on, amountPaise: ((s.amountPaise * (10_000n + bps)) / 10_000n / 100n) * 100n };
}
```

The `for (;;)` loop always terminates: the year rises until `on >= asOf`.

- [ ] **Step 4: Run the tests and verify they pass.**
Run: `pnpm vitest run tests/domain/sips.test.ts`
Expected: PASS. Then **mutation-check**: change `raw <= 100` to `raw < 100`, confirm the `100` row goes red, and revert.

- [ ] **Step 5: Commit.**

```bash
git add src/domain/sips.ts tests/domain/sips.test.ts
git commit -m "feat(sips): step-up inference and next step-up projection"
```

---

### Task 4: Domain — persist and load the commitment; sync step; staleness

**Files:**
- Modify: `src/domain/sips.ts`
- Modify: `src/jobs/sync.ts`
- Modify: `src/sources/staleness.ts`
- Create: `tests/jobs/sync-sips.test.ts`
- Modify: `tests/domain/sips.test.ts`

**Interfaces:**
- Consumes: `SipRow`, `parseMfSips` (Task 2); `inferStepUp`, `ActiveSip` (Task 3).
- Produces:

```ts
export const SIP_MAX_AGE_DAYS = 7;
export async function persistSipSnapshot(db: Db, rows: SipRow[], asOf: string): Promise<number>; // snapshot id
export interface SipCommitment { totalPaise: bigint | null; asOf: string | null; stale: boolean; sips: ActiveSip[] }
export async function loadSipCommitment(db: Db, nowIso: string): Promise<SipCommitment>;
// runSync opts gain: fetchSips?: () => Promise<{ rows: SipRow[]; asOf: string }>
```

- [ ] **Step 1: Write the failing domain tests.** Append to `tests/domain/sips.test.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { beforeEach } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { parseMfSips } from '../../src/sources/indmoney.js';
import { loadSipCommitment, persistSipSnapshot } from '../../src/domain/sips.js';

const live = parseMfSips({ result: JSON.stringify(JSON.parse(await readFile('tests/fixtures/indmoney-mf-sips-2026-10-14.json', 'utf8')).payload) });

describe('loadSipCommitment', () => {
  let db: Db;
  beforeEach(async () => { db = await openDb(); await runMigrations(db); });

  it('no snapshot ever: unknown, not zero', async () => {
    expect(await loadSipCommitment(db, '2026-10-14T10:00:00Z')).toEqual({ totalPaise: null, asOf: null, stale: true, sips: [] });
  });

  it('the latest snapshot is the active set, totalled exactly', async () => {
    await persistSipSnapshot(db, live.slice(0, 1), '2026-10-01T00:00:00Z');
    await persistSipSnapshot(db, live, '2026-10-14T00:00:00Z');
    const c = await loadSipCommitment(db, '2026-10-14T10:00:00Z');
    expect(c.totalPaise).toBe(live.reduce((s, r) => s + r.amountPaise, 0n));
    expect(c.sips.map((s) => s.sipId).sort()).toEqual(live.map((r) => r.sipId).sort());
    expect(c.sips[0]).toMatchObject({ stepUpKind: 'percent', stepUpInferred: true });
    expect(c.stale).toBe(false);
  });

  it('an empty snapshot is a stated zero', async () => {
    await persistSipSnapshot(db, [], '2026-10-14T00:00:00Z');
    expect((await loadSipCommitment(db, '2026-10-14T10:00:00Z')).totalPaise).toBe(0n);
  });

  it('older than 7 days: the total is unknown and flagged stale, the rows are still shown', async () => {
    await persistSipSnapshot(db, live, '2026-10-01T00:00:00Z');
    const c = await loadSipCommitment(db, '2026-10-08T00:00:01Z');
    expect(c).toMatchObject({ totalPaise: null, stale: true });
    expect(c.sips).toHaveLength(live.length);
  });

  it('writes the snapshot and its rows atomically', async () => {
    const bad = [...live, { ...live[0]!, amountPaise: 0n }]; // violates amount_paise > 0
    await expect(persistSipSnapshot(db, bad, '2026-10-14T00:00:00Z')).rejects.toThrow();
    expect(await db.query('select 1 from sip_snapshots')).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run them and verify they fail.**
Run: `pnpm vitest run tests/domain/sips.test.ts`
Expected: FAIL, `persistSipSnapshot` not exported.

- [ ] **Step 3: Implement** in `src/domain/sips.ts`:

```ts
import type { SipRow } from '../sources/indmoney.js';

export const SIP_MAX_AGE_DAYS = 7;
const iso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export async function persistSipSnapshot(db: Db, rows: SipRow[], asOf: string): Promise<number> {
  return db.withTransaction(async (tx) => {
    const [snap] = await tx.query<{ id: string | number }>(
      `insert into sip_snapshots (as_of, source, sip_count) values ($1, 'indmoney', $2) returning id`,
      [asOf, rows.length],
    );
    for (const r of rows) {
      const step = inferStepUp(r.stepUpRaw);
      await tx.query(
        `insert into sips (snapshot_id, sip_id, instrument_id, isin, fund_name, fund_type, category, frequency,
                           amount_paise, step_up_raw, step_up_kind, step_up_inferred, step_up_freq, start_date, as_of, source)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'indmoney')`,
        [snap!.id, r.sipId, r.instrumentId, r.isin, r.fundName, r.fundType, r.category, r.frequency,
          r.amountPaise.toString(), r.stepUpRaw, step.kind, step.inferred, r.stepUpFreq, r.startDate, asOf],
      );
    }
    return Number(snap!.id);
  });
}

export interface SipCommitment { totalPaise: bigint | null; asOf: string | null; stale: boolean; sips: ActiveSip[] }

export async function loadSipCommitment(db: Db, nowIso: string): Promise<SipCommitment> {
  const [snap] = await db.query<{ id: string | number; as_of: string | Date }>(
    `select id, as_of from sip_snapshots order by as_of desc, id desc limit 1`);
  if (!snap) return { totalPaise: null, asOf: null, stale: true, sips: [] };
  const rows = await db.query<{
    sip_id: string; instrument_id: string; fund_name: string; fund_type: string | null; category: string | null;
    amount_paise: string | number; step_up_raw: string | number | null; step_up_kind: StepUpKind | null;
    step_up_inferred: boolean; step_up_freq: string | null; start_date: string | Date;
  }>(`select * from sips where snapshot_id = $1 order by amount_paise desc, sip_id`, [snap.id]);
  const asOf = iso(snap.as_of);
  const stale = Date.parse(nowIso) - Date.parse(asOf) > SIP_MAX_AGE_DAYS * 86_400_000;
  const sips: ActiveSip[] = rows.map((r) => ({
    sipId: r.sip_id, instrumentId: r.instrument_id, fundName: r.fund_name, fundType: r.fund_type, category: r.category,
    amountPaise: BigInt(r.amount_paise), stepUpRaw: r.step_up_raw === null ? null : Number(r.step_up_raw),
    stepUpKind: r.step_up_kind, stepUpInferred: r.step_up_inferred, stepUpFreq: r.step_up_freq,
    startDate: iso(r.start_date).slice(0, 10), asOf,
  }));
  return { totalPaise: stale ? null : sips.reduce((s, x) => s + x.amountPaise, 0n), asOf, stale, sips };
}
```

**Date gotcha:** PGlite returns a `date` column as a JS `Date` at local midnight. Converting it with `toISOString().slice(0, 10)` can shift the day in a UTC+ timezone. Before trusting `iso(r.start_date)`, check how `networth.ts` and `buckets.ts` handle `date` columns. `buckets.ts` uses `instanceof Date ? toISOString().slice(0,10) : String(v).slice(0,10)`, and the test suite runs that path. If `start_date` comes back off by one day, select `start_date::text` instead.

- [ ] **Step 4: Run the tests and verify they pass.**
Run: `pnpm vitest run tests/domain/sips.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing sync test.** `tests/jobs/sync-sips.test.ts`, following `tests/jobs/sync.test.ts` setup (seed + `FileIndmoneySource`):

```ts
import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { runSync } from '../../src/jobs/sync.js';
import { FileIndmoneySource, parseMfSips } from '../../src/sources/indmoney.js';
import { assessStaleness } from '../../src/sources/staleness.js';

const live = parseMfSips({ result: JSON.stringify(JSON.parse(await readFile('tests/fixtures/indmoney-mf-sips-2026-10-14.json', 'utf8')).payload) });
const NOW = '2026-10-14T17:30:00+05:30';
let db: Db;
beforeEach(async () => { db = await openDb(); await runMigrations(db); await seed(db, { asOf: '2026-10-14' }); });
const sources = () => [new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json')];

describe('indmoney-sips sync step', () => {
  it('writes one snapshot of the live SIPs', async () => {
    const r = await runSync(db, { now: NOW, sources: sources(), fetchSips: async () => ({ rows: live, asOf: NOW }) });
    expect(r.synced).toContain('indmoney-sips');
    expect(await db.query('select 1 from sips')).toHaveLength(live.length);
  });

  it('a failed fetch writes nothing and opens a WARN, then a BLOCK', async () => {
    const fetchSips = async () => { throw new Error('INDmoney refused mf_sips: rate_limit_exceeded'); };
    await runSync(db, { now: NOW, sources: sources(), fetchSips });
    await runSync(db, { now: NOW, sources: sources(), fetchSips });
    expect(await db.query('select 1 from sip_snapshots')).toHaveLength(0);
    const inc = await db.query<{ severity: string }>(
      `select severity from incidents where kind = 'SYNC_FAILURE' and subject = 'indmoney-sips' order by id`);
    expect(inc.map((i) => i.severity)).toEqual(['WARN', 'BLOCK']);
  });

  it('no fetcher is an explicit skip, never a success', async () => {
    const r = await runSync(db, { now: NOW, sources: sources() });
    expect(r.synced).not.toContain('indmoney-sips');
    expect(r.failed.map((f) => f.source)).not.toContain('indmoney-sips');
  });

  it('staleness assesses indmoney-sips against a 7-day limit', async () => {
    const row = (await assessStaleness(db, NOW)).find((s) => s.source === 'indmoney-sips');
    expect(row).toMatchObject({ limitHours: 168, stale: true }); // never synced
  });
});
```

If `seed` refuses the `asOf`, use the one `sync.test.ts` uses.

- [ ] **Step 6: Run it and verify it fails.**
Run: `pnpm vitest run tests/jobs/sync-sips.test.ts`
Expected: FAIL, because `fetchSips` is not an accepted option.

- [ ] **Step 7: Implement the sync step.** In `src/jobs/sync.ts`:
  - Add `fetchSips?: () => Promise<{ rows: SipRow[]; asOf: string }>;` to the `runSync` opts type (import `type SipRow` from `../sources/indmoney.js`, and `persistSipSnapshot` from `../domain/sips.js`).
  - Insert after the `for (const source of opts.sources)` loop:

```ts
  // Live SIPs (spec 2026-10-14 §1.5). After the portfolio, before anything sizes.
  if (opts.fetchSips) {
    await step('indmoney-sips', async () => {
      const { rows, asOf } = await opts.fetchSips!();
      await persistSipSnapshot(db, rows, asOf);
    });
  } else {
    console.error('indmoney-sips skipped: no live INDmoney client (file source has no SIPs)');
  }
```

  - Add `'mf_sips'` to the `allowedTools` list in `indmoneySource()`. Keep the comment's warning.
  - In the `isMainModule` block, after `const sources = …`, build the fetcher from the remote source if there is one:

```ts
  const remote = sources.find((s): s is RemoteIndmoneySource => s instanceof RemoteIndmoneySource);
  const result = await runSync(db, {
    …existing options…,
    ...(remote ? { fetchSips: () => remote.fetchSips() } : {}),
  });
```

- [ ] **Step 8: Implement staleness.** In `src/sources/staleness.ts`:
  - Add `'indmoney-sips': 168` to `LIMIT_BY_SOURCE`.
  - Add a reader:

```ts
async function getLatestSipsAsOf(db: Db): Promise<string | undefined> {
  const [r] = await db.query<{ as_of: string | Date | null }>(`select max(as_of) as as_of from sip_snapshots`);
  if (!r || r.as_of === null) return undefined;
  return r.as_of instanceof Date ? r.as_of.toISOString() : r.as_of;
}
```

  - In `assessStaleness`, add `results.push(assess('indmoney-sips', await getLatestSipsAsOf(db), 168));`.
  - `blockedInstruments` keys on position sources, so this row blocks no holding. That is correct: stale SIPs pause sizing (Task 5), not instruments.

- [ ] **Step 9: Run the jobs and sources tests and verify they pass.**
Run: `pnpm vitest run tests/jobs tests/sources tests/domain/sips.test.ts`
Expected: PASS. If a staleness test asserts the exact list of sources, add `indmoney-sips` **only** where it derives the list from `assessStaleness` output. If the list is a hard-coded literal, extend it and note that in the commit.

- [ ] **Step 10: Commit.**

```bash
git add src/domain/sips.ts src/jobs/sync.ts src/sources/staleness.ts tests/domain/sips.test.ts tests/jobs/sync-sips.test.ts
git commit -m "feat(sync): daily indmoney-sips step, commitment loader, 7-day staleness"
```

---

### Task 5: Budget rail and the free envelope; sizing uses it

**Files:**
- Modify: `src/domain/rails.ts` (`DEFAULT_OWNER_RAILS`)
- Modify: `src/domain/sips.ts`
- Modify: `src/domain/sizing.ts`, `src/domain/sizing-input.ts`
- Modify: `tests/domain/sips.test.ts`, `tests/domain/sizing.test.ts`

**Interfaces:**
- Consumes: `loadSipCommitment` (Task 4), `railPaise(db, key): Promise<bigint>` (`src/domain/rails.ts:170`).
- Produces:

```ts
export interface FreeEnvelope {
  envelopePaise: bigint | null; budgetPaise: bigint; tacticalPaise: bigint;
  sipTotalPaise: bigint | null; sipAsOf: string | null;
  /** Set whenever envelopePaise is null or 0: why nothing can be deployed. */
  reason: string | null;
}
export async function loadFreeEnvelope(db: Db, nowIso: string): Promise<FreeEnvelope>;
// SizingInput gains: envelopeReason: string | null   (tacticalBudgetPaise now carries the envelope, 0n when null)
```

- [ ] **Step 1: Write the failing envelope tests.** Append to `tests/domain/sips.test.ts`:

```ts
import { loadFreeEnvelope } from '../../src/domain/sips.js';

describe('loadFreeEnvelope', () => {
  let db: Db;
  beforeEach(async () => { db = await openDb(); await runMigrations(db); });
  const NOW = '2026-10-14T10:00:00Z';
  const setRail = (k: string, v: number) =>
    db.query(`insert into settings_rails (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`, [k, JSON.stringify(v)]);

  it('budget minus live SIPs, capped by the tactical rail', async () => {
    await persistSipSnapshot(db, live, NOW);
    const e = await loadFreeEnvelope(db, NOW);
    const sips = live.reduce((s, r) => s + r.amountPaise, 0n);
    const expected = [e.tacticalPaise, e.budgetPaise - sips].reduce((m, x) => (x < m ? x : m));
    expect(e).toMatchObject({ envelopePaise: expected, sipTotalPaise: sips, reason: null });
  });

  it('the tactical rail still caps a large budget', async () => {
    await persistSipSnapshot(db, [], NOW);
    await setRail('monthly_budget_paise', 50_000_000);
    const e = await loadFreeEnvelope(db, NOW);
    expect(e.envelopePaise).toBe(e.tacticalPaise);
  });

  it('SIPs at or over the budget: zero, with a reason, never negative', async () => {
    await persistSipSnapshot(db, live, NOW);
    await setRail('monthly_budget_paise', 1_000_000); // ₹10,000 < the SIPs
    expect(await loadFreeEnvelope(db, NOW)).toMatchObject({ envelopePaise: 0n, reason: expect.stringMatching(/SIPs already use the whole budget/) });
  });

  it('no SIP snapshot: unknown, with a reason naming the sync', async () => {
    expect(await loadFreeEnvelope(db, NOW)).toMatchObject({ envelopePaise: null, reason: expect.stringMatching(/never synced/) });
  });

  it('stale SIPs: unknown, with a reason naming the last sync date', async () => {
    await persistSipSnapshot(db, live, '2026-09-30T00:00:00Z');
    expect(await loadFreeEnvelope(db, NOW)).toMatchObject({ envelopePaise: null, reason: expect.stringMatching(/2026-09-30/) });
  });
});
```

- [ ] **Step 2: Run them and verify they fail.**
Run: `pnpm vitest run tests/domain/sips.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**
  - In `src/domain/rails.ts` `DEFAULT_OWNER_RAILS`, add `monthly_budget_paise: 50_00_000,` with the comment `// owner deployment budget incl. SIPs (2026-10-13); raised yearly via /cleanup`. This also makes it a known key for `isLoosening`, where higher means looser, which is correct.
  - In `src/domain/sips.ts` (import `railPaise` from `./rails.js`; `rails.ts` does not reach `buckets.ts`, so check with the architecture test in Step 8):

```ts
export interface FreeEnvelope {
  envelopePaise: bigint | null; budgetPaise: bigint; tacticalPaise: bigint;
  sipTotalPaise: bigint | null; sipAsOf: string | null; reason: string | null;
}

export async function loadFreeEnvelope(db: Db, nowIso: string): Promise<FreeEnvelope> {
  const budgetPaise = await railPaise(db, 'monthly_budget_paise');
  const tacticalPaise = await railPaise(db, 'tactical_monthly_paise');
  const c = await loadSipCommitment(db, nowIso);
  const base = { budgetPaise, tacticalPaise, sipTotalPaise: c.totalPaise, sipAsOf: c.asOf };
  if (c.totalPaise === null) {
    return { ...base, envelopePaise: null, reason: c.asOf === null
      ? 'SIP commitment unknown: INDmoney SIPs have never synced (indmoney-sips)'
      : `SIP commitment unknown: last SIP sync ${c.asOf.slice(0, 10)} is older than ${SIP_MAX_AGE_DAYS} days` };
  }
  const free = budgetPaise - c.totalPaise;
  if (free <= 0n) return { ...base, envelopePaise: 0n, reason: 'SIPs already use the whole budget' };
  return { ...base, envelopePaise: free < tacticalPaise ? free : tacticalPaise, reason: null };
}
```

- [ ] **Step 4: Run the tests and verify they pass.**
Run: `pnpm vitest run tests/domain/sips.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing sizing tests.** In `tests/domain/sizing.test.ts`, add `envelopeReason: null,` to `base()`, then add:

```ts
describe('the free envelope', () => {
  it('an unknown envelope withholds every BUY with its reason', () => {
    const reason = 'SIP commitment unknown: last SIP sync 2026-09-30 is older than 7 days';
    const out = sizeCandidates(base({ tacticalBudgetPaise: 0n, envelopeReason: reason }));
    expect(out.every((c) => c.status === 'WITHHELD' && c.withheldReason === reason)).toBe(true);
  });

  it('a zero envelope with a reason withholds with that reason, not the generic one', () => {
    const out = sizeCandidates(base({ tacticalBudgetPaise: 0n, envelopeReason: 'SIPs already use the whole budget' }));
    expect(out[0]!.withheldReason).toBe('SIPs already use the whole budget');
  });

  it('sells are unaffected by the envelope', () => {
    const out = sizeCandidates(base({
      tacticalBudgetPaise: 0n, envelopeReason: 'SIPs already use the whole budget', buys: [],
      holdings: [{ instrumentId: 'NSE:B', valuePaise: 800_000n, units: '10', kind: 'EQUITY', costKnown: true }],
      sells: [{ instrumentId: 'NSE:B', name: 'B', kind: 'EQUITY', action: 'SELL', amountPaise: null, blockedByMinimumHold: false, reason: 'falsified' }],
    }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ action: 'SELL', status: 'ELIGIBLE', units: '10' });
  });
});
```

- [ ] **Step 6: Run them and verify they fail.**
Run: `pnpm vitest run tests/domain/sizing.test.ts`
Expected: FAIL, `envelopeReason` is not a field, and BUYs are withheld with the generic text.

- [ ] **Step 7: Implement.**
  - `src/domain/sizing.ts`: add to `SizingInput`:

```ts
  /** Why the monthly budget is 0/unknown (live SIPs). Withheld BUYs quote it verbatim. */
  envelopeReason: string | null;
```

    In the BUY loop, before the `budget <= 0n` check, add:

```ts
    if (input.envelopeReason !== null && budget <= 0n) { withhold(input.envelopeReason); continue; }
```

    The existing "already used by a higher-ranked candidate" message stays for the case where an earlier BUY used the envelope. Update the file's header comment: "the monthly tactical budget" becomes "the free envelope: budget − live SIPs, capped by the tactical rail".
  - `src/domain/sizing-input.ts`: replace `tacticalBudgetPaise: await railPaise(db, 'tactical_monthly_paise'),` with:

```ts
    ...(await (async () => {
      const e = await loadFreeEnvelope(db, `${asOf}T23:59:59Z`);
      return { tacticalBudgetPaise: e.envelopePaise ?? 0n, envelopeReason: e.reason };
    })()),
```

    Or use a plain `const e = await loadFreeEnvelope(...)` above the `return` (preferred: matches the file's style). Pass `new Date().toISOString()` instead of the end-of-day `asOf` if `asOf` is always today in practice. Check the caller in `src/jobs/report.ts:99`.

- [ ] **Step 8: Run the tests and the architecture test, and verify they pass.**
Run: `pnpm vitest run tests/domain/sizing.test.ts tests/domain/sips.test.ts tests/architecture tests/domain/advisor-handoff.test.ts`
Expected: PASS. **Mutation-check:** in `loadFreeEnvelope`, return `envelopePaise: budgetPaise`. "budget minus live SIPs" must go red. Revert.

- [ ] **Step 9: Commit.**

```bash
git add src/domain/rails.ts src/domain/sips.ts src/domain/sizing.ts src/domain/sizing-input.ts tests/domain/sips.test.ts tests/domain/sizing.test.ts
git commit -m "feat(sizing): deploy budget minus live SIPs, never the flat tactical rail"
```

---

### Task 6: Order rails against the envelope (and remove the bogus whole-book check)

**Files:**
- Modify: `src/domain/rails.ts` (`checkRails` ~line 100, `checkPortfolioRails` ~line 426)
- Modify: `tests/domain/rails-gate.test.ts`, `tests/domain/owner-rails.test.ts`, `tests/domain/freeze-breaker-tactical.test.ts`

**Interfaces:**
- Consumes: `loadFreeEnvelope` (Task 5).
- Produces: `TACTICAL_BUDGET_EXCEEDED.detail` names the budget, SIPs and envelope. When the envelope is null, a BUY is refused with code `TACTICAL_BUDGET_EXCEEDED` and the envelope's reason.

**Found while planning (pre-existing bug, fixed on touch):** `checkPortfolioRails` sums the value of **every** EQUITY/ETF/MF holding, adds this month's spend, and compares the total with a hard-coded `50_00_000n`. Every equity book over ₹50k is therefore "in breach" on Overview, `/rails` and the digest. A portfolio-level tactical check is "this month's BUY spend vs the envelope". Holdings' value has nothing to do with it.

- [ ] **Step 1: Read the existing tests.** Read `tests/domain/rails-gate.test.ts`, `tests/domain/owner-rails.test.ts` and `tests/domain/freeze-breaker-tactical.test.ts` for how they set up `checkRails` and expect `TACTICAL_BUDGET_EXCEEDED`. Each test that relied on a ₹50k cap must now seed SIP state, so the envelope is what it was meant to be. Seed a `sip_snapshots` row with zero SIPs (`persistSipSnapshot(db, [], now)`): the envelope then equals `min(tactical, budget)` = ₹50,000 and the old intent holds without editing any expected amount.

- [ ] **Step 2: Write the failing tests.** In `tests/domain/rails-gate.test.ts`:

```ts
it('measures a BUY against budget minus live SIPs', async () => {
  // live SIPs from the fixture; budget ₹50,000 → envelope = 50,000 − SIPs
  await persistSipSnapshot(db, live, new Date().toISOString());
  const envelope = 50_00_000n - live.reduce((s, r) => s + r.amountPaise, 0n);
  const over = buyRec(envelope + 100n);   // use this file's existing BUY recommendation builder
  const violations = await checkRails(db, over);
  expect(violations.find((v) => v.code === 'TACTICAL_BUDGET_EXCEEDED')?.detail).toMatch(/SIPs/);
  expect((await checkRails(db, buyRec(envelope))).some((v) => v.code === 'TACTICAL_BUDGET_EXCEEDED')).toBe(false);
});

it('refuses a BUY when the SIP commitment is unknown', async () => {
  const v = await checkRails(db, buyRec(100_000n));
  expect(v.find((x) => x.code === 'TACTICAL_BUDGET_EXCEEDED')?.detail).toMatch(/never synced/);
});
```

`buyRec` is whatever helper that file already uses to build a BUY `Recommendation` with an amount. If there is none, build one inline the way the existing TACTICAL test does. Import `live` the same way as in Task 4.

In `tests/domain/owner-rails.test.ts`:

```ts
it('a large equity book is not a tactical breach', async () => {
  // Use this file's existing position fixture with > ₹50k of EQUITY/MF, and a zero-SIP snapshot.
  await persistSipSnapshot(db, [], new Date().toISOString());
  const v = await checkPortfolioRails(db, positionsWithLargeEquity, total);
  expect(v.some((x) => x.code === 'TACTICAL_BUDGET_EXCEEDED')).toBe(false);
});
```

- [ ] **Step 3: Run them and verify they fail.**
Run: `pnpm vitest run tests/domain/rails-gate.test.ts tests/domain/owner-rails.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement.** In `checkRails`, replace the tactical block with:

```ts
  // FR-12 caps DEPLOYMENT … (keep the existing comment)
  // Since 2026-10-15 the cap is the free envelope: budget − live SIPs, inside the tactical rail.
  const env = await loadFreeEnvelope(db, new Date().toISOString());
  const deploying = recommendation.primary.action === 'BUY' ? amountPaise : 0n;
  if (deploying > 0n) {
    const tacticalUsed = await getTacticalUsedThisMonth(db, new Date().toISOString());
    if (env.envelopePaise === null) {
      violations.push({ code: 'TACTICAL_BUDGET_EXCEEDED', detail: env.reason! });
    } else if (tacticalUsed + deploying > env.envelopePaise) {
      violations.push({
        code: 'TACTICAL_BUDGET_EXCEEDED',
        detail: `This month's deployment would exceed ${formatInr(paise(env.envelopePaise))} `
          + `(budget ${formatInr(paise(env.budgetPaise))} − SIPs ${formatInr(paise(env.sipTotalPaise ?? 0n))}; `
          + `used: ${formatInr(paise(tacticalUsed))})`,
      });
    }
  }
```

In `checkPortfolioRails`, replace the whole-book block with a spend-only check:

```ts
  // Tactical: this month's BUY spend against the free envelope. The previous version added
  // the value of every equity/MF holding to the spend and compared it with a hard-coded
  // ₹50k, so any real portfolio read as a permanent breach (found 2026-10-14).
  const env = await loadFreeEnvelope(db, new Date().toISOString());
  const tacticalUsed = await getTacticalUsedThisMonth(db, new Date().toISOString());
  if (env.envelopePaise !== null && tacticalUsed > env.envelopePaise) {
    violations.push({ code: 'TACTICAL_BUDGET_EXCEEDED', detail: `This month's deployment ${formatInr(paise(tacticalUsed))} exceeds ${formatInr(paise(env.envelopePaise))} (budget − SIPs)` });
  }
```

Import `loadFreeEnvelope` from `./sips.js`. **Cycle check:** `sips.ts` imports `railPaise` from `rails.ts`, and `rails.ts` now imports from `sips.ts`. ES modules allow this because both uses happen inside functions, not at module top level. If vitest reports `railPaise is not a function` at load time, move `railPaise` and `DEFAULT_OWNER_RAILS` into a new `src/domain/rail-values.ts`, re-export them from `rails.ts`, and have `sips.ts` import from `rail-values.ts`. Note it in the commit.

- [ ] **Step 5: Run every rails and order test and verify they pass.**
Run: `pnpm vitest run tests/domain`
Expected: PASS. A test that fails only because no SIP snapshot exists (envelope unknown → BUY refused) is a fixture gap, not a reason to change the rule. Add `persistSipSnapshot(db, [], now)` to its setup, as in Step 1.

- [ ] **Step 6: Commit.**

```bash
git add src/domain/rails.ts tests/domain
git commit -m "fix(rails): tactical cap is budget minus live SIPs; drop whole-book comparison"
```

---

### Task 7: Allocation engine and the monthly rebalance read live SIPs

**Files:**
- Modify: `src/domain/alloc-engine.ts` (OVER branch, ~line 259)
- Modify: `src/notify/report.ts` (~lines 283–306 and the rebalance loop)
- Modify: `tests/domain/alloc-engine.test.ts`, `tests/notify/report.test.ts`

**Interfaces:**
- Consumes: `loadSipCommitment`, `loadFreeEnvelope`; `classify(kind, instrumentId, name)` from `src/domain/networth.ts`; `FundingRoute { id, kind: 'sip' | 'fresh-surplus', assetClass, monthlyCapacityPaise, loadFree, note? }`.
- Produces: `buildReportInput` builds SIP routes. The rebalance tranche is `min(envelope, max_order)`. When the envelope is null or 0, ADD actions are suppressed into `suppressed_actions` with `suppressed_by = 'SIP_ENVELOPE'`.

- [ ] **Step 1: Write the failing engine test.** In `tests/domain/alloc-engine.test.ts`, reuse its existing over-ceiling fixture (an EQUITY overweight beyond `SELL_TOLERANCE` that resolves as `DIRECT_FLOW` because surplus routes close it within 12 months). Then:

```ts
it('SIPs into the overweight class eat into what new money can dilute', () => {
  const state = overweightEquityState();          // the existing fixture builder in this file
  const before = rebalanceRec(state, '2026-10');
  expect(before.actions.some((a) => a.kind === 'DIRECT_FLOW')).toBe(true);

  // An equity SIP at least as large as every other route's monthly capacity removes the
  // dilution entirely, so the drift is no longer closable by flows alone.
  const otherCapacity = (state.routes ?? []).filter((r) => r.assetClass !== 'EQUITY').reduce((s, r) => s + r.monthlyCapacityPaise, 0n);
  const withSip = { ...state, routes: [...(state.routes ?? []), {
    id: 'sip-equity', kind: 'sip' as const, assetClass: 'EQUITY' as const, monthlyCapacityPaise: otherCapacity as never, loadFree: true,
  }] };
  const after = rebalanceRec(withSip, '2026-10');
  expect(after.actions.some((a) => a.kind === 'TRIM')).toBe(true);
});
```

If the fixture is inside the 2-point `SELL_TOLERANCE`, it always gives `DIRECT_FLOW`. Pick or build one beyond it, and say so in the test's comment.

- [ ] **Step 2: Run it and verify it fails.**
Run: `pnpm vitest run tests/domain/alloc-engine.test.ts`
Expected: FAIL, because the equity SIP is ignored and the action is still `DIRECT_FLOW`.

- [ ] **Step 3: Implement.** In `rebalanceRec`'s OVER branch, replace `const capacity = sip + surplus;` with:

```ts
    // Money still flowing INTO the overweight class (its own SIPs) works against the
    // dilution: ₹30k/month of equity SIPs is ₹30k/month less that new money elsewhere
    // can offset (spec 2026-10-14 §1.7).
    const inflow = routes.filter((r) => r.kind === 'sip' && r.assetClass === row.assetClass)
      .reduce((s, r) => s + r.monthlyCapacityPaise, 0n);
    const capacity = sip + surplus > inflow ? sip + surplus - inflow : 0n;
```

When `inflow > 0n`, add one clause to the `DIRECT_FLOW` rationale: `` `; SIPs add ${formatInr(inflow as Paise)}/month to ${row.assetClass}` ``.

- [ ] **Step 4: Run the engine tests and verify they pass.**
Run: `pnpm vitest run tests/domain/alloc-engine.test.ts`
Expected: PASS. **Mutation-check:** set `inflow` to `0n`. The new test must go red. Revert.

- [ ] **Step 5: Write the failing report tests.** In `tests/notify/report.test.ts`, following its existing setup (it builds a DB with positions that breach GOLD):

```ts
it('sizes the rebalance tranche at budget minus live SIPs', async () => {
  await persistSipSnapshot(db, live, NOW);
  const input = await buildReportInput(db, AS_OF, { now: NOW });
  const gold = input.pipeline.recommendations.find((r) => /GOLD/.test(r.intent));
  const env = await loadFreeEnvelope(db, NOW);
  expect(BigInt(gold!.amountPaise!)).toBeLessThanOrEqual(env.envelopePaise!);
});

it('with no SIP data it suppresses the BUY and says why', async () => {
  const input = await buildReportInput(db, AS_OF, { now: NOW });
  expect(input.pipeline.recommendations.some((r) => /GOLD/.test(r.intent))).toBe(false);
  expect(input.pipeline.suppressed.some((s) => s.suppressedBy === 'SIP_ENVELOPE')).toBe(true);
});
```

Match the actual field names in `ReportInput.pipeline.recommendations` (`StoredRecommendation`, `src/notify/report.ts:69`). Read that interface first and adjust `intent` / `amountPaise` access to it.

- [ ] **Step 6: Run them and verify they fail.**
Run: `pnpm vitest run tests/notify/report.test.ts`
Expected: FAIL.

- [ ] **Step 7: Implement** in `buildReportInput`:
  - Replace the `tranche` computation with:

```ts
  // One month's deployable money is the free envelope (budget − live SIPs), never the flat
  // tactical rail: September sized ₹50,000 against a real ₹19,746 (spec 2026-10-14).
  const envelope = await loadFreeEnvelope(db, generatedAt);
  const maxOrder = await railPaise(db, 'max_order_paise');
  const tranche = envelope.envelopePaise === null ? 0n : envelope.envelopePaise < maxOrder ? envelope.envelopePaise : maxOrder;
```

  - Build SIP routes beside `surplusRoutes`:

```ts
  const commitment = await loadSipCommitment(db, generatedAt);
  const sipByClass = new Map<AssetClass, bigint>();
  for (const s of commitment.totalPaise === null ? [] : commitment.sips) {
    const cls = classify('MF', s.instrumentId, s.fundName);
    sipByClass.set(cls, (sipByClass.get(cls) ?? 0n) + s.amountPaise);
  }
  const sipRoutes: FundingRoute[] = [...sipByClass].map(([assetClass, amount]) => ({
    id: `sip-${assetClass.toLowerCase()}`, kind: 'sip', assetClass, monthlyCapacityPaise: amount as never,
    loadFree: true, note: 'live SIPs (INDmoney)',
  }));
```

    Pass `routes: opts.routes ?? [...surplusRoutes, ...sipRoutes]` to `rebalanceRec`.
  - In the rebalance loop, before building an `ADD` leg:

```ts
    if (action.kind === 'ADD' && tranche === 0n) {
      await db.query(
        `insert into suppressed_actions (logged_on, action, reason, suppressed_by) values ($1, $2, $3, 'SIP_ENVELOPE')
         on conflict do nothing`,
        [asOf, `BUY ${action.assetClass}`, envelope.reason ?? 'no free money this month'],
      );
      continue;
    }
```

  Import `classify` and `type AssetClass` from `../domain/networth.js`, and `loadFreeEnvelope` and `loadSipCommitment` from `../domain/sips.js`. **Firewall:** `report.ts` must not reach `buckets.ts` through these imports. The architecture test in Step 8 proves that.

- [ ] **Step 8: Run the tests and verify they pass.**
Run: `pnpm vitest run tests/notify tests/domain tests/architecture tests/jobs/report-idempotence.test.ts tests/jobs/report-run-record.test.ts`
Expected: PASS. Existing report tests that expected a ₹50k tranche need a SIP snapshot in setup (`persistSipSnapshot(db, [], NOW)` keeps envelope = ₹50k). Do not change their expected amounts.

- [ ] **Step 9: Commit.**

```bash
git add src/domain/alloc-engine.ts src/notify/report.ts tests/domain/alloc-engine.test.ts tests/notify/report.test.ts
git commit -m "feat(rebalance): SIP routes and budget-minus-SIPs tranche; suppress BUYs when unknown"
```

---

### Task 8: Advisor sees the budget

**Files:**
- Modify: `src/advisor/recommend.ts`
- Modify: `src/jobs/report.ts` (caller)
- Modify: `tests/advisor/recommend.test.ts`

**Interfaces:**
- Consumes: `FreeEnvelope`, `SipCommitment`.
- Produces: `runAdvisor` opts gain `budget?: AdvisorBudget`, where:

```ts
export interface AdvisorBudget {
  monthlyBudget: string; sipTotal: string | null; sipAsOf: string | null; freeEnvelope: string | null;
  sips: { fund: string; amount: string; assetClass: string }[];
}
```

  All money fields are **formatted rupee strings** (`formatInr`), never numbers. The model reads them; it cannot echo a size back, because `FORBIDDEN_NUMBERS` is unchanged.

- [ ] **Step 1: Write the failing test.** In `tests/advisor/recommend.test.ts`, use its existing `fetchImpl` stub that captures the request body:

```ts
it('shows the model the budget, SIPs and free envelope as context', async () => {
  let sent = '';
  const fetchImpl = (async (_u: string, init: { body: string }) => { sent = init.body; return okReply(HOLD_REPLY); }) as never;
  const budget = { monthlyBudget: '₹50,000', sipTotal: '₹30,254', sipAsOf: '2026-10-14', freeEnvelope: '₹19,746',
    sips: [{ fund: 'ICICI Nifty 50', amount: '₹14,001', assetClass: 'EQUITY' }] };
  await runAdvisor(db, { asOf: '2026-10-14', candidates: [eligibleBuy], apiKey: 'k', fetchImpl, budget });
  const user = JSON.parse(JSON.parse(sent).messages[1].content);
  expect(user.budget).toEqual(budget);
});

it('the prompt version is advise-v2', async () => {
  const fetchImpl = (async () => okReply(HOLD_REPLY)) as never;
  await runAdvisor(db, { asOf: '2026-10-14', candidates: [eligibleBuy], apiKey: 'k', fetchImpl });
  const [p] = await db.query<{ prompt_version: string }>(`select prompt_version from advisor_proposals order by id desc limit 1`);
  expect(p!.prompt_version).toBe('advise-v2');
});
```

Use this file's own helper names for `okReply`, `HOLD_REPLY` and `eligibleBuy`; rename them in the snippets above to match.

- [ ] **Step 2: Run it and verify it fails.**
Run: `pnpm vitest run tests/advisor/recommend.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.**
  - Set `ADVISE_PROMPT_VERSION = 'advise-v2'`.
  - Add one PROMPT line after "- You never state an amount…":

```ts
  '- "budget" shows his monthly budget, the SIPs already running and what is free. It is context: you still never state an amount.',
```

  - Add `budget?: AdvisorBudget` to opts. Include `...(opts.budget ? { budget: opts.budget } : {})` both in the user message (`JSON.stringify({ asOf, candidates: shown, budget })`) and in `snapshot`, so replays see what the model saw.
  - In `src/jobs/report.ts` around line 99, build it:

```ts
      const env = await loadFreeEnvelope(db, new Date().toISOString());
      const sipsNow = await loadSipCommitment(db, new Date().toISOString());
      const budget = {
        monthlyBudget: formatInr(env.budgetPaise as never),
        sipTotal: env.sipTotalPaise === null ? null : formatInr(env.sipTotalPaise as never),
        sipAsOf: env.sipAsOf?.slice(0, 10) ?? null,
        freeEnvelope: env.envelopePaise === null ? null : formatInr(env.envelopePaise as never),
        sips: sipsNow.sips.map((s) => ({ fund: s.fundName, amount: formatInr(s.amountPaise as never), assetClass: classify('MF', s.instrumentId, s.fundName) })),
      };
      const advice = await runAdvisor(db, { asOf, candidates, apiKey: process.env.LLM_API_KEY, model: process.env.WEEKLY_LLM_MODEL, budget });
```

  **Firewall check:** `tests/advisor/firewall.test.ts` restricts what `src/advisor/` may import. `recommend.ts` gets only a *type* plus data passed in. Keep `AdvisorBudget` declared inside `recommend.ts`, so `src/advisor/` imports nothing new.

- [ ] **Step 4: Run the tests and verify they pass.**
Run: `pnpm vitest run tests/advisor tests/jobs`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/advisor/recommend.ts src/jobs/report.ts tests/advisor/recommend.test.ts
git commit -m "feat(advisor): show the model the budget, live SIPs and free envelope (advise-v2)"
```

---

### Task 9: Web — Monthly investing card, SIP status per fund, budget rail

**Files:**
- Modify: `web/lib/data.ts`
- Modify: `web/app/page.tsx`
- Modify: `web/app/funds/page.tsx`
- Modify: `web/app/cleanup/controls-panel.tsx`
- Modify: `web/lib/product.ts`
- Create: `tests/web/sips-shape.test.ts`

**Interfaces:**
- Consumes: `loadSipCommitment`, `loadFreeEnvelope`, `nextStepUp`, `classify`.
- Produces:

```ts
export interface SipsData {
  asOf: string | null; stale: boolean;
  budgetPaise: bigint; sipTotalPaise: bigint | null; envelopePaise: bigint | null; reason: string | null;
  rows: { key: string; fund: string; instrumentId: string; assetClass: string; amountPaise: bigint;
          stepUp: string | null; stepUpInferred: boolean; nextOn: string | null; nextAmountPaise: bigint | null }[];
  nextStepUp: { on: string; totalPaise: bigint | null } | null;
}
export async function getSips(): Promise<SipsData>;
```

- [ ] **Step 1: Run the design pass.** Invoke the `ui-ux-pro-max` skill against `design-system/sentinel/MASTER.md` for one card: "Monthly investing", in the Overview bento at span-8 beside Goals (span-4). The content is a four-`Stat` strip (Budget, SIPs, Free this month, Next step-up) plus a `DataTable`. Use only `web/lib/ui.tsx` primitives and the existing `ClassChip`. Do not restyle other cards.

- [ ] **Step 2: Write the failing shape test.** `tests/web/sips-shape.test.ts`, following `tests/web/recommendations-shape.test.ts` (read it first to copy how it opens the DB and calls the getter):

```ts
it('getSips: live SIPs, budget and envelope, with nulls never coerced to 0', async () => {
  await persistSipSnapshot(db, live, new Date().toISOString());
  const d = await getSips();
  expect(d.sipTotalPaise).toBe(live.reduce((s, r) => s + r.amountPaise, 0n));
  expect(d.rows.every((r) => r.assetClass === 'EQUITY')).toBe(true);
  expect(d.rows[0]).toMatchObject({ stepUp: '10%', stepUpInferred: true });
  expect(d.nextStepUp?.on).toBe('2027-11-12');
});

it('getSips with no snapshot: unknown everywhere', async () => {
  const d = await getSips();
  expect(d).toMatchObject({ asOf: null, sipTotalPaise: null, envelopePaise: null, rows: [] });
  expect(d.reason).toMatch(/never synced/);
});
```

- [ ] **Step 3: Run it and verify it fails.**
Run: `pnpm vitest run tests/web/sips-shape.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement `getSips`** in `web/lib/data.ts`:

```ts
export async function getSips(): Promise<SipsData> {
  const d = await db();
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const c = await loadSipCommitment(d, now);
  const e = await loadFreeEnvelope(d, now);
  const rows = c.sips.map((s) => {
    const n = nextStepUp(s, today);
    return {
      key: s.sipId, fund: s.fundName, instrumentId: s.instrumentId, assetClass: classify('MF', s.instrumentId, s.fundName),
      amountPaise: s.amountPaise,
      stepUp: s.stepUpKind === null ? null : s.stepUpKind === 'percent' ? `${s.stepUpRaw}%`
        : s.stepUpKind === 'rupees' ? formatInr(BigInt(Math.round(s.stepUpRaw!)) * 100n as never) : 'unknown',
      stepUpInferred: s.stepUpInferred, nextOn: n.on, nextAmountPaise: n.amountPaise,
    };
  });
  const dates = rows.map((r) => r.nextOn).filter((x): x is string => x !== null).sort();
  const first = dates[0];
  // The total after the next step-up: every SIP stepping that day moves; the rest stay.
  // Unknown if any SIP stepping that day has an unknown new amount.
  const nextStepUp = first === undefined ? null : {
    on: first,
    totalPaise: rows.some((r) => r.nextOn === first && r.nextAmountPaise === null) ? null
      : rows.reduce((s, r) => s + (r.nextOn === first ? r.nextAmountPaise! : r.amountPaise), 0n),
  };
  return { asOf: c.asOf, stale: c.stale, budgetPaise: e.budgetPaise, sipTotalPaise: c.totalPaise,
    envelopePaise: e.envelopePaise, reason: e.reason, rows, nextStepUp };
}
```

Add the `SipsData` interface above it and the imports from `../../src/domain/sips.js` and `../../src/domain/networth.js`, using the same relative-import style as the other `src/` imports in this file.

- [ ] **Step 5: Run the shape test and verify it passes.**
Run: `pnpm vitest run tests/web/sips-shape.test.ts`
Expected: PASS.

- [ ] **Step 6: Build the Overview card** in `web/app/page.tsx`:
  - Call `const sips = await getSips();` beside `getOverview()`.
  - Insert this card as `span-8` before the Goals card. The current Allocation card (span-8) and Goals card (span-4) stay; place Monthly investing in a new row with a Goals-height neighbour, or swap Allocation to span-12. Follow the design pass.
  - Content rules, from CLAUDE.md honesty rules:
    - `sips.asOf === null` → `<Notice tone="amber">No SIP data yet — the daily sync fills this (<span className="mono">indmoney-sips</span>). Until it does, the advisor sizes nothing.</Notice>`
    - `sips.stale` → `<Notice tone="amber">SIP data is from {asOf}, older than 7 days — sizing is paused until it refreshes.</Notice>`, and still show the rows.
    - `rows.length === 0 && !stale` → `<Notice>INDmoney reports no active SIPs (as of {asOf}).</Notice>` (Review Focus 1.)
    - Stats: Budget `<Money p={budgetPaise}/>`; SIPs `sipTotalPaise === null ? 'unknown' : <Money/>`; Free this month `envelopePaise === null ? 'unknown' : <Money/>`, with `sub={reason ?? 'budget − SIPs'}`; Next step-up `nextStepUp ? \`${on} → ${total ? formatInr(total) : 'unknown'}\` : '—'`.
    - `DataTable` cols: Fund · Class (`ClassChip`) · Monthly (`Money`) · Step-up (`r.stepUp ?? '—'` plus `<Badge tone="gray">inferred</Badge>` when `stepUpInferred`) · Next (`nextOn ?? '—'`, then `nextAmountPaise` as Money or `unknown`).
    - Card `aside`: `as of {asOf.slice(0,10)} · INDmoney`.

- [ ] **Step 7: Label SIP status on `/funds`.** In `web/app/funds/page.tsx`, call `getSips()`, build `const sipOf = new Map(sips.rows.map((r) => [r.instrumentId, r.amountPaise]))`, and add a Ranking column:

```tsx
{ label: 'SIP', value: ({ r }) => sips.asOf === null
    ? <span className="dim">unknown</span>
    : sipOf.has(r.instrumentId) ? <><Money p={sipOf.get(r.instrumentId)! as never} />/mo</> : <span className="dim">no active SIP</span> },
```

  Holdings use `IND:<fund_id>` ids. `r.instrumentId` is the same id when the held fund came from INDmoney. If ranking rows carry the `MF:` seed id instead, map through `canonical_id`, the way `heldFunds` resolves siblings. Check one real row before deciding.

- [ ] **Step 8: Budget in the rail editor.** In `web/app/cleanup/controls-panel.tsx`, add `'monthly_budget_paise'` to `RAIL_KEYS`, first in the list. Check what unit the input expects for `_paise` keys: the panel sends `Number(railValue)` straight through, so the owner types paise. If no other paise rail shows a hint, add `placeholder` text "in paise (₹50,000 = 5000000)" for keys ending in `_paise`. Do not change the conversion; that would change existing rails' behaviour.

- [ ] **Step 9: Update the product row.** In `web/lib/product.ts`, on the `overview` row: append `'Live SIPs, the monthly budget and what is free to invest'` to `works`. Replace the `missing` text `'Nothing material — Phase 0 data is complete'` with `'Goal progress against target dates (piece 2 of the 2026-10-14 spec)'`.

- [ ] **Step 10: Typecheck, build and run the full suite.**
Run: `pnpm exec tsc --noEmit && pnpm --dir web typecheck && pnpm vitest run`
Then: `pnpm --dir web build` with `DATABASE_URL` unset.
Expected: both typechecks clean, all tests PASS, build succeeds.

- [ ] **Step 11: Commit.**

```bash
git add web tests/web/sips-shape.test.ts
git commit -m "feat(web): Monthly investing card, SIP status per fund, budget rail editable"
```

---

### Task 10: Live verification and docs

**Files:**
- Modify: `PENDING.md`, `MEMORY.md`, `index.md`, `.superpowers/sdd/2026-08-12-sentinel-phase-0/progress.md`

- [ ] **Step 1: Apply the migration and run a live sync.** Run `pnpm sync` with production env (the owner's usual command). Then query Supabase:

```sql
select s.as_of, s.sip_count, x.fund_name, x.amount_paise/100 as rupees, x.step_up_raw, x.step_up_kind, x.start_date
  from sip_snapshots s join sips x on x.snapshot_id = s.id
 where s.id = (select max(id) from sip_snapshots);
```

Expected: 3 rows, ₹14,001 / ₹11,001 / ₹2,251, step-up 10 `percent`, start 2026-11-12. There are 4 rows if Invesco has mandated. **If the count or amounts differ from the INDmoney app, stop and tell the owner. Do not proceed.**

- [ ] **Step 2: Check the free envelope against production rails.** Production has `tactical_monthly_paise = 50,00,000` and no `monthly_budget_paise` row, so the default ₹50,000 applies. Expected envelope: ₹50,000 − ₹27,253 = **₹22,747** before Invesco, and ₹19,746 after. Confirm it on Overview.

- [ ] **Step 3: Deploy and render.** Push `main`, wait for the Vercel production deploy, and open `/`, `/funds` and `/cleanup` while logged in. Expected: no server errors; the Monthly investing card is populated; `/funds` shows "no active SIP" for ICICI Large Cap, Motilal Midcap and HDFC Mid Cap; the Owner rails card no longer shows the spurious tactical breach.

- [ ] **Step 4: Update the docs in one commit.**
  - `PENDING.md`: tick the SIP item. Add: "Piece 2 (goal plan) next. Ask the owner the five spec §2.5 inputs at its start." Also add the two zombie incidents found 2026-10-14 (`composite`, FX `seed`) and the stale FR-31 copy on `/freshness` as separate open items.
  - `MEMORY.md`:
    - Replace the 2026-09-20 hand-copied ₹30,254 table with a pointer: "live in `sips` / `loadSipCommitment`".
    - Strike deferred minor #9.
    - Record the `checkPortfolioRails` whole-book bug as fixed.
    - Add the contract: "sizing = `loadFreeEnvelope`; never `tactical_monthly_paise` directly".
  - `index.md`: add `src/domain/sips.ts` and its exports, `migrations/0032_sips.sql`, and `getSips`.
  - `progress.md`: one ledger line, "SIP tracking (spec 2026-10-14 piece 1): complete", with the fix rounds.

```bash
git add PENDING.md MEMORY.md index.md .superpowers/sdd/2026-08-12-sentinel-phase-0/progress.md
git commit -m "docs: SIP tracking shipped; ledger, memory, index"
```

---

## Self-review notes (written with the spec open)

- **Spec §1.1–1.11 coverage:** source §1.2 → T2; data model §1.3 → T1; step-up §1.4 → T3; sync §1.5 → T4; budget/envelope §1.6 → T5 (sizing), T6 (rails), T7 (report); engine §1.7 → T7; advisor §1.8 → T8; web §1.9 → T9; tests §1.10 → each task; done §1.11 → T10.
- **Added beyond the spec:** the `checkPortfolioRails` fix (T6) and deferred minor #9 (T2), both required by CLAUDE.md's fix-on-touch rule.
- **Spec §1.6 wording:** the spec says the envelope "replaces `tactical_monthly_paise` in three places". `checkPortfolioRails` is a fourth reader. T6 covers both rail functions.
- **Known risk:** the `rails.ts` ↔ `sips.ts` import cycle (T6 Step 4) has a stated fallback.
