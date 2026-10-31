import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { SwitchCandidate } from '../../src/domain/mf-switch.js';

/** Batch C Task 5: a holding rule withholds a lump-sum part; its money flows to the next pick. */
const switches: SwitchCandidate[] = [];
vi.mock('../../src/domain/mf-switch.js', () => ({ evaluateSwitches: vi.fn(async () => switches) }));

const { approveMix } = await import('../../src/domain/fund-mix.js');
const { allocateLumpSum, loadLumpSizingInput, sizeLumpSum } = await import('../../src/domain/lump-sizing.js');
const { logLumpSum } = await import('../../src/domain/owner-log.js');
const { logHoldingRule, logRuleException } = await import('../../src/domain/holding-rules.js');

const MID = 'Equity Scheme - Mid Cap Fund';
const NOW = '2026-10-30T06:00:00Z';
const AS_OF = '2026-10-30';
const LUMP = 2_069_100n;
const SIZED = 2_000_000n; // the ₹20,000 max order rail binds below the lump sum

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  switches.length = 0;
  const [snap] = await db.query<{ id: string }>(`insert into snapshots (business_date, source) values (date '2026-10-20', 'indmoney') returning id`);
  // Nifty 50 at 60%, Flexi 22%, two mid cap funds at 9% each: both mid funds are below the Mid max.
  for (const [id, name, isin, rupees] of [
    ['MF:IDX', 'ICICI Pru Nifty 50 Index Direct', 'INF109K012M7', 600_000],
    ['MF:PPFC', 'Parag Parikh Flexi Cap Direct', 'INF879O01027', 220_000],
    ['MF:A', 'A Mid Cap Direct', 'INF179K01XQ0', 90_000],
    ['MF:B', 'B Mid Cap Direct', 'INF247L01445', 90_000],
  ] as const) {
    await db.query(`insert into instruments (id, kind, name, currency, isin) values ($1, 'MF', $2, 'INR', $3)`, [id, name, isin]);
    await db.query(
      `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
       values ($1, $2, 'indmoney', 1, $3, 'indmoney', timestamptz '2026-10-20T12:00:00Z')`, [snap!.id, id, BigInt(rupees) * 100n]);
  }
  // The IND row of fund A: same ISIN, so a rule logged on it binds MF:A.
  await db.query(`insert into instruments (id, kind, name, currency, isin) values ('IND:A', 'MF', 'A Mid Cap Fund', 'INR', 'INF179K01XQ0')`);
  // ₹10L in the bank so free cash never binds.
  await db.query(`insert into instruments (id, kind, name, currency) values ('CASH:T', 'CASH', 'Bank', 'INR')`);
  await db.query(`insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
    values ($1, 'CASH:T', 'x', 1, 100000000, 'manual-seed', timestamptz '2026-10-20T12:00:00Z')`, [snap!.id]);
  await approveMix(db, { band: '15+' }, NOW);
  for (const [id, rank] of [['MF:A', 1], ['MF:B', 2]] as const) {
    switches.push({ heldInstrumentId: id, heldName: id, heldComposite: 50, heldRank: rank, category: MID, cohortSize: 10,
      challengerId: null, challengerName: null, challengerComposite: null, edge: null, reason: '' });
  }
});
afterEach(async () => { await db.close(); });

describe('holding rules in lump-sum sizing', () => {
  it('a no-new-money rule withholds the part; the money goes to the next pick; a lump exception allows it', async () => {
    const { id: lumpId } = await logLumpSum(db, { receivedOn: '2026-10-28', amountPaise: LUMP, from: 'Edelweiss bond interest' }, NOW);
    const { id: ruleId } = await logHoldingRule(db, { on: AS_OF, instrumentId: 'IND:A', kind: 'NO_ADD', note: 'enough mid cap A' }, NOW);

    const input = await loadLumpSizingInput(db, lumpId, AS_OF, new Date(NOW));
    expect(input.month).toBe('2026-10');
    expect(input.rules.map((r) => r.id)).toEqual([ruleId]);
    const out = sizeLumpSum(input);
    const first = out.find((c) => c.instrumentId === 'MF:A')!;
    const second = out.find((c) => c.instrumentId === 'MF:B')!;
    expect(first).toMatchObject({ status: 'WITHHELD', withheldReason: 'your no new money rule on A Mid Cap Fund', amountPaise: null, ruleId });
    expect(second).toMatchObject({ status: 'ELIGIBLE', amountPaise: SIZED });
    expect(second.ruleId).toBeUndefined();
    const parts = allocateLumpSum(out, [first.id, second.id], input.remainingPaise);
    expect(parts.map((p) => [p.candidate.instrumentId, p.amountPaise])).toEqual([['MF:B', SIZED]]);

    // A month exception does not cover a lump sum; a lump-scoped one does, and is recorded.
    await logRuleException(db, { ruleId, month: '2026-10', note: 'this month only' }, NOW);
    expect(sizeLumpSum(await loadLumpSizingInput(db, lumpId, AS_OF, new Date(NOW))).find((c) => c.instrumentId === 'MF:A'))
      .toMatchObject({ status: 'WITHHELD', ruleId });
    const { id: exId } = await logRuleException(db, { ruleId, lumpSumId: lumpId, note: 'bond interest, fine' }, NOW);
    const allowed = sizeLumpSum(await loadLumpSizingInput(db, lumpId, AS_OF, new Date(NOW))).find((c) => c.instrumentId === 'MF:A')!;
    expect(allowed).toMatchObject({ status: 'ELIGIBLE', amountPaise: SIZED });
    expect(allowed.ruleId).toBeUndefined();
    expect(allowed.constraints).toContain(`allowed once by exception ${exId} to your no new money rule on A Mid Cap Fund`);
  });

  it('a cap rule is checked against the sized amount', async () => {
    const { id: lumpId } = await logLumpSum(db, { receivedOn: '2026-10-28', amountPaise: LUMP, from: 'Edelweiss bond interest' }, NOW);
    const input = await loadLumpSizingInput(db, lumpId, AS_OF, new Date(NOW));
    const portfolio = input.sizing.portfolioPaise;
    // Cap at A's value plus the sized part, rounded up to a whole bp: allowed. One bp lower: withheld.
    const capBps = Number(((9_000_000n + SIZED) * 10_000n + portfolio - 1n) / portfolio);
    const { id: ruleId } = await logHoldingRule(db, { on: AS_OF, instrumentId: 'MF:A', kind: 'CAP_PCT', capBps, note: '' }, NOW);
    const a = () => loadLumpSizingInput(db, lumpId, AS_OF, new Date(NOW)).then((i) => sizeLumpSum(i).find((c) => c.instrumentId === 'MF:A')!);
    expect(await a()).toMatchObject({ status: 'ELIGIBLE', amountPaise: SIZED });
    const { reverseEntry } = await import('../../src/domain/reversals.js');
    await reverseEntry(db, { entity: 'holding_rule', entityId: ruleId, reason: 'tighter' }, NOW);
    await logHoldingRule(db, { on: AS_OF, instrumentId: 'MF:A', kind: 'CAP_PCT', capBps: capBps - 1, note: '' }, NOW);
    expect(await a()).toMatchObject({ status: 'WITHHELD', withheldReason: `your cap at ${(capBps - 1) / 100}% rule on A Mid Cap Direct` });
  });
});
