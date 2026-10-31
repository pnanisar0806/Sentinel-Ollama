import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { logHoldingRule, logRuleException } from '../../src/domain/holding-rules.js';
import {
  MAX_RECS_PER_MONTH,
  buildRecommendation,
  persistRecommendation,
  type RecLeg,
  type Recommendation,
} from '../../src/domain/recommendations.js';

/** Batch C Task 3: owner holding rules refuse a recommendation on ANY leg, after the FR-12 caps. */
const NOW = '2026-11-01T06:00:00Z';
const ON = '2026-11-01';
const CREATED = '2026-11-05';
let db: Db;

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});
afterEach(async () => { await db.close(); });

const leg = (over: Partial<RecLeg> = {}): RecLeg => ({
  intent: 'buy gold to restore the band',
  instrumentId: 'NSE:GOLDBEES',
  action: 'BUY',
  amountPaise: '1000000',
  thesis: 'Gold sits under its IPS floor.',
  ipsClauseRefs: ['3.3'],
  falsification: null,
  ...over,
});
const rec = (over: Partial<RecLeg> = {}, createdOn = CREATED): Recommendation =>
  buildRecommendation({ kind: 'rebalance', createdOn, primary: leg(over) });

const suppressedBy = async (): Promise<string[]> =>
  (await db.query<{ suppressed_by: string }>(`select suppressed_by from suppressed_actions order by logged_on`))
    .map((r) => r.suppressed_by);

describe('holding rules at the recommendation gate', () => {
  it('(a) refuses a BUY primary on a no-new-money fund, logged as HOLDING_RULE', async () => {
    await logHoldingRule(db, { on: ON, instrumentId: 'NSE:GOLDBEES', kind: 'NO_ADD', note: '' }, NOW);
    const r = await persistRecommendation(db, rec());
    expect(r.suppressed).toBe(true);
    expect(r.reason).toContain('your no new money rule on');
    expect(await suppressedBy()).toEqual(['HOLDING_RULE']);
  });

  it('(b) refuses when only an alternate breaks a rule — the index route into NIFTYBEES', async () => {
    const r0 = rec();
    expect(r0.alternates[0].instrumentId).toBe('NSE:NIFTYBEES');
    await logHoldingRule(db, { on: ON, instrumentId: 'NSE:NIFTYBEES', kind: 'NO_ADD', note: '' }, NOW);
    const r = await persistRecommendation(db, r0);
    expect(r.suppressed).toBe(true);
    expect(await suppressedBy()).toEqual(['HOLDING_RULE']);
  });

  it('(c) refuses a SELL under hold-until', async () => {
    await logHoldingRule(db, { on: ON, instrumentId: 'NSE:NIFTYBEES', kind: 'HOLD_UNTIL', untilOn: '2030-01-31', note: '' }, NOW);
    const r = await persistRecommendation(db, buildRecommendation({
      kind: 'sell', createdOn: CREATED,
      primary: leg({ intent: 'exit the index ETF', instrumentId: 'NSE:NIFTYBEES', action: 'SELL' }),
    }));
    expect(r.suppressed).toBe(true);
    expect(r.reason).toContain('hold until Jan 2030');
    expect(await suppressedBy()).toEqual(['HOLDING_RULE']);
  });

  it('(d) a month exception lets it through and records the waiver in engine_evidence', async () => {
    const { id: ruleId } = await logHoldingRule(db, { on: ON, instrumentId: 'NSE:GOLDBEES', kind: 'NO_ADD', note: '' }, NOW);
    const { id: exId } = await logRuleException(db, { ruleId, month: CREATED.slice(0, 7), note: 'one top-up' }, NOW);
    const r = await persistRecommendation(db, rec());
    expect(r.suppressed).toBe(false);
    const [row] = await db.query<{ w: unknown }>(
      `select engine_evidence::jsonb -> 'waivedRules' w from recommendations where id = $1`, [r.id]);
    expect(row!.w).toEqual([exId]);
    // A different month's money is not covered by it.
    expect((await persistRecommendation(db, rec({ intent: 'next month' }, '2026-12-05'))).suppressed).toBe(true);
  });

  it('(e) an FR-12 cap refusal still logs as FR-12, even on a ruled fund', async () => {
    for (let i = 0; i < MAX_RECS_PER_MONTH; i++) {
      const r = await persistRecommendation(db, rec({ intent: `idea ${i}`, instrumentId: `NSE:N${i}` }, `2026-11-0${i + 1}`));
      expect(r.suppressed).toBe(false);
    }
    await logHoldingRule(db, { on: ON, instrumentId: 'NSE:GOLDBEES', kind: 'NO_ADD', note: '' }, NOW);
    const r = await persistRecommendation(db, rec({}, '2026-11-09'));
    expect(r.suppressed).toBe(true);
    expect(r.reason).toMatch(/^FR-12:/);
    expect(await suppressedBy()).toEqual(['FR-12']);
  });
});
