import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { persistSipSnapshot } from '../../src/domain/sips.js';
import { recordProposal, loadProposals } from '../../src/advisor/proposals.js';
import { signAdvice, dismissAdvice } from '../../src/domain/advisor-handoff.js';
import { TRANCHE_USED, type Candidate } from '../../src/domain/sizing.js';

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
  vehicle: 'STOCK', fund: null,
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
  // Zero SIPs synced, so the order gate's envelope is the ₹50,000 budget these tests assume.
  await persistSipSnapshot(db, [], new Date().toISOString());
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

  it('signs a fund BUY as an amount-based top-up toward the approved mix, not a satellite stock', async () => {
    const fund = cand({
      id: 'c-ppfc', instrumentId: 'MF:PPFC', name: 'Parag Parikh Flexi Cap Direct', amountPaise: 2_000_000n, units: null,
      pricePaise: null, quoteAsOf: null, vehicle: 'FUND',
      fund: { fundType: 'FLEXI', actualBps: 1200, midBps: 2000, minBps: 1500, maxBps: 2500, quality: 'rank 2 of 11' },
    });
    const id = await advice({ ...buy, candidateId: 'c-ppfc', instrumentId: 'MF:PPFC', name: 'Parag Parikh Flexi Cap Direct',
      amountPaise: '2000000', units: null, whyNotFund: null });
    // Re-sizing finds the same candidate: the id is the sizer's, stable for the same size.
    const r = await signAdvice(db, id, { candidates: [cand(), fund], now: NOW });
    expect(r.approvalRequested).toBe(true);
    const [rec] = await db.query<{ primary_rec: string; kind: string }>(`select primary_rec, kind from recommendations where id = $1`, [r.recommendationId]);
    // A top-up toward the signed mix is a rebalance, not a "Stock idea".
    expect(rec!.kind).toBe('rebalance');
    const primary = JSON.parse(rec!.primary_rec);
    expect(primary).toMatchObject({
      action: 'BUY', instrumentId: 'MF:PPFC', amountPaise: '2000000',
      intent: 'top up Flexi cap toward the approved fund mix', ipsClauseRefs: ['3.4', '3.5'], falsification: null,
    });
    const [o] = await db.query<{ instrument_id: string; quantity: string }>(
      `select instrument_id, quantity::bigint::text as quantity from order_intents where recommendation_id = $1`, [r.recommendationId]);
    expect(o).toMatchObject({ instrument_id: 'MF:PPFC', quantity: '2000000' });
    await db.close();
  });

  it('signs a fund top-up a month after the last one: funds are exempt from the FR-12 hold (owner, 2026-10-27)', async () => {
    await db.query(
      `insert into recommendations (created_on, kind, intent, primary_rec, alternates, ips_clause_refs, engine_evidence, source)
       values ('2026-08-27', 'rebalance', 'top up', $1, '[]', '[]', '{}', 'advisor')`,
      [JSON.stringify({ intent: 'top up', instrumentId: 'MF:PPFC', action: 'BUY', amountPaise: '100', thesis: 't', ipsClauseRefs: ['3.4'], falsification: null })]);
    const fund = cand({
      id: 'c-ppfc', instrumentId: 'MF:PPFC', name: 'Parag Parikh Flexi Cap Direct', amountPaise: 2_000_000n, units: null,
      pricePaise: null, quoteAsOf: null, vehicle: 'FUND',
      fund: { fundType: 'FLEXI', actualBps: 1200, midBps: 2000, minBps: 1500, maxBps: 2500, quality: 'rank 2 of 11' },
    });
    const id = await advice({ ...buy, candidateId: 'c-ppfc', instrumentId: 'MF:PPFC', name: 'Parag Parikh Flexi Cap Direct',
      amountPaise: '2000000', units: null, whyNotFund: null });
    const r = await signAdvice(db, id, { candidates: [fund], now: NOW });
    expect(r.recommendationId).not.toBeNull();
    // The order gate (checkRails) applies the same exemption, so the owner is asked to approve.
    expect(r.approvalRequested).toBe(true);
    await db.close();
  });

  describe('a named alternate', () => {
    const alternateOf = async (withheldReason: string) => {
      await db.query(`insert into instruments (id, kind, name, currency) values ('NSE:HAL', 'EQUITY', 'HAL', 'INR') on conflict do nothing`);
      const hal = cand({ id: 'c-hal', instrumentId: 'NSE:HAL', name: 'HAL', status: 'WITHHELD', withheldReason, amountPaise: null, units: null });
      const id = await advice({ ...buy, alternates: ['c-hal', 'WAIT'] });
      const r = await signAdvice(db, id, { candidates: [cand(), hal], now: NOW });
      const [rec] = await db.query<{ alternates: string }>(`select alternates from recommendations where id = $1`, [r.recommendationId]);
      return JSON.parse(rec!.alternates)[0].instrumentId as string | null;
    };

    it('withheld only because the month\'s tranche is spent is kept', async () => {
      expect(await alternateOf(TRANCHE_USED)).toBe('NSE:HAL');
      await db.close();
    });

    it('withheld for any other reason (the cap) is not', async () => {
      expect(await alternateOf('would take it above the 10% single-stock cap')).not.toBe('NSE:HAL');
      await db.close();
    });
  });

  describe('a fund primary', () => {
    const fund = (instrumentId: string, fundType: 'NIFTY50' | 'FLEXI', units: string | null) => cand({
      id: `c-${instrumentId}`, instrumentId, name: instrumentId, amountPaise: 2_000_000n, units, pricePaise: null, quoteAsOf: null, vehicle: 'FUND',
      fund: { fundType, actualBps: 1200, midBps: 2000, minBps: 1500, maxBps: 2500, quality: 'index fund — exempt' },
    });
    const sign = async (c: Candidate) => {
      const id = await advice({ ...buy, candidateId: c.id, instrumentId: c.instrumentId, amountPaise: '2000000', units: c.units, alternates: ['WAIT'] });
      const r = await signAdvice(db, id, { candidates: [c], now: NOW });
      const [rec] = await db.query<{ alternates: string }>(`select alternates from recommendations where id = $1`, [r.recommendationId]);
      return JSON.parse(rec!.alternates) as { instrumentId: string | null; action: string; intent: string; thesis: string }[];
    };

    it('Nifty BeES with no named alternate signs, with a SIP leg and no index route', async () => {
      const alts = await sign(fund('NSE:NIFTYBEES', 'NIFTY50', '70'));
      expect(alts).toHaveLength(2);
      expect(alts.map((a) => a.instrumentId)).not.toContain('NSE:NIFTYBEES');
      expect(alts[0]).toMatchObject({ instrumentId: null, action: 'REDIRECT', intent: 'top up Nifty 50 index toward the approved fund mix' });
      expect(alts[0]!.thesis).toMatch(/Nifty 50 index through next month's SIP/);
      await db.close();
    });

    it('a fund alternate of another type is dropped: A1 is the primary\'s SIP route, A2 is do nothing', async () => {
      const mid = { ...fund('MF:HDFC-MID', 'FLEXI', null), fund: { fundType: 'MID' as const, actualBps: 500, midBps: 1500, minBps: 1000, maxBps: 2000, quality: 'rank 1 of 9' } };
      const flexi = { ...fund('MF:PPFC', 'FLEXI', null), status: 'WITHHELD' as const, withheldReason: TRANCHE_USED, amountPaise: null };
      const id = await advice({ ...buy, candidateId: mid.id, instrumentId: mid.instrumentId, amountPaise: '2000000', units: null, alternates: [flexi.id, 'WAIT'] });
      const r = await signAdvice(db, id, { candidates: [mid, flexi], now: NOW });
      const [rec] = await db.query<{ alternates: string }>(`select alternates from recommendations where id = $1`, [r.recommendationId]);
      const alts = JSON.parse(rec!.alternates) as { instrumentId: string | null; action: string; intent: string }[];
      expect(alts).toMatchObject([
        { instrumentId: null, action: 'REDIRECT', intent: 'top up Mid cap toward the approved fund mix' },
        { instrumentId: null, action: 'HOLD', intent: 'do nothing this cycle' },
      ]);
      expect(alts.map((a) => a.instrumentId)).not.toContain('MF:PPFC');
      await db.close();
    });

    it('the alternate to a Flexi cap top-up names Flexi cap, not a stock', async () => {
      const [a1] = await sign(fund('MF:PPFC', 'FLEXI', null));
      expect(a1!.thesis).toMatch(/Flexi cap/);
      expect(a1!.thesis).not.toMatch(/single-name|stock/i);
      await db.close();
    });
  });

  it('a dismissal is recorded with its reason', async () => {
    const id = await advice(buy);
    await dismissAdvice(db, id, 'Not convinced by the valuation');
    expect((await loadProposals(db))[0]).toMatchObject({ status: 'DISMISSED', note: 'Not convinced by the valuation' });
    await db.close();
  });
});
