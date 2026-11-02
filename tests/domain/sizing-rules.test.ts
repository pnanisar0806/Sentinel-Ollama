import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { HoldingRule } from '../../src/domain/holding-rules.js';
import type { SizingInput } from '../../src/domain/sizing.js';

/** Batch C final fix 1: the monthly advisor's candidates honour holding rules, as the gate does at signing. */
vi.mock('../../src/domain/mf-switch.js', () => ({ evaluateSwitches: vi.fn(async () => []) }));
const { sizeCandidates } = await import('../../src/domain/sizing.js');
const { loadSizingInput, makeRuleCheck } = await import('../../src/domain/sizing-input.js');
const { logHoldingRule, logRuleException } = await import('../../src/domain/holding-rules.js');

const AS_OF = '2026-10-30';
const rule = (over: Partial<HoldingRule> = {}): HoldingRule => ({
  id: '7', instrumentId: 'IND:A', name: 'A Mid Cap Fund', kind: 'NO_ADD', untilOn: null, capBps: null, note: '', on: '2026-10-01',
  aliases: ['IND:A', 'MF:A'], exceptions: [], ...over,
});
type FundBuy = SizingInput['funds']['buys'][number];
const fund = (instrumentId: string, gapBps: number): FundBuy => ({
  instrumentId, name: instrumentId, kind: 'MF', fundType: 'MID', gapBps, actualBps: 2500 - gapBps, midBps: 2500, minBps: 2000, maxBps: 3000, heldPaise: 0n, quality: 'q',
});
const ALIASES = new Map([['MF:A', ['MF:A', 'IND:A']], ['MF:B', ['MF:B']]]);
const check = (rules: HoldingRule[]) => makeRuleCheck(rules, '2026-10', ALIASES, [], 500_000_000n);
const base = (over: Partial<SizingInput> & { rules?: HoldingRule[] } = {}): SizingInput => ({
  asOf: AS_OF, tacticalBudgetPaise: 5_000_000n, envelopeReason: null, maxOrderPaise: 10_000_000n, cashAvailablePaise: 20_000_000n,
  reservedPaise: 0n, portfolioPaise: 500_000_000n, singleStockCapPct: 10, holdings: [], quotes: new Map(), buys: [], sells: [],
  funds: { approved: true, buys: [fund('MF:A', 2000), fund('MF:B', 500)], typesBelowMidpoint: ['MID'], excluded: [] },
  singleSchemeCapPct: 35,
  ...over,
  ruleCheck: check(over.rules ?? [rule()]),
});

describe('holding rules in monthly sizing (pure)', () => {
  it('a ruled fund candidate is withheld with the rule and its id; the tranche goes to the next fund', () => {
    const [a, b] = sizeCandidates(base());
    expect(a).toMatchObject({ instrumentId: 'MF:A', status: 'WITHHELD', withheldReason: 'your no new money rule on A Mid Cap Fund', amountPaise: null, ruleId: '7' });
    expect(b).toMatchObject({ instrumentId: 'MF:B', status: 'ELIGIBLE', amountPaise: 5_000_000n });
    expect(b!.ruleId).toBeUndefined();
  });

  it('a month exception makes it eligible and says so; a lump-sum exception does not', () => {
    const lumpOnly = sizeCandidates(base({ rules: [rule({ exceptions: [{ id: '9', month: null, lumpSumId: '3' }] })] }));
    expect(lumpOnly[0]).toMatchObject({ status: 'WITHHELD', ruleId: '7' });
    const [a, b] = sizeCandidates(base({ rules: [rule({ exceptions: [{ id: '9', month: '2026-10', lumpSumId: null }] })] }));
    expect(a).toMatchObject({ instrumentId: 'MF:A', status: 'ELIGIBLE', amountPaise: 5_000_000n });
    expect(a!.ruleId).toBeUndefined();
    expect(a!.constraints).toEqual(['your no new money rule on A Mid Cap Fund waived for Oct 2026, by you']);
    expect(b).toMatchObject({ status: 'WITHHELD' });
  });

  it('a stock buy under a rule is withheld too', () => {
    const out = sizeCandidates(base({
      funds: { approved: true, buys: [], typesBelowMidpoint: [], excluded: [] },
      buys: [{ instrumentId: 'MF:A', name: 'A', kind: 'MF', score: 90 }],
    }));
    expect(out[0]).toMatchObject({ status: 'WITHHELD', ruleId: '7', withheldReason: 'your no new money rule on A Mid Cap Fund' });
  });

  it('a sale of a fund held until a date is withheld; with no rules nothing changes', () => {
    const hold = rule({ kind: 'HOLD_UNTIL', untilOn: '2030-03-31' });
    const sells: SizingInput['sells'] = [{ instrumentId: 'MF:A', name: 'A', kind: 'MF', action: 'SELL', amountPaise: null, blockedByMinimumHold: false, reason: 'falsified' }];
    const holdings = [{ instrumentId: 'MF:A', valuePaise: 1_000_000n, units: null, kind: 'MF', costKnown: true }];
    const funds = { approved: true, buys: [], typesBelowMidpoint: [], excluded: [] };
    expect(sizeCandidates(base({ rules: [hold], sells, holdings, funds }))[0])
      .toMatchObject({ action: 'SELL', status: 'WITHHELD', withheldReason: 'your hold until Mar 2030 rule on A Mid Cap Fund', ruleId: '7' });
    expect(sizeCandidates(base({ rules: [], sells, holdings, funds }))[0]).toMatchObject({ action: 'SELL', status: 'ELIGIBLE' });
  });
});

describe('loadSizingInput loads the rules (DB)', () => {
  let db: Db;
  afterEach(async () => { await db.close(); });

  it('a HOLD_UNTIL exit is withheld through the alias; a month exception for the IST month is seen', async () => {
    db = await openDb();
    await runMigrations(db);
    const NOW = '2026-10-30T06:00:00Z';
    const [snap] = await db.query<{ id: string }>(`insert into snapshots (business_date, source) values (date '2026-10-20', 'indmoney') returning id`);
    await db.query(`insert into instruments (id, kind, name, currency, isin) values ('MF:A', 'MF', 'A Mid Cap Direct', 'INR', 'INF179K01XQ0'),
      ('IND:A', 'MF', 'A Mid Cap Fund', 'INR', 'INF179K01XQ0')`);
    for (const [id, paise] of [['MF:A', 9_000_000], ['IND:A', 1_000_000]] as const) {
      await db.query(`insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
        values ($1, $2, 'indmoney', 1, $3, 'indmoney', timestamptz '2026-10-20T12:00:00Z')`, [snap!.id, id, paise]);
    }
    await db.query(`insert into exit_candidates (month, instrument_id, trigger_code, action, evidence, ips_clause_refs, overrides_minimum_hold, held_months, blocked_by_minimum_hold, as_of, source)
      values ('2026-10', 'MF:A', 'underperformance', 'SELL', 'lagging', '[]', false, 30, false, date '2026-10-30', 'test')`);
    const { id: ruleId } = await logHoldingRule(db, { on: AS_OF, instrumentId: 'IND:A', kind: 'HOLD_UNTIL', untilOn: '2030-03-31', note: '' }, NOW);

    const input = await loadSizingInput(db, AS_OF, new Date(NOW));
    const sell = sizeCandidates(input).find((c) => c.action === 'SELL' && c.instrumentId === 'MF:A');
    expect(sell).toMatchObject({ status: 'WITHHELD', ruleId, withheldReason: 'your hold until Mar 2030 rule on A Mid Cap Fund' });

    await logRuleException(db, { ruleId, month: '2026-10', note: 'sell it this month' }, NOW);
    const allowed = sizeCandidates(await loadSizingInput(db, AS_OF, new Date(NOW))).find((c) => c.action === 'SELL' && c.instrumentId === 'MF:A');
    expect(allowed).toMatchObject({ status: 'ELIGIBLE' });
    expect(allowed!.constraints).toContain('your hold until Mar 2030 rule on A Mid Cap Fund waived for Oct 2026, by you');
  });
});
