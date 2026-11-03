import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { fundAliases } from '../../src/domain/fund-mix.js';
import { logLumpSum } from '../../src/domain/owner-log.js';
import { reverseEntry } from '../../src/domain/reversals.js';
import {
  loadActiveHoldingRules, logHoldingRule, logRuleException, ruleBlock, ruleLabel, type HoldingRule,
} from '../../src/domain/holding-rules.js';

/** Batch C Task 2: owner holding rules bind a fund through its aliases; an exception allows one break. */
const NOW = '2026-11-01T06:00:00Z';
const ON = '2026-11-01';
const NAME = 'X Flexi Cap Direct';
let db: Db;

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await db.query(
    `insert into instruments (id, kind, name, currency, isin, metadata) values
       ('MF:X', 'MF', $1, 'INR', 'INF000X00001', '{}'),
       ('IND:X', 'MF', 'X Flexi Cap Fund', 'INR', 'INF000X00001', '{}')`, [NAME]);
});
afterEach(async () => { await db.close(); });

const q = (over: Partial<Parameters<typeof ruleBlock>[1]> & { aliases: string[] }): Parameters<typeof ruleBlock>[1] => ({
  action: 'BUY', amountPaise: 100_000n, heldPaise: 500_000n, portfolioPaise: 10_000_000n, month: '2026-11', lumpSumId: null, ...over,
});
const rulesFor = async (r: Parameters<typeof logHoldingRule>[1]): Promise<{ id: string; rules: HoldingRule[]; aliases: string[] }> => {
  const { id } = await logHoldingRule(db, r, NOW);
  return { id, rules: await loadActiveHoldingRules(db, NOW), aliases: await fundAliases(db, 'IND:X') };
};

describe('holding rules', () => {
  it('logs and loads a rule', async () => {
    await logHoldingRule(db, { on: ON, instrumentId: 'MF:X', kind: 'NO_ADD', note: 'enough of this one' }, NOW);
    const rules = await loadActiveHoldingRules(db, NOW);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ name: NAME, kind: 'NO_ADD', untilOn: null, capBps: null, note: 'enough of this one', on: ON, exceptions: [] });
    expect(rules[0]!.aliases).toContain('IND:X');
  });

  it('binds through aliases', async () => {
    const { rules, aliases } = await rulesFor({ on: ON, instrumentId: 'MF:X', kind: 'NO_ADD', note: '' });
    expect(ruleBlock(rules, q({ aliases }))).toMatchObject({ reason: `your no new money rule on ${NAME}`, waivedBy: null });
    expect(ruleBlock(rules, q({ aliases: ['MF:OTHER'] }))).toBeNull();
  });

  it('second active rule refused', async () => {
    await logHoldingRule(db, { on: ON, instrumentId: 'MF:X', kind: 'NO_ADD', note: '' }, NOW);
    await expect(logHoldingRule(db, { on: ON, instrumentId: 'IND:X', kind: 'NO_ADD', note: '' }, NOW))
      .rejects.toThrow(`a no new money rule on ${NAME} is already active; end it first`);
    // A different kind on the same fund is fine.
    await expect(logHoldingRule(db, { on: ON, instrumentId: 'IND:X', kind: 'NO_REBUY', note: '' }, NOW)).resolves.toHaveProperty('id');
  });

  it('refuses an unknown instrument and a cap out of range', async () => {
    await expect(logHoldingRule(db, { on: ON, instrumentId: 'MF:NOPE', kind: 'NO_ADD', note: '' }, NOW)).rejects.toThrow('MF:NOPE');
    for (const capBps of [0, 10001, 12.5]) {
      await expect(logHoldingRule(db, { on: ON, instrumentId: 'MF:X', kind: 'CAP_PCT', capBps, note: '' }, NOW)).rejects.toThrow('cap');
    }
    await expect(logHoldingRule(db, { on: ON, instrumentId: 'MF:X', kind: 'CAP_PCT', note: '' }, NOW)).rejects.toThrow('cap');
  });

  it('HOLD_UNTIL needs a future date', async () => {
    await expect(logHoldingRule(db, { on: ON, instrumentId: 'MF:X', kind: 'HOLD_UNTIL', note: '' }, NOW)).rejects.toThrow('needs its date');
    for (const untilOn of ['2026-10-31', ON]) {
      await expect(logHoldingRule(db, { on: ON, instrumentId: 'MF:X', kind: 'HOLD_UNTIL', untilOn, note: '' }, NOW)).rejects.toThrow('future');
    }
    await expect(logHoldingRule(db, { on: ON, instrumentId: 'MF:X', kind: 'HOLD_UNTIL', untilOn: '2026-11-02', note: '' }, NOW)).resolves.toHaveProperty('id');
  });

  it('until is IST', async () => {
    await logHoldingRule(db, { on: ON, instrumentId: 'MF:X', kind: 'HOLD_UNTIL', untilOn: '2026-11-30', note: '' }, NOW);
    expect(await loadActiveHoldingRules(db, '2026-11-30T18:00:00Z')).toHaveLength(1);
    expect(await loadActiveHoldingRules(db, '2026-11-30T18:31:00Z')).toHaveLength(0);
  });

  it('NO_REBUY', async () => {
    const { rules, aliases } = await rulesFor({ on: ON, instrumentId: 'MF:X', kind: 'NO_REBUY', note: '' });
    expect(ruleBlock(rules, q({ aliases, heldPaise: 0n }))?.reason).toBe(`your never buy again rule on ${NAME}`);
    expect(ruleBlock(rules, q({ aliases, heldPaise: 1n }))).toBeNull();
  });

  it('cap', async () => {
    const { rules, aliases } = await rulesFor({ on: ON, instrumentId: 'MF:X', kind: 'CAP_PCT', capBps: 1000, note: '' });
    const at = (amountPaise: bigint) => ruleBlock(rules, q({ aliases, heldPaise: 9_000n, amountPaise, portfolioPaise: 100_000n }));
    expect(at(2_000n)?.reason).toBe(`your cap at 10% rule on ${NAME}`);
    expect(at(1_000n)).toBeNull();
  });

  it('cap unknown refuses', async () => {
    const { rules, aliases } = await rulesFor({ on: ON, instrumentId: 'MF:X', kind: 'CAP_PCT', capBps: 1000, note: '' });
    expect(ruleBlock(rules, q({ aliases, portfolioPaise: null }))?.reason).toContain('cap unknown');
  });

  it('SELL vs HOLD_UNTIL', async () => {
    const { rules, aliases } = await rulesFor({ on: ON, instrumentId: 'MF:X', kind: 'HOLD_UNTIL', untilOn: '2027-06-30', note: '' });
    expect(ruleBlock(rules, q({ aliases, action: 'SELL' }))?.reason).toBe(`your hold until Jun 2027 rule on ${NAME}`);
    expect(ruleBlock(rules, q({ aliases, action: 'BUY' }))).toBeNull();
  });

  it('exception scope', async () => {
    const { id: ruleId, aliases } = await rulesFor({ on: ON, instrumentId: 'MF:X', kind: 'NO_ADD', note: '' });
    const { id: lump } = await logLumpSum(db, { receivedOn: ON, amountPaise: 500_000n, from: 'bond interest' }, NOW);
    const { id: monthEx } = await logRuleException(db, { ruleId, month: '2026-11', note: 'diwali top-up' }, NOW);
    let rules = await loadActiveHoldingRules(db, NOW);
    expect(ruleBlock(rules, q({ aliases, month: '2026-11' }))?.waivedBy).toBe(monthEx);
    expect(ruleBlock(rules, q({ aliases, month: '2026-12' }))?.waivedBy).toBeNull();
    expect(ruleBlock(rules, q({ aliases, month: '2026-11', lumpSumId: lump }))?.waivedBy).toBeNull();

    const { id: lumpEx } = await logRuleException(db, { ruleId, lumpSumId: lump, note: 'bond money' }, NOW);
    rules = await loadActiveHoldingRules(db, NOW);
    expect(ruleBlock(rules, q({ aliases, month: '2026-12', lumpSumId: lump }))?.waivedBy).toBe(lumpEx);
    expect(ruleBlock(rules, q({ aliases, month: '2026-12' }))?.waivedBy).toBeNull();
  });

  it('a waived rule does not hide a second unwaived one', async () => {
    const { id: ruleId, aliases } = await rulesFor({ on: ON, instrumentId: 'MF:X', kind: 'NO_ADD', note: '' });
    await logHoldingRule(db, { on: ON, instrumentId: 'MF:X', kind: 'NO_REBUY', note: '' }, NOW);
    await logRuleException(db, { ruleId, month: '2026-11', note: 'once' }, NOW);
    const hit = ruleBlock(await loadActiveHoldingRules(db, NOW), q({ aliases, heldPaise: 0n }));
    expect(hit).toMatchObject({ waivedBy: null, rule: { kind: 'NO_REBUY' } });
  });

  it('exception refusals', async () => {
    const { id: ruleId } = await rulesFor({ on: ON, instrumentId: 'MF:X', kind: 'NO_ADD', note: '' });
    await expect(logRuleException(db, { ruleId, month: '2026-10', note: 'late' }, NOW)).rejects.toThrow();
    await expect(logRuleException(db, { ruleId, month: '2026-11', note: '  ' }, NOW)).rejects.toThrow('note');
    await expect(logRuleException(db, { ruleId, note: 'neither' }, NOW)).rejects.toThrow();
    await expect(logRuleException(db, { ruleId, lumpSumId: '00000000-0000-0000-0000-000000000000', note: 'x' }, NOW)).rejects.toThrow('lump sum');
    const { id: lump } = await logLumpSum(db, { receivedOn: ON, amountPaise: 500_000n, from: 'bond interest' }, NOW);
    await reverseEntry(db, { entity: 'lump_sum', entityId: lump, reason: 'typo' }, NOW);
    await expect(logRuleException(db, { ruleId, lumpSumId: lump, note: 'x' }, NOW)).rejects.toThrow('lump sum');
    await reverseEntry(db, { entity: 'holding_rule', entityId: ruleId, reason: 'changed my mind' }, NOW);
    await expect(logRuleException(db, { ruleId, month: '2026-11', note: 'x' }, NOW)).rejects.toThrow('not active');
  });

  it('reversed exception no longer waives', async () => {
    const { id: ruleId, aliases } = await rulesFor({ on: ON, instrumentId: 'MF:X', kind: 'NO_ADD', note: '' });
    const { id } = await logRuleException(db, { ruleId, month: '2026-11', note: 'once' }, NOW);
    await reverseEntry(db, { entity: 'holding_rule_exception', entityId: id, reason: 'no' }, NOW);
    expect(ruleBlock(await loadActiveHoldingRules(db, NOW), q({ aliases }))?.waivedBy).toBeNull();
  });

  it('reversed rule inactive', async () => {
    const { id } = await logHoldingRule(db, { on: ON, instrumentId: 'MF:X', kind: 'NO_ADD', note: '' }, NOW);
    await reverseEntry(db, { entity: 'holding_rule', entityId: id, reason: 'ended early' }, NOW);
    expect(await loadActiveHoldingRules(db, NOW)).toEqual([]);
  });

  it('labels', () => {
    expect(ruleLabel({ kind: 'CAP_PCT', untilOn: null, capBps: 1250 })).toBe('cap at 12.5%');
    expect(ruleLabel({ kind: 'HOLD_UNTIL', untilOn: '2027-01-15', capBps: null })).toBe('hold until Jan 2027');
  });
});
