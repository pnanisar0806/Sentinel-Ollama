import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import {
  buildRecommendation, persistRecommendation, type RecLeg,
} from '../../src/domain/recommendations.js';
import { draftAnnouncement, draftPendingOrders, notActionableReason } from '../../src/domain/order-drafting.js';
import { computeMarketExpiry } from '../../src/domain/orders.js';
import { setFreeze } from '../../src/domain/rails.js';

/**
 * FR-20: every actionable recommendation becomes an approval request. `createOrder` had
 * zero production callers, so nothing ever did — and the Phase 2 DoD's "owner completes
 * ≥5 approval-flow interactions" could not even begin.
 */
let db: Db;
const NOW = new Date('2026-09-22T04:30:00Z'); // Tue 10:00 IST, the daily job's slot

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

const leg = (over: Partial<RecLeg> = {}): RecLeg => ({
  intent: 'deploy surplus into the core index',
  instrumentId: 'NSE:GOLDBEES',
  action: 'BUY',
  amountPaise: '1000000',
  thesis: 'gold sits under its IPS floor and the monthly surplus restores it',
  ipsClauseRefs: ['3.3'],
  falsification: null,
  ...over,
});

const persist = async (primary: Partial<RecLeg> = {}, createdOn = '2026-09-21', kind = 'rebalance' as const) =>
  (await persistRecommendation(db, buildRecommendation({
    kind, createdOn, primary: leg(primary), sameIntentAlternates: [], engineEvidence: {}, paperMode: true,
  }))).id!;

describe('drafting approval requests from recommendations', () => {
  it('turns an actionable recommendation into a pending approval', async () => {
    const id = await persist();
    const report = await draftPendingOrders(db, NOW);
    expect(report.drafted).toHaveLength(1);
    expect(report.drafted[0]!.recommendationId).toBe(id);
    expect(report.drafted[0]!.status).toBe('PENDING_APPROVAL');
    // No broker in Phase 2: the owner executes and the system records it.
    expect(report.drafted[0]!.advisoryPath).toBe(true);
    await db.close();
  });

  it('drafts each recommendation once, however often the job runs', async () => {
    await persist();
    await draftPendingOrders(db, NOW);
    const second = await draftPendingOrders(db, NOW);
    expect(second.drafted).toHaveLength(0);
    const [n] = await db.query<{ n: string }>(`select count(*) as n from order_intents`);
    expect(Number(n!.n)).toBe(1);
    await db.close();
  });

  it('makes one approval of two identical recommendations', async () => {
    // The weekly report once ran twice on 2026-09-20 and wrote every recommendation
    // twice; production holds two identical Sammaan maturity routings. A repeated BUY is
    // already stopped by FR-12's repeat-BUY hold, but a REDEEM is not.
    const redeem = { instrumentId: 'BOND:SAMMAAN-2026', action: 'REDEEM' as const, amountPaise: '3000000' };
    const a = await persist(redeem, '2026-09-20', 'maturity_routing' as never);
    // persistRecommendation no longer stores a copy, so write the legacy one directly.
    const [copy] = await db.query<{ id: string }>(
      `insert into recommendations (created_on, kind, intent, primary_rec, alternates, ips_clause_refs, engine_evidence, source)
       select created_on, kind, intent, primary_rec, alternates, ips_clause_refs, engine_evidence, source
         from recommendations where id = $1 returning id`, [a]);
    const b = Number(copy!.id);
    expect(a).not.toBe(b);
    const report = await draftPendingOrders(db, NOW);
    expect(report.drafted).toHaveLength(1);
    expect(report.duplicates).toEqual([b]);
    await db.close();
  });

  it('does not draft a HOLD — the default answer needs no approval', async () => {
    const id = await persist({ action: 'HOLD', amountPaise: null });
    const report = await draftPendingOrders(db, NOW);
    expect(report.drafted).toHaveLength(0);
    expect(report.notActionable.map((x) => x.recommendationId)).toEqual([id]);
    await db.close();
  });

  it('reports a leg with no instrument instead of throwing', async () => {
    // What the rebalance engine emits today: "BUY equity" at the asset-class level.
    const id = await persist({ instrumentId: null });
    const report = await draftPendingOrders(db, NOW);
    expect(report.notActionable).toEqual([
      { recommendationId: id, reason: 'BUY names no instrument, so there is nothing to order' },
    ]);
    await db.close();
  });

  it('records a rail refusal instead of creating an invalid draft', async () => {
    // FR-30: "a draft violating a rail cannot exist"; refusals are auditable.
    const id = await persist({ amountPaise: '20000000' }); // Rs 2L, over the Rs 1L rail
    const report = await draftPendingOrders(db, NOW);
    expect(report.drafted).toHaveLength(0);
    expect(report.refused[0]!.recommendationId).toBe(id);
    expect(report.refused[0]!.reason).toMatch(/MAX_ORDER_EXCEEDED/);
    const audit = await db.query<{ n: string }>(
      `select count(*) as n from audit_log where entity = 'order_draft' and action = 'DRAFT_REFUSED'`,
    );
    expect(Number(audit[0]!.n)).toBe(1);
    const [orders] = await db.query<{ n: string }>(`select count(*) as n from order_intents`);
    expect(Number(orders!.n)).toBe(0);
    await db.close();
  });

  it('drafts nothing while frozen, and says why', async () => {
    await persist();
    await setFreeze(db, true, 'owner typed /freeze');
    const report = await draftPendingOrders(db, NOW);
    expect(report.drafted).toHaveLength(0);
    expect(report.refused[0]!.reason).toMatch(/FREEZE/);
    await db.close();
  });

  it('leaves a recommendation older than a week alone', async () => {
    await persist({}, '2026-09-01');
    expect((await draftPendingOrders(db, NOW)).drafted).toHaveLength(0);
    await db.close();
  });
});

describe('the announcement', () => {
  it('says nothing when nothing was drafted', () => {
    expect(draftAnnouncement({ drafted: [], refused: [], notActionable: [], duplicates: [] })).toBeNull();
  });

  it('points at the web app first, since the Telegram bot runs only locally', async () => {
    await persist();
    const report = await draftPendingOrders(db, NOW);
    const text = draftAnnouncement(report)!;
    expect(text).toContain(report.drafted[0]!.id);
    expect(text).toContain('web app');
    expect(text).toContain('/approve <id>');
    expect(text).toContain('PAPER');
    await db.close();
  });
});

describe('notActionableReason', () => {
  it('passes a named instrument with a real action', () => {
    expect(notActionableReason(leg())).toBeNull();
    expect(notActionableReason(leg({ action: 'REDEEM' }))).toBeNull();
  });
});

/**
 * FR-22: a market approval expires at the end of the trading day. This was 15:30 UTC —
 * 21:00 IST — and ignored the calendar, so a weekend draft expired before any session.
 */
describe('market-order expiry', () => {
  it('is 15:30 IST on the same day before the close', async () => {
    expect((await computeMarketExpiry(db, new Date('2026-09-22T04:30:00Z'))).toISOString())
      .toBe('2026-09-22T10:00:00.000Z');
    await db.close();
  });

  it('rolls to the next session after the close', async () => {
    // Tuesday 16:00 IST -> Wednesday's close.
    expect((await computeMarketExpiry(db, new Date('2026-09-22T10:30:00Z'))).toISOString())
      .toBe('2026-09-23T10:00:00.000Z');
    await db.close();
  });

  it('skips the weekend', async () => {
    // Saturday 2026-09-19 -> Monday 2026-09-21.
    expect((await computeMarketExpiry(db, new Date('2026-09-19T06:00:00Z'))).toISOString())
      .toBe('2026-09-21T10:00:00.000Z');
    await db.close();
  });

  it('skips a seeded NSE holiday', async () => {
    // Friday 2026-10-02 is Gandhi Jayanti; Thursday evening rolls past it to Monday.
    expect((await computeMarketExpiry(db, new Date('2026-10-01T12:00:00Z'))).toISOString())
      .toBe('2026-10-05T10:00:00.000Z');
    await db.close();
  });

  it('uses the IST date, not the UTC one', async () => {
    // 01:00 IST Tuesday is still Monday in UTC; the expiry is Tuesday's close.
    expect((await computeMarketExpiry(db, new Date('2026-09-21T19:30:00Z'))).toISOString())
      .toBe('2026-09-22T10:00:00.000Z');
    await db.close();
  });
});
