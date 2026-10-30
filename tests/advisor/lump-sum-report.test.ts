import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import type { SwitchCandidate } from '../../src/domain/mf-switch.js';

/**
 * Batch B §3, Task 5 fix round 1: `lumpSumAdvice`'s own allocate closure (with `lumpLimits`) is
 * what fills a split BUY. Two new funds are each sized alone at the whole lump sum, but free cash
 * is below it: only the shared limit stops the split spending money the bank does not have.
 */
const MID = 'Equity Scheme - Mid Cap Fund';
const switches: SwitchCandidate[] = [{
  heldInstrumentId: 'MF:HDFC-MIDCAP', heldName: 'MF:HDFC-MIDCAP', heldComposite: 50, heldRank: 8, category: MID, cohortSize: 10,
  challengerId: 'MFU:120505', challengerName: 'Invesco India Mid Cap Fund', challengerComposite: null, edge: null, reason: 'a better mid cap',
}];
vi.mock('../../src/domain/mf-switch.js', () => ({ evaluateSwitches: vi.fn(async () => switches) }));

const { approveMix } = await import('../../src/domain/fund-mix.js');
const { loadLumpSizingInput, lumpLimits } = await import('../../src/domain/lump-sizing.js');
const { logLumpSum } = await import('../../src/domain/owner-log.js');
const { lumpSumAdvice } = await import('../../src/jobs/report.js');

const NOW = '2026-10-30T06:00:00.000Z';
const AS_OF = '2026-10-30';
const LUMP = 2_069_100n; // ₹20,691
const BANK = 1_500_000n; // ₹15,000 in the bank: free cash binds below the lump sum

let db: Db;
beforeEach(async () => { db = await openDb(); await runMigrations(db); });
afterEach(async () => { await db.close(); });

it('a split BUY through the report is allocated within the shared limits', async () => {
  await seed(db, { asOf: '2026-08-12' });
  await db.query(`insert into instruments (id, kind, name, currency) values ('CASH:T', 'CASH', 'Bank', 'INR')`);
  await db.query(`insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
    select id, 'CASH:T', 1, $1, 'x', now(), 'manual-seed' from snapshots where source = 'manual-seed'`, [BANK.toString()]);
  await approveMix(db, { band: '15+' }, NOW);
  await db.query(
    `insert into index_fund_candidates (fund_type, indmoney_fund_id, name, benchmark_name, amfi_scheme_code,
       expense_ratio_bps, aum_paise, sip_allowed, as_of, source)
     values ('NEXT50', '1042502', 'Edelweiss Nifty Next 50 Index Fund', 'Nifty Next 50 TR INR', '149000', 20, 1000000000000, true, $1, 'indmoney-mcp')`,
    [AS_OF]);
  const { id } = await logLumpSum(db, { receivedOn: '2026-10-28', amountPaise: LUMP, from: 'Edelweiss bond interest' }, NOW);
  // One side of the comparison from the real data: the free cash the sizer itself sees.
  const freeCash = lumpLimits(await loadLumpSizingInput(db, id, AS_OF, new Date(NOW))).freeCashPaise;
  expect(freeCash < LUMP).toBe(true);

  // The model picks both new funds, Invesco first, by name from what it was shown.
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    const shown = JSON.parse(JSON.parse(init.body).messages[1].content).candidates as { candidate: { id: string; name: string } }[];
    const idOf = (name: string) => shown.find((s) => s.candidate.name === name)!.candidate.id;
    const content = JSON.stringify({
      decision: 'BUY', candidateIds: [idOf('Invesco India Mid Cap Fund'), idOf('Edelweiss Nifty Next 50 Index Fund')],
      timing: 'this_month', horizonYears: 7, rationale: 'Mid caps below range; the rest to Next 50.', keyRisk: 'r',
      falsification: 'f', counterargument: 'c', evidenceIds: [], alternates: ['WAIT'],
    });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  }) as unknown as typeof fetch;

  const line = await lumpSumAdvice(db, AS_OF, NOW, { apiKey: 'k', model: undefined, fetchImpl });
  expect(line).toBe('\n\nLump sum ₹20,691 (Edelweiss bond interest): BUY. Review it on the Advisor page.');
  const [row] = await db.query<{ payload: unknown }>(`select payload from advisor_proposals where kind = 'LUMP_SUM'`);
  const payload = (typeof row!.payload === 'string' ? JSON.parse(row!.payload) : row!.payload) as { parts: { name: string; amountPaise: string }[] };
  const total = payload.parts.reduce((s, p) => s + BigInt(p.amountPaise), 0n);
  expect(total <= LUMP).toBe(true);
  expect(total <= freeCash).toBe(true);
  // Invesco takes all the free cash; without the limit Next 50 would get the rest of the lump sum.
  expect(payload.parts.map((p) => [p.name, p.amountPaise])).toEqual([['Invesco India Mid Cap Fund', freeCash.toString()]]);
});
