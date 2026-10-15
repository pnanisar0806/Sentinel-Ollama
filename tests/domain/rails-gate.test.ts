import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { checkPortfolioRails, checkRails } from '../../src/domain/rails.js';
import { buildRecommendation, type Recommendation } from '../../src/domain/recommendations.js';
import { concentration } from '../../src/domain/allocation.js';
import { createOrder, deferOrder, getOrder, modifyOrder } from '../../src/domain/orders.js';
import { persistRecommendation } from '../../src/domain/recommendations.js';
import { loadPositions } from '../../src/domain/networth.js';
import { istDate, loadFreeEnvelope, loadMonthSpend, persistSipSnapshot } from '../../src/domain/sips.js';
import { logPurchase } from '../../src/domain/owner-log.js';
import { netWorth } from '../../src/domain/networth.js';
import { parseMfSips } from '../../src/sources/indmoney.js';

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
    await seed(db, { asOf: '2026-08-12' });    // Zero SIPs synced: the envelope is the ₹50,000 these tests were written against.
    await persistSipSnapshot(db, [], new Date().toISOString());
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

const live = parseMfSips({
  result: JSON.stringify(JSON.parse(await readFile('tests/fixtures/indmoney-mf-sips-2026-10-14.json', 'utf8')).payload),
});

/**
 * Since 2026-10-15 the monthly cap is the free envelope: the owner's budget minus the
 * live SIPs, inside the tactical rail. SIPs already spend part of the budget every
 * month, so a ₹50k tactical rail on top of them would let the owner deploy twice.
 */
describe('the tactical cap is the free envelope', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
  });

  const tactical = async (r: Recommendation) =>
    (await checkRails(db, r)).find((v) => v.code === 'TACTICAL_BUDGET_EXCEEDED');

  it('measures a BUY against budget minus live SIPs', async () => {
    await persistSipSnapshot(db, live, new Date().toISOString());
    // Seeded budget is ₹50,000 and the fixture's SIPs are under it, so the envelope is the
    // budget less the SIPs (the ₹50,000 tactical rail does not bind).
    const envelope = 50_00_000n - live.reduce((s, r) => s + r.amountPaise, 0n);
    expect(envelope > 0n && envelope < 50_00_000n).toBe(true);

    const over = await tactical(rec({ amountPaise: String(envelope + 100n) }));
    expect(over?.detail).toMatch(/budget ₹.*SIPs ₹/);
    expect(await tactical(rec({ amountPaise: String(envelope) }))).toBeUndefined();
    await db.close();
  });

  it("measures a BUY against what remains after this month's logged purchases, naming spent and remaining", async () => {
    const now = new Date().toISOString();
    await persistSipSnapshot(db, live, now);
    const envelope = (await loadFreeEnvelope(db, now)).envelopePaise!;
    const spent = 500_000n; // ₹5,000 bought outside Sentinel today
    await logPurchase(db, { boughtOn: istDate(now), description: 'Zerodha Gold ETF', amountPaise: spent }, now);
    const remaining = envelope - spent;

    const over = await tactical(rec({ amountPaise: String(remaining + 100n) }));
    expect(over?.detail).toMatch(/budget ₹.*SIPs ₹.*spent ₹5,000.*remaining ₹/);
    expect(await tactical(rec({ amountPaise: String(remaining) }))).toBeUndefined();
    await db.close();
  });

  it('the portfolio check reports a month whose spend is past the envelope', async () => {
    const now = new Date().toISOString();
    await persistSipSnapshot(db, live, now);
    const envelope = (await loadFreeEnvelope(db, now)).envelopePaise!;
    const positions = await loadPositions(db);
    const tactical = async () => (await checkPortfolioRails(db, positions, netWorth(positions, 0n as never).assetsPaise))
      .find((v) => v.code === 'TACTICAL_BUDGET_EXCEEDED');
    await logPurchase(db, { boughtOn: istDate(now), description: 'Gold ETF', amountPaise: envelope }, now);
    expect(await tactical()).toBeUndefined(); // exactly the envelope is not a breach
    await logPurchase(db, { boughtOn: istDate(now), description: 'Gold ETF', amountPaise: 100n }, now);
    expect((await tactical())?.detail).toMatch(/spent/);
    await db.close();
  });

  it('refuses a BUY when the SIP commitment is unknown', async () => {
    expect((await tactical(rec({ amountPaise: '100000' })))?.detail).toMatch(/never synced/);
    await db.close();
  });

  it('never measures a SELL, even with the SIP commitment unknown', async () => {
    expect(await tactical(rec({ instrumentId: 'US:NOW', action: 'SELL', amountPaise: '9000000' }))).toBeUndefined();
    await db.close();
  });
});

/**
 * Final fix M3. Re-gating an EXISTING order (a modify, or a deferred order resurfacing) must
 * not count that order against itself: its open quantity is already inside this month's
 * spend, and adding its amount again refused a legitimate order. A modify is measured at its
 * new amount, once; spend reads the latest revision's quantity, not the original.
 */
describe('re-gating an existing order counts it once', () => {
  let db: Db;
  let envelope: bigint;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
    const now = new Date().toISOString();
    await persistSipSnapshot(db, live, now);
    envelope = (await loadFreeEnvelope(db, now)).envelopePaise!;
  });

  // RPOWER: the rebalance's GOLDBEES is concentration-capped on the seeded book.
  const order = async (amount: bigint) => {
    const r = rec({ instrumentId: 'NSE:RPOWER', amountPaise: amount.toString() });
    const persisted = await persistRecommendation(db, r);
    return createOrder(db, { recommendationId: persisted.id!, recommendation: r, createdBy: 'advisor' });
  };

  it('a deferred order inside the envelope passes the gate again (the resurface re-gate)', async () => {
    // `resurfaceDeferredOrder` re-gates with `excludeOrderIntentId: order.id`; this is that call.
    // (The function itself cannot be reached end to end today: it reads `defer_until` from the
    // order row, which `deferOrder` never writes — see the final-fix report.)
    const amount = (envelope * 3n) / 4n; // fits once, not twice
    expect(2n * amount > envelope).toBe(true);
    const o = await order(amount);
    await deferOrder(db, o.id, { idempotencyKey: `d:${o.id}`, actor: 'owner', deferUntil: '2020-01-01' });
    expect((await loadMonthSpend(db, new Date().toISOString())).ordersPaise).toBe(amount); // the premise: it is spend
    const r = rec({ instrumentId: 'NSE:RPOWER', amountPaise: amount.toString() });
    const tactical = async (opts: Parameters<typeof checkRails>[2]) =>
      (await checkRails(db, r, opts)).find((v) => v.code === 'TACTICAL_BUDGET_EXCEEDED');
    expect(await tactical({})).toBeDefined(); // counted against itself, it is refused
    expect(await tactical({ excludeOrderIntentId: o.id })).toBeUndefined();
    await db.close();
  });

  it('a modify is measured at its new amount, once, and spend then reads the revision', async () => {
    const o = await order(envelope / 3n);
    const raised = (envelope * 3n) / 4n; // old + new > envelope; new alone fits
    expect(envelope / 3n + raised > envelope).toBe(true);
    await modifyOrder(db, o.id, { idempotencyKey: `m:${o.id}`, actor: 'owner', quantity: raised.toString() });
    expect((await loadMonthSpend(db, new Date().toISOString())).ordersPaise).toBe(raised);
    await db.close();
  });

  it('two transitions at the same instant: the gate and the order state read the same one', async () => {
    const o = await order(envelope / 2n);
    const at = '2030-01-01T00:00:00Z'; // after the create transition, identical for both rows
    const ins = (id: string, to: string) => db.query(
      `insert into order_transitions (id, order_intent_id, revision_number, from_status, to_status, actor, at, payload_snapshot, expected_revision)
       values ($1, $2, 1, 'PENDING_APPROVAL', $3, 'owner', $4, '{}'::jsonb, 1)`, [id, o.id, to, at]);
    await ins('ffffffff-ffff-4fff-bfff-ffffffffffff', 'REJECTED');
    await ins('00000000-0000-4000-8000-000000000000', 'APPROVED');
    expect((await getOrder(db, o.id))!.status).toBe('REJECTED');
    expect((await loadMonthSpend(db, new Date().toISOString())).ordersPaise).toBe(0n); // released, as the state says
    await db.close();
  });

  it('a modify past the envelope is still refused: the exclusion is the order itself, not the month', async () => {
    const o = await order(envelope / 4n);
    await expect(modifyOrder(db, o.id, { idempotencyKey: `m:${o.id}`, actor: 'owner', quantity: (envelope + 100n).toString() }))
      .rejects.toThrow(/TACTICAL_BUDGET_EXCEEDED/);
    // And another order's spend still counts against it: o's quarter plus three quarters and ₹1.
    const other = await order(envelope / 2n);
    await expect(modifyOrder(db, other.id, { idempotencyKey: `m:${other.id}`, actor: 'owner', quantity: ((envelope * 3n) / 4n + 100n).toString() }))
      .rejects.toThrow(/TACTICAL_BUDGET_EXCEEDED/);
    await db.close();
  });
});
