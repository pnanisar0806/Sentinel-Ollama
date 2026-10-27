import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { approveMix, proposeMix } from '../../src/domain/fund-mix.js';
import { db, getFundMix } from '../../web/lib/data.js';

/** Piece 3 Task 5: what /funds "Fund mix: target vs actual" renders. Unknown stays null, never 0. */
describe('getFundMix', () => {
  it('no signed row: every target is null; no funds held: every actual is null', async () => {
    const d = await db();
    await runMigrations(d);
    const r = await getFundMix();
    expect(r.signed).toBeNull();
    expect(r.newProposal).toBe(false);
    expect(r.rows).toHaveLength(7);
    for (const row of r.rows) {
      expect(row.target).toBeNull();
      expect(row.actualBps).toBeNull();
      expect(row.status).toBeNull();
      // Held is unknown too, never ₹0, while no equity fund value is known.
      expect(row.valuePaise).toBeNull();
    }

    // Once signed, every target is the signed range.
    const p = proposeMix(new Date().toISOString());
    if (p.band === null) throw new Error('fixture expects a proposal');
    await approveMix(d, { band: p.band }, new Date().toISOString());
    const s = await getFundMix();
    expect(s.rows.map((x) => x.target)).toEqual(s.rows.map((x) => p.ranges.find((q) => q.type === x.type)));
    await d.close();
  });
});
