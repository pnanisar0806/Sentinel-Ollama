import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { persistSipSnapshot } from '../../src/domain/sips.js';
import {
  applyDueRailChanges, BREAKER_STREAK, confirmBudget, evaluateBreaker, freeze, isLoosening, loadBudgetMonth,
  pendingRailChanges, proposeRailChange, resetBreakerWithPostMortem, RESET_PHRASE,
  sendBudgetReminder, unfreeze, UNFREEZE_PHRASE,
} from '../../src/domain/controls.js';
import { getBreakerState, getFreezeState } from '../../src/domain/rails.js';
import { BUDGET_RAIL_NAMES } from '../../src/domain/rail-values.js';
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
  // Zero SIPs synced, so the order gate's envelope is the ₹50,000 budget these tests assume.
  await persistSipSnapshot(db, [], new Date().toISOString());
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

  it('raising the goal equity ceiling is a loosening: refused above 15% drawdown', async () => {
    expect(isLoosening('goal_equity_ceiling_pct', 60, 68)).toBe(true);
    await drawdown(16);
    await expect(proposeRailChange(db, 'goal_equity_ceiling_pct', 68, NOW)).rejects.toThrow(/16%/);
    await db.close();
  });

  it('raising the goal set-aside is a tightening (it shrinks the envelope); 0 ends it, for that key only', async () => {
    expect(isLoosening('goal_setaside_monthly_paise', 0, 5000)).toBe(false);
    expect(isLoosening('goal_setaside_monthly_paise', 5000, 0)).toBe(true);
    await drawdown(25); // a tightening needs no drawdown check
    await proposeRailChange(db, 'goal_setaside_monthly_paise', 5000, NOW);
    await db.query(`update settings_rails set value = '5000'::jsonb, pending_value = null, pending_since = null
                     where key = 'goal_setaside_monthly_paise'`);
    await drawdown(2, '2026-09-24'); // ending it is a loosening: needs fresh evidence
    await expect(proposeRailChange(db, 'goal_setaside_monthly_paise', 0, NOW)).resolves.toBeDefined();
    await expect(proposeRailChange(db, 'max_order_paise', 0, NOW)).rejects.toThrow('a rail value must be a positive number');
    await expect(proposeRailChange(db, 'goal_setaside_monthly_paise', -1, NOW)).rejects.toThrow('the goal set-aside must be zero or more');
    await db.close();
  });

  it('stores the note in the RAIL_CHANGE_PROPOSED audit payload', async () => {
    await drawdown(2);
    await proposeRailChange(db, 'goal_equity_ceiling_pct', 68, NOW, 'signed goal plan 2026-10');
    const [row] = await db.query<{ payload: { note?: string; proposed: number } }>(
      `select payload from audit_log where action = 'RAIL_CHANGE_PROPOSED' and entity_id = 'goal_equity_ceiling_pct'`);
    expect(row!.payload).toMatchObject({ proposed: 68, note: 'signed goal plan 2026-10' });
    await db.close();
  });

  it('refuses a goal equity ceiling outside whole 60–92, whichever surface proposes it', async () => {
    await drawdown(2);
    for (const v of [59, 93, 68.5]) {
      await expect(proposeRailChange(db, 'goal_equity_ceiling_pct', v, NOW)).rejects.toThrow(/60–92/);
    }
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

describe('the advisor waits for the month\'s budget (until the 7th)', () => {
  const WAITING = "waiting for this month's budget (until the 7th)";
  const activated = (at: string, key = 'monthly_budget_paise') => db.query(
    `insert into audit_log (at, entity, entity_id, action, actor, payload)
     values ($1, 'rail', $2, 'RAIL_CHANGE_ACTIVATED', 'agent', '{}'::jsonb)`, [at, key]);

  it('days 1–7 (IST) without a confirmation are held', async () => {
    // 1 Nov 06:00 IST, and 7 Nov 23:59 IST.
    for (const now of ['2026-11-01T00:30:00Z', '2026-11-07T18:29:00Z']) {
      expect(await loadBudgetMonth(db, now)).toEqual({ settled: false, reason: WAITING, confirmedOn: null });
    }
    await db.close();
  });

  it('day 8 (IST) runs on the budget in force, no confirmation needed', async () => {
    expect((await loadBudgetMonth(db, '2026-11-07T18:30:00Z')).settled).toBe(true); // 8 Nov 00:00 IST
    await db.close();
  });

  it('a confirmation on the 3rd settles the month; last month\'s does not', async () => {
    await confirmBudget(db, new Date('2026-10-20T05:00:00Z'));
    expect((await loadBudgetMonth(db, '2026-11-03T06:00:00Z')).settled).toBe(false);
    await confirmBudget(db, new Date('2026-11-03T05:00:00Z'));
    expect(await loadBudgetMonth(db, '2026-11-03T06:00:00Z'))
      .toEqual({ settled: true, reason: null, confirmedOn: '2026-11-03' });
    const [row] = await db.query<{ actor: string; payload: { budgetPaise: string } }>(
      `select actor, payload from audit_log where entity = 'budget' and entity_id = '2026-11' and action = 'BUDGET_CONFIRMED'`);
    expect(row).toMatchObject({ actor: 'owner', payload: { budgetPaise: '5000000' } });
    await db.close();
  });

  it('a confirmation at 2026-10-31T20:00Z is 1 Nov IST and counts for November', async () => {
    await confirmBudget(db, new Date('2026-10-31T20:00:00Z'));
    expect(await loadBudgetMonth(db, '2026-11-02T05:00:00Z'))
      .toEqual({ settled: true, reason: null, confirmedOn: '2026-11-01' });
    await db.close();
  });

  it('a budget change activated on the 2nd settles the month; one in October does not', async () => {
    await activated('2026-10-20T05:00:00Z');
    expect((await loadBudgetMonth(db, '2026-11-03T06:00:00Z')).settled).toBe(false);
    await activated('2026-11-02T05:00:00Z');
    expect(await loadBudgetMonth(db, '2026-11-03T06:00:00Z'))
      .toEqual({ settled: true, reason: null, confirmedOn: '2026-11-02' });
    await db.close();
  });

  it('an activation at 2026-10-31T20:00Z is 1 Nov IST and counts for November', async () => {
    await activated('2026-10-31T20:00:00Z');
    expect((await loadBudgetMonth(db, '2026-11-02T05:00:00Z')).settled).toBe(true);
    await db.close();
  });

  it('another rail\'s activation does not settle the month', async () => {
    await activated('2026-11-02T05:00:00Z', 'max_order_paise');
    expect((await loadBudgetMonth(db, '2026-11-03T06:00:00Z')).settled).toBe(false);
    await db.close();
  });

  it('a budget change pending on the 8th holds the advisor, even with a confirmation', async () => {
    await confirmBudget(db, new Date('2026-11-03T05:00:00Z'));
    await proposeRailChange(db, 'monthly_budget_paise', 40_00_000, new Date('2026-11-07T06:00:00Z'));
    expect(await loadBudgetMonth(db, '2026-11-08T05:00:00Z')).toEqual({
      settled: false, reason: 'a budget change activates 2026-11-09 11:30 IST', confirmedOn: null,
    });
    await db.close();
  });

  it('a pending tactical change holds too', async () => {
    await proposeRailChange(db, 'tactical_monthly_paise', 40_00_000, new Date('2026-11-07T06:00:00Z'));
    expect((await loadBudgetMonth(db, '2026-11-08T05:00:00Z')).reason).toMatch(/^a tactical cap change activates /);
    await db.close();
  });

  it('a pending goal set-aside change holds too, and the reason names it (it moves the envelope)', async () => {
    await proposeRailChange(db, 'goal_setaside_monthly_paise', 20_00_000, new Date('2026-11-07T06:00:00Z'));
    expect(await loadBudgetMonth(db, '2026-11-08T05:00:00Z')).toEqual({
      settled: false, reason: 'a goal set-aside change activates 2026-11-09 11:30 IST', confirmedOn: null,
    });
    await db.close();
  });

  it('a pending change on another rail does not hold', async () => {
    await proposeRailChange(db, 'max_order_paise', 50_00_000, new Date('2026-11-07T06:00:00Z'));
    expect((await loadBudgetMonth(db, '2026-11-08T05:00:00Z')).settled).toBe(true);
    await db.close();
  });
});

describe('the budget reminder', () => {
  const reminders = async () => (await db.query(
    `select entity_id from audit_log where entity = 'budget' and action = 'REMINDER_SENT'`)).map((r) => r.entity_id);
  const tg = () => {
    const sent: string[] = [];
    return { sent, send: async (m: string) => { sent.push(m); return { sent: true }; } };
  };

  it('is sent once per month; a second run that day sends nothing', async () => {
    const t = tg();
    expect(await sendBudgetReminder(db, new Date('2026-11-01T00:30:00Z'), t)).toBe(true);
    expect(await sendBudgetReminder(db, new Date('2026-11-01T09:00:00Z'), t)).toBe(false);
    expect(await sendBudgetReminder(db, new Date('2026-11-02T00:30:00Z'), t)).toBe(false);
    expect(t.sent).toEqual(["Set this month's budget by the 7th: keep ₹50,000 or change it on Overview."]);
    expect(await reminders()).toEqual(['2026-11']);
    await db.close();
  });

  it('is not sent once the month is settled, or after the 7th', async () => {
    const t = tg();
    await confirmBudget(db, new Date('2026-11-01T00:10:00Z'));
    expect(await sendBudgetReminder(db, new Date('2026-11-01T00:30:00Z'), t)).toBe(false);
    expect(await sendBudgetReminder(db, new Date('2026-12-08T00:30:00Z'), t)).toBe(false);
    expect(t.sent).toEqual([]);
    await db.close();
  });

  it('is not sent while any BUDGET_RAIL_NAMES change (budget, tactical, set-aside) is pending, and writes no marker', async () => {
    // Pin the set-aside: dropping it from the shared list would otherwise also drop it from this loop.
    expect(Object.keys(BUDGET_RAIL_NAMES)).toContain('goal_setaside_monthly_paise');
    for (const key of Object.keys(BUDGET_RAIL_NAMES)) {
      const t = tg();
      await proposeRailChange(db, key, 40_00_000, new Date('2026-10-31T06:00:00Z')); // a tightening: no drawdown check
      expect(await sendBudgetReminder(db, new Date('2026-11-01T00:30:00Z'), t)).toBe(false);
      expect(t.sent).toEqual([]);
      expect(await reminders()).toEqual([]);
      await db.query(`update settings_rails set pending_value = null, pending_since = null where key = $1`, [key]);
    }
    await db.close();
  });

  it('a failed or dry-run send never throws and leaves no marker, so tomorrow retries', async () => {
    const boom = { send: async () => { throw new Error('Telegram down'); } };
    expect(await sendBudgetReminder(db, new Date('2026-11-01T00:30:00Z'), boom)).toBe(false);
    const dry = { send: async () => ({ sent: false }) };
    expect(await sendBudgetReminder(db, new Date('2026-11-01T00:30:00Z'), dry)).toBe(false);
    expect(await sendBudgetReminder(db, new Date('2026-11-01T00:30:00Z'), null)).toBe(false);
    expect(await reminders()).toEqual([]);
    await db.close();
  });
});
