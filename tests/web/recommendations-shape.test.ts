import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { db, getRecommendations } from '../../web/lib/data.js';

/**
 * `primary_rec` and `alternates` are `text` columns holding `JSON.stringify(RecLeg)` and
 * `JSON.stringify(RecLeg[])`, not display strings. The /recommendations page shipped
 * treating them as strings and crashed in production with React error #31, "objects are
 * not valid as a React child", naming the exact RecLeg keys.
 *
 * The getter must hand the page parsed objects so the page renders fields rather than
 * the value itself.
 */
describe('getRecommendations column shapes', () => {
  it('parses primary_rec into an object and alternates into an array of legs', async () => {
    const d = await db();
    await runMigrations(d);

    const primary = {
      intent: 'route the redemption',
      instrumentId: 'BOND:TEST-2026',
      action: 'REDEEM',
      amountPaise: '32700000',
      thesis: 'principal returns and has to land somewhere the IPS allows',
      ipsClauseRefs: ['3.3', '3.9'],
      falsification: null,
    };
    const alternates = [
      { ...primary, intent: 'alternate one', action: 'BUY' },
      { ...primary, intent: 'alternate two', action: 'HOLD', instrumentId: null, amountPaise: null },
    ];

    await d.query(
      `insert into recommendations
         (created_on, kind, intent, primary_rec, alternates, ips_clause_refs, engine_evidence, source)
       values ('2026-09-20', 'maturity_routing', 'test intent', $1, $2, $3, '{}', 'advisor')`,
      [JSON.stringify(primary), JSON.stringify(alternates), JSON.stringify(['3.3', '3.9'])],
    );

    const rows = await getRecommendations();
    const row = rows.find((r) => r.intent === 'test intent');
    expect(row, 'inserted recommendation should come back').toBeDefined();

    // The decisive assertions: a string here is what crashed the page.
    expect(typeof row!.primary).toBe('object');
    expect(Array.isArray(row!.alternates)).toBe(true);

    expect(row!.primary).toMatchObject({ action: 'REDEEM', instrumentId: 'BOND:TEST-2026' });
    expect(row!.alternates).toHaveLength(2);

    // amountPaise crosses JSON as a decimal string and the page does BigInt(...) on it.
    const leg = row!.primary as { amountPaise: string | null };
    expect(() => BigInt(leg.amountPaise!)).not.toThrow();

    await d.close();
  });
});
