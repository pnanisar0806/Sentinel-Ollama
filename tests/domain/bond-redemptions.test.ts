import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadRedemptions, recordRedemption, redemptionFor } from '../../src/domain/bond-redemptions.js';
import { loadPositions } from '../../src/domain/networth.js';
import { listRedemptionsUntil } from '../../src/domain/redemptions.js';
import { draftPendingOrders } from '../../src/domain/order-drafting.js';
import { buildRecommendation, persistRecommendation } from '../../src/domain/recommendations.js';

/**
 * Sammaan 9% 26-Sep-2026 was credited to the owner's bank on 2026-09-24 while the live
 * feed still listed the bond. Until the owner's confirmation was recorded, the next run
 * would have drafted a REDEEM approval for money already received, the digest kept
 * counting down to the maturity, and net worth held the same ₹3L twice.
 */
let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

const BOND = 'BOND:SAMMAAN-2026';
const record = () => recordRedemption(db, BOND, { receivedOn: '2026-09-24', amountPaise: null });

describe('recording a redemption', () => {
  it('is idempotent', async () => {
    expect(await record()).toBe(true);
    expect(await record()).toBe(false);
    expect((await loadRedemptions(db)).size).toBe(1);
    await db.close();
  });

  it('keeps the amount unknown until the owner states it, never 0', async () => {
    await record();
    expect((await redemptionFor(db, BOND))!.amountPaise).toBeNull();
    await db.close();
  });

  it('is found under any id that shares the canonical id', async () => {
    const [row] = await db.query<{ canonical_id: string | null }>(
      `select canonical_id from instruments where id = $1`, [BOND]);
    await record();
    expect(await redemptionFor(db, BOND)).not.toBeNull();
    if (row?.canonical_id) {
      expect((await loadRedemptions(db)).has(row.canonical_id)).toBe(true);
    }
    await db.close();
  });
});

describe('a redeemed bond stops being counted', () => {
  it('drops out of positions, so the money is not counted twice', async () => {
    const before = (await loadPositions(db)).some((p) => p.instrumentId === BOND);
    expect(before, 'the seed must hold the bond, or this test proves nothing').toBe(true);
    await record();
    expect((await loadPositions(db)).some((p) => p.instrumentId === BOND)).toBe(false);
    await db.close();
  });

  it('is no longer announced as an upcoming maturity', async () => {
    const at = new Date('2026-09-20T00:00:00Z');
    expect((await listRedemptionsUntil(db, 30, at)).some((r) => r.instrumentId === BOND)).toBe(true);
    await record();
    expect((await listRedemptionsUntil(db, 30, at)).some((r) => r.instrumentId === BOND)).toBe(false);
    await db.close();
  });

  it('never becomes an approval request for money already received', async () => {
    const id = (await persistRecommendation(db, buildRecommendation({
      kind: 'maturity_routing',
      createdOn: '2026-09-21',
      primary: {
        intent: 'route the Sammaan redemption', instrumentId: BOND, action: 'REDEEM',
        amountPaise: '3000000', thesis: 'the bond matures and the proceeds route to B3',
        ipsClauseRefs: ['3.9'], falsification: null,
      },
      sameIntentAlternates: [], engineEvidence: {}, paperMode: true,
    }))).id!;
    await record();

    const report = await draftPendingOrders(db, new Date('2026-09-22T04:30:00Z'));
    expect(report.drafted).toHaveLength(0);
    expect(report.notActionable).toEqual([
      { recommendationId: id, reason: 'already redeemed — received 2026-09-24' },
    ]);
    await db.close();
  });

  it('leaves every other bond alone', async () => {
    const others = (await loadPositions(db)).filter((p) => p.kind === 'BOND' && p.instrumentId !== BOND);
    await record();
    const after = (await loadPositions(db)).filter((p) => p.kind === 'BOND');
    for (const o of others) expect(after.map((p) => p.instrumentId)).toContain(o.instrumentId);
    await db.close();
  });
});
