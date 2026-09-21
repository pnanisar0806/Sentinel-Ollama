import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { checkRails } from '../../src/domain/rails.js';
import { buildRecommendation, type Recommendation } from '../../src/domain/recommendations.js';
import { concentration } from '../../src/domain/allocation.js';
import { createOrder } from '../../src/domain/orders.js';
import { persistRecommendation } from '../../src/domain/recommendations.js';
import { loadPositions } from '../../src/domain/networth.js';

/**
 * `checkRails` is the per-order rail gate: MAX_ORDER_EXCEEDED, TACTICAL_BUDGET_EXCEEDED,
 * FORBIDDEN_UNIVERSE, HOLD_PERIOD, OVERRIDE_INVALID, COOLING_NOT_ELAPSED and the drawdown
 * codes all live behind it.
 *
 * It had **zero production callers and has never successfully executed**: its
 * forbidden-universe query selected `instrument_id` from `instruments`, whose primary key
 * is `id`, so every call threw `column "instrument_id" does not exist` before reaching any
 * later check. Nothing noticed, because nothing called it.
 */
const rec = (over: Partial<Parameters<typeof buildRecommendation>[0]['primary']> = {}): Recommendation =>
  buildRecommendation({
    kind: 'rebalance',
    createdOn: '2026-09-20',
    primary: {
      intent: 'buy gold to restore the band',
      instrumentId: 'NSE:GOLDBEES',
      action: 'BUY',
      amountPaise: '1000000',
      thesis: 'gold sits under its IPS floor',
      ipsClauseRefs: ['3.3'],
      falsification: null,
      ...over,
    },
    sameIntentAlternates: [],
    engineEvidence: {},
    paperMode: true,
  });

describe('checkRails runs at all', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
  });

  it('does not throw — the whole gate was unreachable behind a bad column name', async () => {
    await expect(checkRails(db, rec())).resolves.toBeDefined();
    await db.close();
  });

  it('reaches the order-level checks past the forbidden-universe query', async () => {
    // MAX_ORDER_EXCEEDED sits AFTER the forbidden query, so it firing proves the whole
    // function now executes rather than aborting early.
    const codes = (await checkRails(db, rec({ amountPaise: '20000000' }))).map((v) => v.code);
    expect(codes).toContain('MAX_ORDER_EXCEEDED');
    await db.close();
  });

  it('flags an instrument marked forbidden in metadata', async () => {
    await db.query(
      `update instruments set metadata = '{"forbidden":"true"}'::jsonb where id = 'NSE:GOLDBEES'`,
    );
    const codes = (await checkRails(db, rec())).map((v) => v.code);
    expect(codes).toContain('FORBIDDEN_UNIVERSE');
    await db.close();
  });

  it('leaves a non-forbidden instrument alone', async () => {
    const codes = (await checkRails(db, rec())).map((v) => v.code);
    expect(codes).not.toContain('FORBIDDEN_UNIVERSE');
    await db.close();
  });

  it('reads the per-order ceiling from settings_rails, not from a literal', async () => {
    await db.query(`update settings_rails set value = '2000000' where key = 'max_order_paise'`);
    // Rs 50,000 is under the seeded Rs 1,00,000 rail and over the Rs 20,000 one just set.
    const codes = (await checkRails(db, rec({ amountPaise: '5000000' }))).map((v) => v.code);
    expect(codes).toContain('MAX_ORDER_EXCEEDED');
    await db.close();
  });
});

/**
 * The seeded portfolio stands in breach three ways, all of them US:NOW (single-stock,
 * employer, single-issuer). `checkRails` used to report every one of those on every
 * order, so wiring it into the order gate would have refused everything — including the
 * SELL that clears the breach. What a per-order gate owes the owner is the marginal
 * effect: what does THIS order do.
 */
describe('concentration is judged at the margin, not on the standing portfolio', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
  });

  const codesFor = async (over: Parameters<typeof rec>[0]) =>
    (await checkRails(db, rec(over))).map((v) => v.code);

  it('the standing breaches are real — the rest of this block would be vacuous otherwise', async () => {
    const breaches = concentration(await loadPositions(db)).breaches;
    expect(breaches.some((b) => b.startsWith('Single-stock cap: US:NOW'))).toBe(true);
    expect(breaches.some((b) => b.startsWith('Employer cap: US:NOW'))).toBe(true);
    expect(breaches.some((b) => b.startsWith('Single-issuer cap: ServiceNow'))).toBe(true);
    await db.close();
  });

  it('does not block an unrelated order on a breach the portfolio already had', async () => {
    expect(await codesFor({})).not.toContain('CONCENTRATION_BREACH');
    await db.close();
  });

  it('blocks a BUY that adds to an already-capped name', async () => {
    const codes = await codesFor({ instrumentId: 'US:NOW' });
    expect(codes).toContain('CONCENTRATION_BREACH');
    await db.close();
  });

  it('does not block the SELL that would clear the breach', async () => {
    const codes = await codesFor({ instrumentId: 'US:NOW', action: 'SELL' });
    expect(codes).not.toContain('CONCENTRATION_BREACH');
    await db.close();
  });

  it('blocks a BUY that would CREATE a breach the portfolio does not have yet', async () => {
    // US:INDMONEY-BASKET sits at 3.0% of a Rs 45.2L portfolio and breaches nothing today.
    // Rs 5L into it lands at 12.7%, past the 10% single-stock cap. A filter that merely
    // passed through pre-existing breaches naming the instrument would miss this.
    const details = (await checkRails(db, rec({
      instrumentId: 'US:INDMONEY-BASKET', amountPaise: '50000000',
    }))).filter((v) => v.code === 'CONCENTRATION_BREACH').map((v) => v.detail);
    expect(details.join(' | ')).toContain('US:INDMONEY-BASKET');
    await db.close();
  });
});

/**
 * The point of the exercise: `createOrder` must actually refuse an order the rails
 * forbid. Before this, `validateOrderGate` checked freshness and FR-11/12 structure and
 * called that "rails" in its comment — an order ten times the owner's per-order ceiling
 * was created without a word.
 */
describe('the order gate enforces the rails', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
  });

  const order = async (r: Recommendation) => {
    const persisted = await persistRecommendation(db, r);
    return createOrder(db, { recommendationId: persisted.id!, recommendation: r, createdBy: 'advisor' });
  };

  const buy = (over: Parameters<typeof rec>[0] = {}) =>
    rec({ instrumentId: 'NSE:RPOWER', amountPaise: '100000', ...over });

  it('creates an ordinary order — the gate must not refuse everything', async () => {
    await expect(order(buy())).resolves.toMatchObject({ status: 'PENDING_APPROVAL' });
    await db.close();
  });

  it('refuses an order over the per-order ceiling', async () => {
    // Rs 2,00,000 against the owner's Rs 1,00,000 rail.
    await expect(order(buy({ amountPaise: '20000000' })))
      .rejects.toThrow(/Rails refused this order.*MAX_ORDER_EXCEEDED/s);
    await db.close();
  });

  it('refuses an order in the forbidden universe', async () => {
    await db.query(
      `update instruments set metadata = '{"forbidden":"true"}'::jsonb where id = 'NSE:RPOWER'`,
    );
    await expect(order(buy())).rejects.toThrow(/FORBIDDEN_UNIVERSE/);
    await db.close();
  });

  it('enforces FR-12 on the SECOND buy of a name, never on the first', async () => {
    // The recommendation an order implements is not prior to itself. When it was treated
    // as one, the gate refused every order the moment it was wired in.
    await expect(order(buy())).resolves.toBeDefined();

    const twoMonthsLater = { ...buy(), createdOn: '2026-11-17' };
    await expect(order(twoMonthsLater)).rejects.toThrow(/HOLD_PERIOD/);
    await db.close();
  });
});
