import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { recordProposal, loadProposals } from '../../src/advisor/proposals.js';
import { signAdvice, dismissAdvice } from '../../src/domain/advisor-handoff.js';
import type { Candidate } from '../../src/domain/sizing.js';

/**
 * Phase 2.5 Task 6, the handoff. Signing advice is not approving an order: it turns a BUY
 * into an ordinary recommendation (every FR-12 gate applies) and an approval request the
 * owner still has to approve. The size is re-checked at the moment of signing.
 */
let db: Db;
const NOW = new Date('2026-09-27T10:00:00Z');
const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: 'c-bajaj', action: 'BUY', instrumentId: 'NSE:BAJAJ-AUTO', name: 'Bajaj Auto', status: 'ELIGIBLE', withheldReason: null,
  amountPaise: 4_512_400n, units: '4', pricePaise: 1_128_100n, quoteAsOf: '2026-09-26', basis: 'b', constraints: [], policyVersion: 'sizing-v1',
  ...over,
});
const advice = (payload: object) => recordProposal(db, {
  kind: 'ADVISE', payload, inputSnapshot: {}, evidenceIds: [], model: 'm', promptVersion: 'p', schemaVersion: 's', asOf: NOW.toISOString(),
});
const buy = {
  decision: 'BUY', candidateId: 'c-bajaj', instrumentId: 'NSE:BAJAJ-AUTO', name: 'Bajaj Auto', amountPaise: '4512400', units: '4',
  rationale: 'Durable franchise at a fair price.', keyRisk: 'Demand slowdown.', falsification: 'ROCE below 15%.', counterargument: 'EV risk.',
  horizonYears: 5, alternates: ['WAIT'],
};

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
  await db.query(`insert into instruments (id, kind, name, currency) values ('NSE:BAJAJ-AUTO', 'EQUITY', 'Bajaj Auto', 'INR') on conflict do nothing`);
});

describe('signing advice', () => {
  it('turns a signed BUY into a recommendation and an approval request at the sizer\'s amount', async () => {
    const id = await advice(buy);
    const r = await signAdvice(db, id, { candidates: [cand()], now: NOW });
    expect(r.recommendationId).not.toBeNull();
    const [rec] = await db.query<{ primary_rec: string }>(`select primary_rec from recommendations where id = $1`, [r.recommendationId]);
    expect(JSON.parse(rec!.primary_rec)).toMatchObject({ action: 'BUY', instrumentId: 'NSE:BAJAJ-AUTO', amountPaise: '4512400' });
    expect(r.approvalRequested).toBe(true);
    // Signed advice is benchmarked so its outcome can be scored (Task 7).
    expect(await db.query(`select 1 from benchmarks where recommendation_id = $1`, [r.recommendationId])).toHaveLength(1);
    expect((await loadProposals(db))[0]!.status).toBe('SIGNED');
    await db.close();
  });

  it('refuses when the size has changed since the advice — nothing is signed', async () => {
    const id = await advice(buy);
    await expect(signAdvice(db, id, { candidates: [cand({ id: 'c-bajaj-resized', amountPaise: 3_000_000n })], now: NOW }))
      .rejects.toThrow(/changed/);
    expect((await loadProposals(db))[0]!.status).toBe('OPEN');
    await db.close();
  });

  it('signs a WAIT without creating anything to approve', async () => {
    const id = await advice({ decision: 'WAIT', candidateId: 'c-bajaj', rationale: 'r' });
    const r = await signAdvice(db, id, { candidates: [], now: NOW });
    expect(r).toMatchObject({ recommendationId: null, approvalRequested: false });
    expect(await db.query(`select 1 from recommendations`)).toHaveLength(0);
    await db.close();
  });

  it('cannot sign what the system could not decide, or sign twice', async () => {
    const na = await advice({ decision: 'UNAVAILABLE', reason: 'no key' });
    await expect(signAdvice(db, na, { candidates: [], now: NOW })).rejects.toThrow(/nothing to sign/);
    const id = await advice(buy);
    await signAdvice(db, id, { candidates: [cand()], now: NOW });
    await expect(signAdvice(db, id, { candidates: [cand()], now: NOW })).rejects.toThrow(/already/);
    await db.close();
  });

  it('a dismissal is recorded with its reason', async () => {
    const id = await advice(buy);
    await dismissAdvice(db, id, 'Not convinced by the valuation');
    expect((await loadProposals(db))[0]).toMatchObject({ status: 'DISMISSED', note: 'Not convinced by the valuation' });
    await db.close();
  });
});
