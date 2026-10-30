import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadMonthSpend, persistSipSnapshot } from '../../src/domain/sips.js';
import { recordProposal, loadProposals } from '../../src/advisor/proposals.js';
import { logLumpSum } from '../../src/domain/owner-log.js';
import { loadLumpSum } from '../../src/domain/lump-sums.js';
import { reverseEntry } from '../../src/domain/reversals.js';
import { modifyOrder } from '../../src/domain/orders.js';
import { signLumpSum, dismissLumpSum } from '../../src/domain/lump-handoff.js';
import { fundIntent } from '../../src/domain/advisor-handoff.js';
import { buildRecommendation, persistRecommendation } from '../../src/domain/recommendations.js';
import { draftPendingOrders } from '../../src/domain/order-drafting.js';
import type { LumpLimits } from '../../src/domain/lump-sizing.js';
import type { Candidate } from '../../src/domain/sizing.js';

/**
 * Batch B §3, Task 6: signing a lump-sum split. Each part becomes an ordinary recommendation
 * linked to the lump sum (FR-12 applies part by part) and an approval request; its orders
 * spend the lump sum, never the month.
 */
let db: Db;
const NOW = new Date('2026-10-30T10:00:00Z');
// Lump sum ₹1,00,000: the fund part alone (₹54,000) is above the month's ₹50,000 envelope on purpose.
const LUMP = 10_000_000n;

const ppfc = (over: Partial<Candidate> = {}): Candidate => ({
  id: 'c-ppfc', action: 'BUY', instrumentId: 'MF:PPFC', name: 'Parag Parikh Flexi Cap Direct', status: 'ELIGIBLE', withheldReason: null,
  amountPaise: 5_400_000n, units: null, pricePaise: null, quoteAsOf: null, basis: 'min(lump sum left …)', constraints: [], policyVersion: 'lump-v1',
  vehicle: 'FUND', fund: { fundType: 'FLEXI', actualBps: 1200, midBps: 2000, minBps: 1500, maxBps: 2500, quality: 'rank 2 of 11' },
  ...over,
});
const bajaj = (over: Partial<Candidate> = {}): Candidate => ({
  id: 'c-bajaj', action: 'BUY', instrumentId: 'NSE:BAJAJ-AUTO', name: 'Bajaj Auto', status: 'ELIGIBLE', withheldReason: null,
  amountPaise: 4_512_400n, units: '4', pricePaise: 1_128_100n, quoteAsOf: '2026-10-29', basis: 'b', constraints: [], policyVersion: 'lump-v1',
  vehicle: 'STOCK', fund: null,
  ...over,
});
const limits: LumpLimits = { freeCashPaise: 100_000_000n, typeRoomPaise: { FLEXI: 100_000_000n }, goldRoomPaise: null };

const advise = (lumpSumId: string, payload: object = {}) => recordProposal(db, {
  kind: 'LUMP_SUM', inputSnapshot: {}, evidenceIds: [], model: 'm', promptVersion: 'lump-v1', schemaVersion: 'lump-schema-v1', asOf: NOW.toISOString(),
  payload: {
    decision: 'BUY', lumpSumId, timing: 'this_month', horizonYears: 5,
    rationale: 'Fill the flexi-cap gap, then add a durable franchise.', keyRisk: 'Demand slowdown.', falsification: 'ROCE below 15%.',
    counterargument: 'EV risk.', alternates: ['WAIT'], whyNotFund: 'The fund gap is filled first.',
    parts: [
      { candidateId: 'c-ppfc', instrumentId: 'MF:PPFC', name: 'Parag Parikh Flexi Cap Direct', amountPaise: '5400000', units: null, basis: 'x' },
      { candidateId: 'c-bajaj', instrumentId: 'NSE:BAJAJ-AUTO', name: 'Bajaj Auto', amountPaise: '4512400', units: '4', basis: 'b' },
    ],
    ...payload,
  },
});

let lumpId: string;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
  // Zero SIPs synced: the month's envelope is the ₹50,000 budget.
  await persistSipSnapshot(db, [], new Date().toISOString());
  await db.query(`insert into instruments (id, kind, name, currency) values ('NSE:BAJAJ-AUTO', 'EQUITY', 'Bajaj Auto', 'INR') on conflict do nothing`);
  lumpId = (await logLumpSum(db, { receivedOn: '2026-10-28', amountPaise: LUMP, from: 'Edelweiss bond interest' }, NOW.toISOString())).id;
});
afterEach(async () => { await db.close(); });

describe('signing a lump-sum split', () => {
  it('signing a two-part split makes two recommendations linked to the lump sum', async () => {
    const id = await advise(lumpId);
    const monthBefore = await loadMonthSpend(db, new Date().toISOString());
    const r = await signLumpSum(db, id, { candidates: [ppfc(), bajaj()], limits, now: NOW });
    expect(r.recommendationIds).toHaveLength(2);
    expect(r.refused).toEqual([]);
    const rows = await db.query<{ kind: string; lump_sum_id: string; primary_rec: string }>(
      `select kind, lump_sum_id::text, primary_rec from recommendations where id = any($1::int[]) order by id`, [r.recommendationIds]);
    expect(rows.map((x) => x.lump_sum_id)).toEqual([lumpId, lumpId]);
    expect(rows.map((x) => x.kind)).toEqual(['rebalance', 'satellite']);
    expect(rows.map((x) => JSON.parse(x.primary_rec).amountPaise)).toEqual(['5400000', '4512400']);
    // Both orders drafted, though the fund order alone exceeds the month's ₹50,000 envelope: the lump sum is on top of it.
    expect(await db.query(`select 1 from order_intents where recommendation_id = any($1::int[])`, [r.recommendationIds])).toHaveLength(2);
    expect((await loadLumpSum(db, lumpId))!.remainingPaise).toBe(LUMP - 5_400_000n - 4_512_400n);
    expect(await loadMonthSpend(db, new Date().toISOString())).toEqual(monthBefore);
    expect((await loadProposals(db, 'LUMP_SUM'))[0]!.status).toBe('SIGNED');
  });

  it('a part in a fund the month already topped up is its own recommendation and order', async () => {
    // This month's own top-up of the same fund, already an approval request.
    const month = await persistRecommendation(db, buildRecommendation({
      kind: 'rebalance', createdOn: NOW.toISOString().slice(0, 10),
      primary: { intent: fundIntent('FLEXI'), instrumentId: 'MF:PPFC', action: 'BUY', amountPaise: '100000', thesis: 'the month', ipsClauseRefs: ['3.4'], falsification: null },
    }));
    await draftPendingOrders(db, NOW);
    expect(await db.query(`select 1 from order_intents where recommendation_id = $1`, [month.id])).toHaveLength(1);
    const r = await signLumpSum(db, await advise(lumpId), { candidates: [ppfc(), bajaj()], limits, now: NOW });
    expect(r.recommendationIds).not.toContain(month.id);
    expect(await db.query(`select 1 from order_intents where recommendation_id = any($1::int[])`, [r.recommendationIds])).toHaveLength(2);
  });

  it('a stale size refuses the whole split', async () => {
    const id = await advise(lumpId);
    // Fresh sizing gives the fund a smaller ceiling than when the advice was given.
    await expect(signLumpSum(db, id, { candidates: [ppfc({ amountPaise: 2_000_000n }), bajaj()], limits, now: NOW }))
      .rejects.toThrow('the size has changed since this advice was given — it is re-advised at the next weekly report');
    expect(await db.query(`select 1 from recommendations`)).toHaveLength(0);
    // Closed so the weekly report re-advises it (an open BUY would block re-advice for ever).
    expect((await loadProposals(db, 'LUMP_SUM'))[0]!.status).toBe('DISMISSED');
  });

  it('a split larger than what is left of the lump sum is refused whole', async () => {
    // A purchase paid from the lump sum since the advice: ₹10,000 left, the split wants ₹99,124.
    await db.query(
      `insert into owner_purchases (bought_on, description, amount_paise, lump_sum_id, as_of, source)
       values ('2026-10-29', 'outside', $1, $2, now(), 'owner-web')`, [(LUMP - 1_000_000n).toString(), lumpId]);
    const id = await advise(lumpId);
    await expect(signLumpSum(db, id, { candidates: [ppfc(), bajaj()], limits, now: NOW })).rejects.toThrow(/size has changed/);
    expect(await db.query(`select 1 from recommendations`)).toHaveLength(0);
  });

  it('an FR-12 refusal of one part keeps the other', async () => {
    // Bajaj Auto was recommended two months ago: a stock is inside the 12-month hold.
    await db.query(
      `insert into recommendations (created_on, kind, intent, primary_rec, alternates, ips_clause_refs, engine_evidence, source)
       values ('2026-08-27', 'satellite', 'add satellite equity exposure', $1, '[]', '[]', '{}', 'advisor')`,
      [JSON.stringify({ intent: 'add satellite equity exposure', instrumentId: 'NSE:BAJAJ-AUTO', action: 'BUY', amountPaise: '100', thesis: 't', ipsClauseRefs: ['3.4'], falsification: null })]);
    const id = await advise(lumpId);
    const r = await signLumpSum(db, id, { candidates: [ppfc(), bajaj()], limits, now: NOW });
    expect(r.recommendationIds).toHaveLength(1);
    expect(r.refused).toEqual([{ name: 'Bajaj Auto', reason: expect.stringMatching(/12-month hold/) }]);
    expect((await loadProposals(db, 'LUMP_SUM'))[0]!.status).toBe('SIGNED');
  });

  it('every part refused leaves the advice open and says why', async () => {
    await db.query(
      `insert into recommendations (created_on, kind, intent, primary_rec, alternates, ips_clause_refs, engine_evidence, source)
       values ('2026-08-27', 'satellite', 'add satellite equity exposure', $1, '[]', '[]', '{}', 'advisor')`,
      [JSON.stringify({ intent: 'add satellite equity exposure', instrumentId: 'NSE:BAJAJ-AUTO', action: 'BUY', amountPaise: '100', thesis: 't', ipsClauseRefs: ['3.4'], falsification: null })]);
    const id = await advise(lumpId, { parts: [{ candidateId: 'c-bajaj', instrumentId: 'NSE:BAJAJ-AUTO', name: 'Bajaj Auto', amountPaise: '4512400', units: '4', basis: 'b' }] });
    await expect(signLumpSum(db, id, { candidates: [bajaj()], limits, now: NOW })).rejects.toThrow(/^not signed: Bajaj Auto: FR-12/);
    expect((await loadProposals(db, 'LUMP_SUM'))[0]!.status).toBe('OPEN');
  });

  it('a reversed lump sum cannot be signed', async () => {
    const id = await advise(lumpId);
    await reverseEntry(db, { entity: 'lump_sum', entityId: lumpId, reason: 'logged twice' }, NOW.toISOString());
    await expect(signLumpSum(db, id, { candidates: [ppfc(), bajaj()], limits, now: NOW })).rejects.toThrow(`no open lump sum ${lumpId}`);
    expect((await loadProposals(db, 'LUMP_SUM'))[0]!.status).toBe('OPEN');
  });

  it('signs a WAIT with nothing to order, and dismissal needs a reason', async () => {
    const wait = await advise(lumpId, { decision: 'WAIT', parts: [] });
    const r = await signLumpSum(db, wait, { candidates: [], limits, now: NOW });
    expect(r).toMatchObject({ recommendationIds: [], refused: [] });
    expect(await db.query(`select 1 from recommendations`)).toHaveLength(0);
    const buy = await advise(lumpId);
    await expect(dismissLumpSum(db, buy, ' ')).rejects.toThrow(/say why/);
    await dismissLumpSum(db, buy, 'not now');
    expect((await loadProposals(db, 'LUMP_SUM'))[0]!.status).toBe('DISMISSED');
  });

  it('an order on a lump-sum part cannot be revised above what is left of it', async () => {
    const id = await advise(lumpId);
    const r = await signLumpSum(db, id, { candidates: [ppfc(), bajaj()], limits, now: NOW });
    const [o] = await db.query<{ id: string }>(`select id from order_intents where recommendation_id = $1`, [r.recommendationIds[0]]);
    // ₹876 is left; the fund order may grow by that much, not by a paisa more.
    await expect(modifyOrder(db, o!.id, { idempotencyKey: 'up-too-far', actor: 'owner', quantity: (5_400_000n + 87_600n + 1n).toString() }))
      .rejects.toThrow(/LUMP_SUM_EXCEEDED/);
    await modifyOrder(db, o!.id, { idempotencyKey: 'up-to-left', actor: 'owner', quantity: (5_400_000n + 87_600n).toString() });
    expect((await loadLumpSum(db, lumpId))!.remainingPaise).toBe(0n);
  });
});
