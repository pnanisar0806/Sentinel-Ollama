import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  approveMix, loadSignedMix, newProposalReady, proposeMix, type RangeRow,
} from '../../src/domain/fund-mix.js';

/** Spec §7 / Decision 3: the owner signs the proposed range table whole; the latest row is in force. */

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

const SIGN_AT = '2026-10-23T06:00:00.000Z';
const proposalAt = (iso: string) => {
  const p = proposeMix(iso);
  if (p.band === null) throw new Error('fixture expects a proposal');
  return p;
};

describe('approveMix', () => {
  it('stores the proposal ranges verbatim plus one audit row', async () => {
    const p = proposalAt(SIGN_AT);
    const { id } = await approveMix(db, { band: p.band }, SIGN_AT);
    const [row] = await db.query<{ ranges: RangeRow[]; t: string; horizon_years: number; horizon_band: string; source: string }>(
      `select ranges, jsonb_typeof(ranges) t, horizon_years, horizon_band, source from fund_mix_signed where id = $1`, [id]);
    expect(row!.t).toBe('array');
    expect(row!.ranges).toEqual(p.ranges);
    expect(row).toMatchObject({ horizon_years: p.horizonYears, horizon_band: p.band, source: 'owner-signed' });

    const audit = await db.query<{ entity: string; action: string; actor: string; payload: unknown; t: string }>(
      `select entity, action, actor, payload, jsonb_typeof(payload) t from audit_log where entity = 'fund_mix'`);
    expect(audit).toEqual([{
      entity: 'fund_mix', action: 'SIGNED', actor: 'owner', t: 'object',
      payload: { rowId: id, band: p.band, horizonYears: p.horizonYears },
    }]);
  });

  it('refuses a band that is not the current proposal', async () => {
    const other = proposalAt(SIGN_AT).band === '15+' ? '7-15' : '15+';
    await expect(approveMix(db, { band: other }, SIGN_AT)).rejects.toThrow(/the proposal changed — reload \/funds/);
    expect(await db.query(`select 1 from fund_mix_signed`)).toHaveLength(0);
    expect(await db.query(`select 1 from audit_log where entity = 'fund_mix'`)).toHaveLength(0);
  });

  it('refuses when there is no proposal (under 7 years)', async () => {
    const late = '2045-06-01T06:00:00.000Z';
    expect(proposeMix(late).band).toBeNull();
    await expect(approveMix(db, { band: '7-15' }, late)).rejects.toThrow(/no row under 7 years/);
    expect(await db.query(`select 1 from fund_mix_signed`)).toHaveLength(0);
  });
});

describe('loadSignedMix', () => {
  it('is null before any signing', async () => {
    expect(await loadSignedMix(db)).toBeNull();
  });

  it('returns the later of two signings', async () => {
    const later = '2027-01-10T06:00:00.000Z';
    await approveMix(db, { band: proposalAt(SIGN_AT).band }, SIGN_AT);
    const { id } = await approveMix(db, { band: proposalAt(later).band }, later);
    const s = await loadSignedMix(db);
    expect(s).toMatchObject({ id, asOf: later, band: proposalAt(later).band, horizonYears: proposalAt(later).horizonYears });
    expect(s!.ranges).toEqual(proposalAt(later).ranges);
  });
});

describe('newProposalReady', () => {
  it('Review Focus 4: a band change makes a new proposal, and the signed 15+ row stays in force', async () => {
    const signedProposal = proposalAt(SIGN_AT);
    expect(signedProposal.band).toBe('15+');
    await approveMix(db, { band: '15+' }, SIGN_AT);

    const at = '2036-01-15T06:00:00.000Z';
    const now = proposeMix(at);
    expect(now).toMatchObject({ horizonYears: 14, band: '7-15' });
    const signed = await loadSignedMix(db);
    expect(signed!.band).toBe('15+');
    expect(signed!.ranges).toEqual(signedProposal.ranges);
    expect(newProposalReady(signed, now, at)).toBe(true);
  });

  it('same band: new only once the signed row is 365 days old', async () => {
    await approveMix(db, { band: '15+' }, SIGN_AT);
    const signed = await loadSignedMix(db);
    const day = 86_400_000;
    const before = new Date(Date.parse(SIGN_AT) + 365 * day - 1).toISOString();
    const on = new Date(Date.parse(SIGN_AT) + 365 * day).toISOString();
    expect(newProposalReady(signed, proposeMix(before), before)).toBe(false);
    expect(newProposalReady(signed, proposeMix(on), on)).toBe(true);
  });

  it('nothing signed yet is not a "new" proposal — it is the first one', () => {
    expect(newProposalReady(null, proposeMix(SIGN_AT), SIGN_AT)).toBe(false);
  });
});
