import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadPositions, type Position } from '../../src/domain/networth.js';
import { concentration } from '../../src/domain/allocation.js';
import {
  BETTER_ALTERNATIVE_MARGIN,
  LEGACY_QUEUE_STUB,
  MINIMUM_HOLD_MONTHS,
  evaluateExits,
  type ExitState,
} from '../../src/domain/sell-triggers.js';

const SEED_DATE = '2026-08-12';
let db: Db;
let positions: Position[];

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: SEED_DATE });
  positions = await loadPositions(db);
});

const stateOf = (over: Partial<ExitState> = {}): ExitState => ({
  positions,
  blockedIds: [],
  ...over,
});

/** Appends an FR-11 recommendation carrying a machine-testable falsification condition. */
async function insertRec(
  instrumentId: string,
  falsification: Record<string, unknown> | null,
  over: { kind?: string; createdOn?: string; evidence?: Record<string, unknown> } = {},
): Promise<void> {
  await db.query(
    `insert into recommendations
       (created_on, kind, intent, primary_rec, alternates, ips_clause_refs, engine_evidence)
     values ($1, $2, 'test', $3, '[]', '["3.7"]', $4)`,
    [
      over.createdOn ?? SEED_DATE,
      over.kind ?? 'satellite',
      JSON.stringify({ instrumentId, falsification }),
      JSON.stringify(over.evidence ?? {}),
    ],
  );
}

async function insertClose(instrumentId: string, tradeDate: string, closePaise: bigint): Promise<void> {
  await db.query(
    `insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of)
     values ($1, $2, $3, 'nse-bhavcopy', $4)
     on conflict (instrument_id, trade_date) do update set close_paise = excluded.close_paise`,
    [instrumentId, tradeDate, closePaise.toString(), `${tradeDate}T18:00:00Z`],
  );
}

/** Writes `n` sessions of closes ending on 2026-08-12, compounding `stepBps` per session. */
async function writeSeries(instrumentId: string, start: bigint, stepBps: number, n: number): Promise<bigint[]> {
  const out: bigint[] = [start];
  for (let i = 1; i < n; i++) out.push(out[i - 1]! + (out[i - 1]! * BigInt(stepBps)) / 10_000n);
  const end = new Date(`${SEED_DATE}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - (n - 1 - i));
    await insertClose(instrumentId, d.toISOString().slice(0, 10), out[i]!);
  }
  return out;
}

async function writeIndexSeries(series: string, start: bigint, stepBps: number, n: number): Promise<void> {
  let v = start;
  const end = new Date(`${SEED_DATE}T00:00:00Z`);
  for (let i = 0; i < n; i++) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - (n - 1 - i));
    await db.query(
      `insert into index_prices_eod (series_code, trade_date, close_paise, as_of)
       values ($1, $2, $3, $4)
       on conflict (series_code, trade_date) do update set close_paise = excluded.close_paise`,
      [series, d.toISOString().slice(0, 10), v.toString(), `${d.toISOString().slice(0, 10)}T18:00:00Z`],
    );
    v = v + (v * BigInt(stepBps)) / 10_000n;
  }
}

async function insertFundamentals(
  instrumentId: string,
  cols: { roce?: number; de?: number; redFlags?: number },
  asOf = SEED_DATE,
): Promise<void> {
  const [upload] = await db.query<{ id: number }>(
    `insert into screener_uploads (as_of, filename, source) values ($1, $2, 'screener-in') returning id`,
    [asOf, `screener-${asOf}-${instrumentId}.csv`],
  );
  await db.query(
    `insert into fundamentals (upload_id, instrument_id, data, roce_pct, de_ratio, fcf_pos_5y, red_flags, as_of)
     values ($1, $2, '{}', $3, $4, true, $5, $6)`,
    [upload!.id, instrumentId, cols.roce ?? 20, cols.de ?? 0.3, cols.redFlags ?? 0, `${asOf}T12:00:00Z`],
  );
}

describe('trigger 1 — falsification (§3.7)', () => {
  it('fires when the stored condition is true against fresh prices, and not when it is false', async () => {
    const floor = 20_000n; // ₹200
    await insertRec('NSE:RPOWER', { metric: 'price_paise', op: 'lt', value: floor.toString() });

    await insertClose('NSE:RPOWER', SEED_DATE, floor - 1n);
    const tripped = await evaluateExits(db, stateOf(), '2026-08');
    const hit = tripped.find((c) => c.trigger === 'falsification')!;
    expect(hit).toBeDefined();
    expect(hit.instrumentId).toBe('NSE:RPOWER');
    expect(hit.overridesMinimumHold).toBe(true);
    expect(hit.ipsClauseRefs).toContain('3.7');
    // The evidence names the datum that fired it, not a restatement of the rule.
    expect(hit.evidence).toContain(floor.toString());

    // Mutation: the only change is the close moving to the safe side of the threshold.
    await insertClose('NSE:RPOWER', SEED_DATE, floor);
    const clear = await evaluateExits(db, stateOf(), '2026-08');
    expect(clear.filter((c) => c.trigger === 'falsification')).toEqual([]);
  });

  it('stays silent when the condition is not testable against the data we hold', async () => {
    await insertRec('NSE:RPOWER', { metric: 'price_paise', op: 'lt', value: '20000' });
    // No prices_eod row at all: untestable is not the same as falsified.
    const out = await evaluateExits(db, stateOf(), '2026-08');
    expect(out.filter((c) => c.trigger === 'falsification')).toEqual([]);
  });

  it('ignores a recommendation with no falsification condition, and a suppressed one', async () => {
    await insertRec('NSE:RPOWER', null);
    await db.query(
      `insert into recommendations
         (created_on, kind, intent, primary_rec, alternates, ips_clause_refs, engine_evidence, suppressed)
       values ($1, 'satellite', 'test', $2, '[]', '["3.7"]', '{}', true)`,
      [SEED_DATE, JSON.stringify({ instrumentId: 'NSE:RPOWER', falsification: { metric: 'price_paise', op: 'lt', value: '999999999' } })],
    );
    await insertClose('NSE:RPOWER', SEED_DATE, 10_000n);
    const out = await evaluateExits(db, stateOf(), '2026-08');
    expect(out.filter((c) => c.trigger === 'falsification')).toEqual([]);
  });
});

describe('trigger 2 — red flag (§3.7)', () => {
  it('fires on a red flag in the latest screener upload for a held name', async () => {
    await insertFundamentals('NSE:RPOWER', { redFlags: 0 }, '2026-06-30');
    expect((await evaluateExits(db, stateOf(), '2026-08')).filter((c) => c.trigger === 'red-flag')).toEqual([]);

    await insertFundamentals('NSE:RPOWER', { redFlags: 2 }, '2026-07-31');
    const out = await evaluateExits(db, stateOf(), '2026-08');
    const hit = out.find((c) => c.trigger === 'red-flag')!;
    expect(hit.instrumentId).toBe('NSE:RPOWER');
    expect(hit.evidence).toContain('2');
    expect(hit.overridesMinimumHold).toBe(true);
  });
});

describe('trigger 3 — hard-cap breach (§3.5)', () => {
  it('names the instruments the real seed already breaches, derived from concentration()', async () => {
    const out = await evaluateExits(db, stateOf(), '2026-08');
    const capped = out.filter((c) => c.trigger === 'hard-cap').map((c) => c.instrumentId);

    const c = concentration(positions);
    const overStock = [...c.byStock].filter(([, p]) => p > 0.10).map(([id]) => id);
    expect(overStock.length).toBeGreaterThan(0);
    for (const id of overStock) expect(capped).toContain(id);
    // US:NOW is the employer line at ~20% against a 10% cap.
    expect(capped).toContain('US:NOW');
    expect(out.find((c2) => c2.trigger === 'hard-cap')!.ipsClauseRefs).toContain('3.5');
  });

  it('proposes a trim, not a full exit, for a cap breach', async () => {
    const out = await evaluateExits(db, stateOf(), '2026-08');
    for (const c of out.filter((x) => x.trigger === 'hard-cap')) expect(c.action).toBe('TRIM');
  });
});

describe('trigger 4 — sustained underperformance', () => {
  const SESSIONS = 330;

  it('fires only while the 12-month relative return is worse than −20pp in both quarters', async () => {
    await writeIndexSeries('NIFTY 500', 2_000_000n, 5, SESSIONS);
    await writeSeries('NSE:RPOWER', 100_000n, -15, SESSIONS);

    const out = await evaluateExits(db, stateOf(), '2026-08');
    const hit = out.find((c) => c.trigger === 'underperformance')!;
    expect(hit).toBeDefined();
    // Not an override: §3.7 lists only falsification, red flag and hard cap.
    expect(hit.overridesMinimumHold).toBe(false);

    // Mutation: lift the series so the relative return clears −20pp; the candidate goes.
    await writeSeries('NSE:RPOWER', 100_000n, 6, SESSIONS);
    const after = await evaluateExits(db, stateOf(), '2026-08');
    expect(after.filter((c) => c.trigger === 'underperformance')).toEqual([]);
  });

  it('says nothing when there is not enough price history to judge', async () => {
    await writeIndexSeries('NIFTY 500', 2_000_000n, 5, 30);
    await writeSeries('NSE:RPOWER', 100_000n, -50, 30);
    const out = await evaluateExits(db, stateOf(), '2026-08');
    expect(out.filter((c) => c.trigger === 'underperformance')).toEqual([]);
  });
});

describe('trigger 5 — tax-aware better alternative', () => {
  const alternatives = [
    { heldInstrumentId: 'NSE:RPOWER', challengerId: 'NSE:TCS', heldComposite: 40, challengerComposite: 40 + BETTER_ALTERNATIVE_MARGIN + 1 },
    { heldInstrumentId: 'NSE:NIFTYBEES', challengerId: 'NSE:INFY', heldComposite: 30, challengerComposite: 30 + BETTER_ALTERNATIVE_MARGIN + 5 },
  ];

  it('emits at most one per quarter even when several challengers clear the margin', async () => {
    const out = await evaluateExits(db, stateOf({ alternatives }), '2026-08');
    expect(out.filter((c) => c.trigger === 'better-alternative')).toHaveLength(1);
  });

  it('emits none when this quarter already carries one', async () => {
    await insertRec('NSE:RPOWER', null, {
      kind: 'sell',
      createdOn: '2026-07-05',
      evidence: { trigger: 'better-alternative' },
    });
    const out = await evaluateExits(db, stateOf({ alternatives }), '2026-08');
    expect(out.filter((c) => c.trigger === 'better-alternative')).toEqual([]);
  });

  it('ignores a challenger that does not clear the margin', async () => {
    const marginal = [{ heldInstrumentId: 'NSE:RPOWER', challengerId: 'NSE:TCS', heldComposite: 40, challengerComposite: 40 + BETTER_ALTERNATIVE_MARGIN - 1 }];
    const out = await evaluateExits(db, stateOf({ alternatives: marginal }), '2026-08');
    expect(out.filter((c) => c.trigger === 'better-alternative')).toEqual([]);
  });
});

describe('trigger 7 — credit / maturity (§3.8, §3.9)', () => {
  it('raises the Sammaan redemption in its maturity month', async () => {
    const out = await evaluateExits(db, stateOf(), '2026-09');
    const hit = out.find((c) => c.trigger === 'credit-maturity')!;
    expect(hit).toBeDefined();
    expect(hit.action).toBe('REDEEM');
    expect(hit.ipsClauseRefs).toContain('3.9');
    expect(hit.evidence).toContain('2026-09-26');
  });

  it('is silent in a month with nothing maturing', async () => {
    const out = await evaluateExits(db, stateOf(), '2026-11');
    expect(out.filter((c) => c.trigger === 'credit-maturity')).toEqual([]);
  });
});

describe('cross-cutting rules', () => {
  it('never produces an exit for an instrument blocked by stale data (FR-31)', async () => {
    await insertRec('NSE:RPOWER', { metric: 'price_paise', op: 'lt', value: '20000' });
    await insertClose('NSE:RPOWER', SEED_DATE, 1n);
    await insertFundamentals('NSE:RPOWER', { redFlags: 3 });

    const blockedAll = await evaluateExits(db, stateOf({ blockedIds: positions.map((p) => p.instrumentId) }), '2026-08');
    expect(blockedAll).toEqual([]);
  });

  it('flags a non-override trigger that would breach the §3.7 minimum holding period', async () => {
    await db.query(
      `insert into lots (instrument_id, account, acquired_on, quantity, cost_paise, as_of, source)
       values ('NSE:RPOWER', 'groww', '2026-06-01', 1, 100000, $1, 'owner-telegram')`,
      [`${SEED_DATE}T00:00:00Z`],
    );
    await writeIndexSeries('NIFTY 500', 2_000_000n, 5, 330);
    await writeSeries('NSE:RPOWER', 100_000n, -15, 330);

    const hit = (await evaluateExits(db, stateOf(), '2026-08')).find((c) => c.trigger === 'underperformance')!;
    expect(hit.heldMonths).not.toBeNull();
    expect(hit.heldMonths!).toBeLessThan(MINIMUM_HOLD_MONTHS);
    expect(hit.blockedByMinimumHold).toBe(true);
    expect(hit.evidence).toMatch(/minimum holding period/i);
  });

  it('every candidate is a paper object carrying its trigger, evidence and an IPS citation', async () => {
    await insertRec('NSE:RPOWER', { metric: 'price_paise', op: 'lt', value: '20000' });
    await insertClose('NSE:RPOWER', SEED_DATE, 1n);
    const out = await evaluateExits(db, stateOf(), '2026-08');
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) {
      expect(c.paper).toBe(true);
      expect(c.month).toBe('2026-08');
      expect(c.evidence.length).toBeGreaterThan(0);
      expect(c.ipsClauseRefs.length).toBeGreaterThan(0);
    }
  });

  it('documents trigger 6 rather than pretending it runs', () => {
    expect(LEGACY_QUEUE_STUB).toMatch(/Phase 2/);
  });
});
