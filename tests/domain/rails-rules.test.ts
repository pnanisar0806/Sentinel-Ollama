import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { checkRails } from '../../src/domain/rails.js';
import { logHoldingRule, logRuleException } from '../../src/domain/holding-rules.js';
import { istMonth } from '../../src/domain/sips.js';
import { buildRecommendation, type Recommendation } from '../../src/domain/recommendations.js';

/** Batch C Task 3: the order gate refuses an order a holding rule forbids, unless an exception covers it. */
let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});
afterEach(async () => { await db.close(); });

const rec = (): Recommendation => buildRecommendation({
  kind: 'rebalance', createdOn: '2026-09-20',
  primary: {
    intent: 'buy gold to restore the band', instrumentId: 'NSE:GOLDBEES', action: 'BUY',
    amountPaise: '1000000', thesis: 'gold sits under its IPS floor', ipsClauseRefs: ['3.3'], falsification: null,
  },
});
const codes = async (): Promise<string[]> => (await checkRails(db, rec())).map((v) => v.code);

describe('checkRails and holding rules', () => {
  it('a BUY under no-new-money carries HOLDING_RULE with the rule copy', async () => {
    expect(await codes()).not.toContain('HOLDING_RULE');
    await logHoldingRule(db, { on: '2026-08-12', instrumentId: 'NSE:GOLDBEES', kind: 'NO_ADD', note: '' });
    const v = (await checkRails(db, rec())).find((x) => x.code === 'HOLDING_RULE');
    expect(v?.detail).toMatch(/^your no new money rule on /);
  });

  it("an exception for the order's IST month lets it through", async () => {
    const now = new Date().toISOString();
    const { id } = await logHoldingRule(db, { on: '2026-08-12', instrumentId: 'NSE:GOLDBEES', kind: 'NO_ADD', note: '' }, now);
    await logRuleException(db, { ruleId: id, month: istMonth(now), note: 'once' }, now);
    expect(await codes()).not.toContain('HOLDING_RULE');
  });
});
