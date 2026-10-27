import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { approveMix, proposeMix, RANGE_TABLE } from '../../src/domain/fund-mix.js';
import { db, getFundCandidates } from '../../web/lib/data.js';

/** Piece 3 Task 7: what /advisor's "Fund candidates this month" card renders. */
describe('getFundCandidates', () => {
  it('unsigned: not approved; signed with no funds held: every new-money type is below midpoint, nothing to buy', async () => {
    const d = await db();
    await runMigrations(d);
    expect(await getFundCandidates()).toEqual({ approved: false, buys: [], typesBelowMidpoint: [], excluded: [] });

    const now = new Date().toISOString();
    const p = proposeMix(now);
    if (p.band === null) throw new Error('fixture expects a proposal');
    await approveMix(d, { band: p.band }, now);
    const r = await getFundCandidates();
    expect(r.approved).toBe(true);
    expect(r.buys).toEqual([]);
    expect(r.typesBelowMidpoint).toEqual(RANGE_TABLE[p.band].filter((x) => x.newMoney && x.maxBps > 0).map((x) => x.type));
    await d.close();
  });
});
