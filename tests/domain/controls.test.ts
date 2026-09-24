import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import {
  applyDueRailChanges, BREAKER_STREAK, evaluateBreaker, freeze, isLoosening,
  pendingRailChanges, proposeRailChange, resetBreakerWithPostMortem, RESET_PHRASE,
  unfreeze, UNFREEZE_PHRASE,
} from '../../src/domain/controls.js';
import { getBreakerState, getFreezeState } from '../../src/domain/rails.js';
import { createOrder, getOrder } from '../../src/domain/orders.js';
import {
  buildRecommendation, persistRecommendation, type RecLeg,
} from '../../src/domain/recommendations.js';

/**
 * Freeze (FR-32), the breaker (FR-33) and rail cooling (FR-34) all existed as stored
 * state that /cleanup rendered and `checkRails` read. Nothing ever SET any of it:
 * `setFreeze`, `recordFalsification` and `last_rail_change` had no production writer.
 */
let db: Db;
const NOW = new Date('2026-09-24T06:00:00Z');

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

const leg = (over: Partial<RecLeg> = {}): RecLeg => ({
  intent: 'deploy surplus', instrumentId: 'NSE:GOLDBEES', action: 'BUY', amountPaise: '100000',
  thesis: 'gold sits under its IPS floor and the monthly surplus restores it',
  ipsClauseRefs: ['3.3'], falsification: null, ...over,
});

const draft = async (over: Partial<RecLeg> = {}, createdOn = '2026-09-20') => {
  const rec = buildRecommendation({
    kind: 'satellite', createdOn, primary: leg(over), sameIntentAlternates: [], engineEvidence: {}, paperMode: true,
  });
  const { id } = await persistRecommendation(db, rec);
  return { recId: id!, order: await createOrder(db, { recommendationId: id!, recommendation: rec, createdBy: 'advisor' }) };
};

// ── FR-32 ──────────────────────────────────────────────────────────────────────────
describe('freeze', () => {
  it('halts drafting and cancels every open request, atomically', async () => {
    const { order } = await draft();
    const { cancelled } = await freeze(db, 'market looks wrong', NOW);
    expect(cancelled).toEqual([order.id]);
    expect((await getOrder(db, order.id))!.status).toBe('CANCELLED');
    expect((await getFreezeState(db)).active).toBe(true);
    // Drafting is refused while frozen.
    await expect(draft({ instrumentId: 'NSE:LIQUIDBEES' })).rejects.toThrow(/FREEZE/);
    await db.close();
  });

  it('refuses a freeze with no reason', async () => {
    await expect(freeze(db, '   ')).rejects.toThrow(/reason/);
    await db.close();
  });

  it('unfreezes only on the typed phrase, and does not revive what it cancelled', async () => {
    const { order } = await draft();
    await freeze(db, 'pause', NOW);
    await expect(unfreeze(db, 'yes')).rejects.toThrow(UNFREEZE_PHRASE);
    expect((await getFreezeState(db)).active).toBe(true);
    await unfreeze(db, UNFREEZE_PHRASE);
    expect((await getFreezeState(db)).active).toBe(false);
    expect((await getOrder(db, order.id))!.status).toBe('CANCELLED');
    await db.close();
  });
});

// ── FR-33 ──────────────────────────────────────────────────────────────────────────
describe('the falsification breaker is derived, not counted', () => {
  /** An owner-approved recommendation whose price condition fires (or not) today. */
  async function approved(instrumentId: string, level: string, createdOn = '2026-09-20') {
    await db.query(
      `insert into instruments (id, kind, name, currency) values ($1, 'EQUITY', $1, 'INR')
       on conflict (id) do nothing`, [instrumentId]);
    await db.query(
      `insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of)
       values ($1, date '2026-09-23', 10000, 'nse-bhavcopy', timestamptz '2026-09-23T12:00:00Z')
       on conflict do nothing`, [instrumentId]);
    const { order, recId } = await draft({
      instrumentId, falsification: { metric: 'price_paise', op: 'lt', value: level },
    }, createdOn);
    await db.query(
      `insert into order_transitions
         (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot, expected_revision, idempotency_key)
       values ($1, 1, 'PENDING_APPROVAL', 'ACKNOWLEDGED', 'owner', '{}'::jsonb, 1, $2)`,
      [order.id, `ack:${order.id}`]);
    return recId;
  }
  // Close is 10000 paise: a level of 20000 fires ('lt'), a level of 5000 does not.
  const HIT = '20000';
  const HOLDS = '5000';

  it('trips on three consecutive falsified approvals', async () => {
    await approved('NSE:A', HIT);
    await approved('NSE:B', HIT);
    await approved('NSE:C', HIT);
    const ev = await evaluateBreaker(db, NOW);
    expect(ev.streak).toBe(BREAKER_STREAK);
    expect(ev.tripped).toBe(true);
    expect((await getBreakerState(db)).active).toBe(true);
    await db.close();
  });

  it('does not trip on two', async () => {
    await approved('NSE:A', HIT);
    await approved('NSE:B', HIT);
    expect((await evaluateBreaker(db, NOW)).tripped).toBe(false);
    await db.close();
  });

  it('treats an unresolved outcome as unknown, not as a success', async () => {
    await approved('NSE:A', HIT);
    await approved('NSE:B', HOLDS); // not fired, horizon not passed: UNKNOWN
    await approved('NSE:C', HIT);
    await approved('NSE:D', HIT);
    // The unknown neither breaks nor extends the run: A, C, D are three in a row.
    expect((await evaluateBreaker(db, NOW)).streak).toBe(3);
    await db.close();
  });

  it('breaks the run on a recommendation that survived its horizon', async () => {
    await approved('NSE:A', HIT, '2025-01-10');
    await approved('NSE:B', HOLDS, '2025-01-10'); // did not fire before NOW
    await approved('NSE:C', HIT);
    await approved('NSE:D', HIT);
    // Approvals are timestamped now, so the NOT_HIT must come from the horizon: evaluate
    // thirteen months later, when B's twelve months have passed without its condition.
    const later = new Date(Date.now() + 400 * 86_400_000);
    const ev = await evaluateBreaker(db, later);
    expect(ev.outcomes.find((o) => o.outcome === 'NOT_HIT')).toBeDefined();
    // A, then B survived, then C, D: the run after B is only two.
    expect(ev.streak).toBe(2);
    expect(ev.tripped).toBe(false);
    await db.close();
  });

  it('is idempotent however often it runs — replay cannot fabricate a streak', async () => {
    await approved('NSE:A', HIT);
    await approved('NSE:B', HIT);
    for (let i = 0; i < 5; i++) await evaluateBreaker(db, NOW);
    expect((await evaluateBreaker(db, NOW)).streak).toBe(2);
    const [hits] = await db.query<{ n: string }>(
      `select count(*) as n from audit_log where entity = 'falsification' and action = 'HIT'`);
    expect(Number(hits!.n)).toBe(2);
    await db.close();
  });

  it('ignores a recommendation with no falsification condition', async () => {
    await draft(); // falsification: null
    expect((await evaluateBreaker(db, NOW)).outcomes).toEqual([]);
    await db.close();
  });

  it('resets only on the typed phrase, with a post-mortem written from the record', async () => {
    await approved('NSE:A', HIT); await approved('NSE:B', HIT); await approved('NSE:C', HIT);
    await evaluateBreaker(db, NOW);
    await expect(resetBreakerWithPostMortem(db, 'reset')).rejects.toThrow(RESET_PHRASE);
    const note = await resetBreakerWithPostMortem(db, RESET_PHRASE);
    expect(note).toMatch(/3 consecutive approved recommendations/);
    expect((await getBreakerState(db)).active).toBe(false);
    // The same three hits must not re-trip it the moment it was reset.
    expect((await evaluateBreaker(db, new Date(Date.now() + 1000))).tripped).toBe(false);
    await db.close();
  });
});

// ── FR-34 ──────────────────────────────────────────────────────────────────────────
describe('rail changes cool for 48 hours', () => {
  const drawdown = (pct: number, asOf = '2026-09-23') => db.query(
    `insert into portfolio_drawdown (as_of, current_pct, peak_date, peak_value)
     values ($1, $2, date '2026-08-26', 100)`, [asOf, pct]);

  it('treats a higher ceiling as a loosening', () => {
    expect(isLoosening('max_order_paise', 100_00_000, 200_00_000)).toBe(true);
    expect(isLoosening('max_order_paise', 100_00_000, 50_00_000)).toBe(false);
    expect(() => isLoosening('made_up_rail', 1, 2)).toThrow(/unknown rail/);
  });

  it('holds a change back for 48 hours, then applies it', async () => {
    await drawdown(2);
    const { activatesAt } = await proposeRailChange(db, 'max_order_paise', 50_00_000, NOW);
    expect(activatesAt).toBe('2026-09-26T06:00:00.000Z');
    expect((await applyDueRailChanges(db, new Date('2026-09-25T06:00:00Z'))).activated).toEqual([]);
    expect((await applyDueRailChanges(db, new Date('2026-09-26T06:00:01Z'))).activated).toEqual(['max_order_paise']);
    const [row] = await db.query<{ value: unknown }>(`select value from settings_rails where key = 'max_order_paise'`);
    expect(Number(row!.value)).toBe(50_00_000);
    expect(await pendingRailChanges(db)).toEqual([]);
    await db.close();
  });

  it('applies exactly at the 48-hour boundary, not a second before', async () => {
    await drawdown(2);
    await proposeRailChange(db, 'max_order_paise', 50_00_000, NOW);
    expect((await applyDueRailChanges(db, new Date('2026-09-26T05:59:59Z'))).activated).toEqual([]);
    expect((await applyDueRailChanges(db, new Date('2026-09-26T06:00:00Z'))).activated).toEqual(['max_order_paise']);
    await db.close();
  });

  it('refuses a loosening above 15% drawdown at proposal', async () => {
    await drawdown(16);
    await expect(proposeRailChange(db, 'max_order_paise', 200_00_000, NOW)).rejects.toThrow(/16%/);
    await db.close();
  });

  it('refuses a loosening when there is no drawdown evidence at all', async () => {
    // Missing evidence cannot approve a loosening.
    await expect(proposeRailChange(db, 'max_order_paise', 200_00_000, NOW)).rejects.toThrow(/no recent drawdown/);
    await db.close();
  });

  it('re-checks a loosening at activation and refuses it if the drawdown deepened', async () => {
    await drawdown(5);
    await proposeRailChange(db, 'max_order_paise', 200_00_000, NOW);
    await drawdown(18, '2026-09-25');
    const r = await applyDueRailChanges(db, new Date('2026-09-26T06:00:00Z'));
    expect(r.activated).toEqual([]);
    expect(r.refused[0]!.reason).toMatch(/18%/);
    await db.close();
  });

  it('allows a tightening whatever the drawdown', async () => {
    await drawdown(25);
    await expect(proposeRailChange(db, 'max_order_paise', 50_00_000, NOW)).resolves.toBeDefined();
    await db.close();
  });

  it('no longer blocks every order while a change cools', async () => {
    // This was COOLING_NOT_ELAPSED in the order gate: any rail edit refused all orders
    // for 48 hours. The edit waits; the portfolio does not.
    await drawdown(2);
    await proposeRailChange(db, 'max_order_paise', 50_00_000, NOW);
    await expect(draft()).resolves.toBeDefined();
    await db.close();
  });
});
