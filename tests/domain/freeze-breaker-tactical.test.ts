import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { createOrder } from '../../src/domain/orders.js';
import {
  buildRecommendation, persistRecommendation, type Recommendation,
} from '../../src/domain/recommendations.js';
import { recordFalsification, setFreeze } from '../../src/domain/rails.js';

/**
 * FR-32: `/freeze` halts drafting. FR-33: three consecutive approved recommendations
 * hitting their falsification conditions puts the advisor in report-only until
 * `/reset_breaker`.
 *
 * Both states were stored, both were rendered on `/cleanup`, and neither was ever
 * consulted — `checkFreeze` and `getBreakerState` had no caller anywhere in the
 * codebase. A control that is displayed but not enforced is worse than one that is
 * absent, because it reads as protection.
 */
let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

const rec = (over: { amountPaise?: string; createdOn?: string; instrumentId?: string } = {}): Recommendation =>
  buildRecommendation({
    kind: 'satellite',
    createdOn: over.createdOn ?? '2026-09-20',
    primary: {
      intent: 'add to the position',
      // FR-12's repeat-BUY hold blocks a second recommendation on the SAME name inside
      // twelve months, so a test of the MONTHLY BUDGET must spend across names.
      instrumentId: over.instrumentId ?? 'NSE:RPOWER',
      action: 'BUY',
      amountPaise: over.amountPaise ?? '100000',
      thesis: 'a thesis of adequate length for the validator to accept it without fuss',
      ipsClauseRefs: ['3.3'],
      falsification: null,
    },
    sameIntentAlternates: [],
    engineEvidence: {},
    paperMode: true,
  });

const order = async (r: Recommendation) => {
  const persisted = await persistRecommendation(db, r);
  return createOrder(db, { recommendationId: persisted.id!, recommendation: r, createdBy: 'advisor' });
};

describe('FREEZE halts drafting (FR-32)', () => {
  it('refuses a new order while frozen', async () => {
    await setFreeze(db, true, 'owner typed /freeze');
    await expect(order(rec())).rejects.toThrow(/FREEZE active/);
    await db.close();
  });

  it('allows drafting again once unfrozen', async () => {
    await setFreeze(db, true, 'owner typed /freeze');
    await setFreeze(db, false, '');
    await expect(order(rec())).resolves.toBeDefined();
    await db.close();
  });
});

describe('the falsification breaker makes the advisor report-only (FR-33)', () => {
  it('drafts normally below three consecutive falsifications', async () => {
    await recordFalsification(db, 'NSE:RPOWER', 'first');
    await recordFalsification(db, 'NSE:RPOWER', 'second');
    await expect(order(rec())).resolves.toBeDefined();
    await db.close();
  });

  it('refuses to draft once three have tripped', async () => {
    await recordFalsification(db, 'NSE:RPOWER', 'first');
    await recordFalsification(db, 'NSE:RPOWER', 'second');
    await recordFalsification(db, 'NSE:RPOWER', 'third');
    await expect(order(rec())).rejects.toThrow(/FR-33.*report-only/s);
    await db.close();
  });
});

describe('the tactical monthly budget is cumulative (FR-12)', () => {
  it('adds up the month rather than judging one order at a time', async () => {
    // The rail is Rs 50,000/month. Three Rs 20,000 buys all passed before, because
    // `getTacticalUsedThisMonth` returned 0n and only the single order was measured.
    await order(rec({ amountPaise: '2000000', instrumentId: 'NSE:RPOWER' }));
    await order(rec({ amountPaise: '2000000', instrumentId: 'NSE:LIQUIDBEES' }));
    await expect(order(rec({ amountPaise: '2000000', instrumentId: 'NSE:GOLDBEES' })))
      .rejects.toThrow(/TACTICAL_BUDGET_EXCEEDED/);
    await db.close();
  });

  it('counts only the current month', async () => {
    // Stamped directly, because `order_intents.as_of` is `now()` — the month is the
    // one the ORDER was placed in, which is what FR-12 caps.
    const old = await persistRecommendation(db, rec({ instrumentId: 'NSE:GOLDBEES' }));
    await db.query(
      `insert into order_intents
         (recommendation_id, intent, instrument_id, quantity, order_type, payload_snapshot,
          expires_at, advisory_path, as_of, source, created_by, status, current_revision)
       values ($1, 'BUY', 'NSE:GOLDBEES', 4000000, 'MARKET', '{}'::jsonb,
               now() + interval '7 days', true, now() - interval '60 days',
               'advisor', 'advisor', 'DRAFT', 1)`,
      [old.id],
    );
    // A fresh month is a fresh Rs 50,000 — this is a budget, not a running total.
    await expect(order(rec({ amountPaise: '4000000' }))).resolves.toBeDefined();
    await db.close();
  });

  it('releases the budget an order gave back when it was rejected', async () => {
    const first = await order(rec({ amountPaise: '4000000' }));
    await db.query(
      `insert into order_transitions
         (order_intent_id, revision_number, expected_revision, from_status, to_status,
          actor, at, payload_snapshot)
       values ($1, 1, 1, 'PENDING_APPROVAL', 'REJECTED', 'owner', now(), '{}'::jsonb)`,
      [first.id],
    );
    // A rejected order deployed nothing, so it must not hold the budget hostage.
    await expect(order(rec({ amountPaise: '4000000', instrumentId: 'NSE:LIQUIDBEES' })))
      .resolves.toBeDefined();
    await db.close();
  });

  it('does not count a SELL against a deployment budget', async () => {
    await order(rec({ amountPaise: '4000000' }));
    const sell = buildRecommendation({
      kind: 'sell',
      createdOn: '2026-09-20',
      primary: {
        intent: 'trim the employer cap breach',
        instrumentId: 'US:NOW',
        action: 'SELL',
        amountPaise: '9000000',
        thesis: 'employer concentration is past its cap and the excess should come back',
        ipsClauseRefs: ['3.5'],
        falsification: null,
      },
      sameIntentAlternates: [],
      engineEvidence: {},
      paperMode: true,
    });
    // FR-12 caps deployment. A sale returns money; counting it would make selling
    // into a breach impossible precisely when the portfolio needs it.
    await order(sell);
    await expect(order(rec({ amountPaise: '1000000', instrumentId: 'NSE:LIQUIDBEES' })))
      .resolves.toBeDefined();
    await db.close();
  });
});
