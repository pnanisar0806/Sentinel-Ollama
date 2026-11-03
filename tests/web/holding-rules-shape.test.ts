import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { logHoldingRule } from '../../src/domain/holding-rules.js';
import { istDate } from '../../src/domain/sips.js';
import { db, getHoldingRules, getRuleHeldExits, getRuleSuppressions, getRulesFor } from '../../web/lib/data.js';
import { capBps } from '../../web/lib/rules.js';

/** Batch C Task 6: holding rules and Allow once on the web. */
const NOW = new Date().toISOString();
const TODAY = istDate(NOW);
const NAME = 'X Flexi Cap Direct';
const daysAgo = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

describe('holding rules on the web', () => {
  beforeAll(async () => {
    const d = await db();
    await runMigrations(d);
    await d.query(
      `insert into instruments (id, kind, name, currency, isin, metadata) values
         ('MF:X', 'MF', $1, 'INR', 'INF000X00001', '{}'),
         ('IND:X', 'MF', 'X Flexi Cap Fund', 'INR', 'INF000X00001', '{}'),
         ('MF:Y', 'MF', 'Y Fund', 'INR', 'INF000Y00001', '{}')`, [NAME]);
    await logHoldingRule(d, { on: TODAY, instrumentId: 'MF:X', kind: 'NO_ADD', note: 'enough' }, NOW);
    const until = `${Number(TODAY.slice(0, 4)) + 1}${TODAY.slice(4, 8)}01`;
    await logHoldingRule(d, { on: TODAY, instrumentId: 'MF:Y', kind: 'HOLD_UNTIL', untilOn: until, note: '' }, NOW);
    await d.query(
      `insert into suppressed_actions (logged_on, action, reason, suppressed_by) values
         ($1, 'satellite:BUY:MF:X', 'your no new money rule on X', 'HOLDING_RULE'),
         ($1, 'satellite:BUY:MF:Z', 'FR-12 monthly cap', 'FR-12'),
         ($2, 'satellite:BUY:MF:OLD', 'your no new money rule on old', 'HOLDING_RULE')`, [TODAY, daysAgo(61)]);
    await d.query(
      `insert into exit_candidates (month, instrument_id, trigger_code, action, evidence, ips_clause_refs, overrides_minimum_hold,
         held_months, blocked_by_minimum_hold, amount_paise, as_of, source)
       values ($1, 'MF:Y', 'underperformance', 'SELL', 'trailed its benchmark 4 quarters', '["6.5"]', false, 30, false, 100000, $2, 'sell-triggers')`,
      [TODAY.slice(0, 7), TODAY]);
  });

  it('getHoldingRules returns the active rules with the fund name', async () => {
    const rules = await getHoldingRules();
    expect(rules.map((r) => [r.name, r.kind])).toEqual([[NAME, 'NO_ADD'], ['Y Fund', 'HOLD_UNTIL']]);
  });

  it('getRulesFor binds a rule to every alias of its fund', async () => {
    const m = await getRulesFor(['IND:X', 'MF:Y', 'MF:NONE']);
    expect(m.get('IND:X')!.map((r) => r.kind)).toEqual(['NO_ADD']);
    expect(m.get('MF:Y')!.map((r) => r.kind)).toEqual(['HOLD_UNTIL']);
    expect(m.get('MF:NONE')).toBeUndefined();
  });

  it('getRuleSuppressions returns HOLDING_RULE rows of the last 60 days only', async () => {
    expect(await getRuleSuppressions()).toEqual([{ on: TODAY, action: 'satellite:BUY:MF:X', reason: 'your no new money rule on X' }]);
  });

  it('getRuleHeldExits returns exits a hold-until rule holds back, with evidence', async () => {
    const held = await getRuleHeldExits();
    expect(held.map((e) => [e.instrumentId, e.evidence, e.heldByRule !== null])).toEqual([['MF:Y', 'trailed its benchmark 4 quarters', true]]);
  });
});

describe('capBps', () => {
  it('maps percent text to bps exactly', () => {
    expect(capBps('12.5')).toBe(1250);
    expect(capBps('10')).toBe(1000);
    expect(capBps(' 0.01 ')).toBe(1);
    expect(capBps('100')).toBe(10000);
  });
  it('refuses more than two decimals, zero and over 100', () => {
    for (const bad of ['12.345', '0', '0.00', '101', '100.01', '', 'abc', '-5', '1e2']) expect(() => capBps(bad)).toThrow();
  });
});
