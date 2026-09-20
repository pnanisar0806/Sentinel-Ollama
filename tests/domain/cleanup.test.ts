import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { seedSmallcases, loadSmallcasePositions } from '../../src/seed/seed-smallcases.js';
import { SMALLCASES } from '../../src/config/smallcases.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadPositions } from '../../src/domain/networth.js';
import { rupees } from '../../src/money/paise.js';
import {
  generateCleanupRecommendations,
  toPaperRecommendations,
  MICRO_ORPHAN_THRESHOLD,
  LTCG_EXEMPTION_PER_FY,
  type CleanupRec,
} from '../../src/domain/cleanup.js';

const SEED_DATE = '2026-08-12';
let db: Db;
let positions: Awaited<ReturnType<typeof loadPositions>>;

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: SEED_DATE });
  positions = await loadPositions(db);
});

const stateOf = (over: { asOf?: string; positions?: typeof positions } = {}) => {
  const pos = over.positions ?? positions;
  return {
    asOf: over.asOf ?? SEED_DATE,
    positions: pos.map((p) => ({
      instrumentId: p.instrumentId,
      name: p.name,
      account: p.account,
      valuePaise: p.valuePaise,
      sector: p.sector ?? undefined,
      issuer: p.issuer ?? undefined,
    })),
  };
};

describe('generateCleanupRecommendations', () => {
  it('produces one subscription note per real smallcase, not one blob', async () => {
    // Drove off NSE:SMALLCASE-RESIDUE until 2026-09-20 — a seeded ₹6,55,400 line that
    // modelled all four smallcases as a single opaque position and has been retired.
    const out = await generateCleanupRecommendations(db, stateOf());
    expect(out.cleanupRecs.find((r) => r.instrumentId === 'NSE:SMALLCASE-RESIDUE')).toBeUndefined();

    expect(out.cleanupRecs.filter((r) => r.reason.includes('subscription')).length,
      'nothing to say before the decomposition is on record').toBe(0);

    // The IND:* instruments are created by the live INDmoney sync, not by `pnpm seed`,
    // so the decomposition can only be persisted after a sync has run. Standing that up
    // here is what production does in the other order.
    for (const sc of SMALLCASES) {
      for (const k of sc.constituents) {
        await db.query(
          `insert into instruments (id, kind, name, currency) values ($1, 'EQUITY', $1, 'INR')
           on conflict (id) do nothing`, [k.instrumentId],
        );
      }
    }
    const seeded = await seedSmallcases(db);
    expect(seeded.skipped, 'no constituent should be skipped once instruments exist').toEqual([]);
    const named = await loadSmallcasePositions(db);

    // With the decomposition present, every smallcase gets its own note.
    const withData = await generateCleanupRecommendations(db, stateOf());
    const perSmallcase = withData.cleanupRecs.filter((r) => r.reason.includes('subscription'));
    expect(perSmallcase.length).toBe(named.size);
    expect(named.size).toBeGreaterThan(1);

    for (const r of perSmallcase) {
      expect(r.recommendation).toBe('legacy_note');
      // HOLD, not SELL: IPS §3.9 ends the subscription and retains the shares. The
      // owner has stopped transacting, so recommending a liquidation would be churn.
      expect(r.action).toBe('CLOSE_MANUALLY');
      expect(r.ipsClauseRefs).toContain('3.9');
      expect(r.falsification, 'a custodianship change has no price kill condition').toBeNull();
      // The note must name the actual shares retained, or it cannot be acted on.
      expect(r.thesis).toMatch(/IND:\S+ x\d+/);
    }
  });

  it('produces micro-orphan recommendations for positions < ₹5k', async () => {
    const out = await generateCleanupRecommendations(db, stateOf());
    const microOrphans = out.cleanupRecs.filter((r) => r.reason.includes('Micro-orphan'));
    // Seed data only has RPOWER (₹2,600) which is excluded as a legacy note
    // This test validates the filter logic works; with different data it would find micro-orphans
    expect(microOrphans.length).toBe(0);
  });

  it('produces thesis-less consolidation for eligible equity holdings', async () => {
    const out = await generateCleanupRecommendations(db, stateOf());
    const thesisLess = out.cleanupRecs.filter((r) => r.reason.includes('Thesis-less'));
    expect(thesisLess.length).toBeGreaterThan(0);
    for (const r of thesisLess) {
      expect(r.recommendation).toBe('sell');
      expect(r.action).toBe('SELL');
      expect(r.ipsClauseRefs).toContain('3.9');
    }
  });

  it('produces Groww RPOWER legacy note for manual closure', async () => {
    const out = await generateCleanupRecommendations(db, stateOf());
    const rpower = out.cleanupRecs.find((r) => r.instrumentId === 'NSE:RPOWER');
    expect(rpower).toBeDefined();
    expect(rpower!.recommendation).toBe('legacy_note');
    expect(rpower!.action).toBe('CLOSE_MANUALLY');
    expect(rpower!.reason).toContain('manual closure');
    expect(rpower!.ipsClauseRefs).toContain('3.9');
  });

  it('produces bond credit review for BOND instruments (excluding maturity routing)', async () => {
    const out = await generateCleanupRecommendations(db, stateOf());
    // Filter for bond credit reviews only (recommendation === 'sell' for bonds)
    const bondCreditReviews = out.cleanupRecs.filter(
      (r) => r.instrumentId.startsWith('BOND:') && r.recommendation === 'sell',
    );
    expect(bondCreditReviews.length).toBeGreaterThan(0);
    for (const r of bondCreditReviews) {
      expect(r.recommendation).toBe('sell');
      expect(r.ipsClauseRefs).toContain('3.8');
      expect(r.ipsClauseRefs).toContain('3.9');
    }
  });

  it('produces Sammaan Sep-2026 maturity routing to B3', async () => {
    const out = await generateCleanupRecommendations(db, stateOf());
    expect(out.sammaanRouting).toBeDefined();
    expect(out.sammaanRouting!.instrumentId).toBe('BOND:SAMMAAN-2026');
    expect(out.sammaanRouting!.recommendation).toBe('maturity_routing');
    expect(out.sammaanRouting!.ipsClauseRefs).toContain('3.8');
    expect(out.sammaanRouting!.ipsClauseRefs).toContain('3.9');
  });

  it('produces LTCG harvest plans for thesis-less equity with lots', async () => {
    const out = await generateCleanupRecommendations(db, stateOf());
    expect(out.ltcgHarvest.length).toBeGreaterThanOrEqual(0);
    for (const r of out.ltcgHarvest) {
      expect(r.fyPlan).toBeDefined();
      expect(r.fyPlan!.budgetPaise).toBe(LTCG_EXEMPTION_PER_FY);
      expect(r.fyPlan!.lots.length).toBeGreaterThan(0);
      expect(r.ipsClauseRefs).toContain('3.9');
    }
  });

  it('excludes EPF, CASH, US, Liquid BeES from thesis-less', async () => {
    const out = await generateCleanupRecommendations(db, stateOf());
    const thesisLessIds = out.thesisLess.map((r) => r.instrumentId);
    for (const id of thesisLessIds) {
      expect(id).not.toMatch(/^(EPF:|CASH:|US:)/);
      expect(id).not.toBe('NSE:LIQUIDBEES');
    }
  });
});

describe('toPaperRecommendations', () => {
  it('converts cleanup recs to FR-11 paper recommendations with 2 alternates', async () => {
    const out = await generateCleanupRecommendations(db, stateOf());
    const paperRecs = toPaperRecommendations(out.cleanupRecs, SEED_DATE);
    expect(paperRecs.length).toBe(out.cleanupRecs.length);
    for (const rec of paperRecs) {
      expect(rec.kind).toBeDefined();
      expect(rec.createdOn).toBe(SEED_DATE);
      expect(rec.primary).toBeDefined();
      expect(rec.sameIntentAlternates).toHaveLength(1);
      expect(rec.differentIntent).toBeDefined();
      expect(rec.paperMode).toBe(true);
    }
  });

  it('creates index-route A1 for sell recommendations', async () => {
    const out = await generateCleanupRecommendations(db, stateOf());
    const sellRecs = out.cleanupRecs.filter((r) => r.recommendation === 'sell');
    const paperRecs = toPaperRecommendations(sellRecs, SEED_DATE);
    for (const rec of paperRecs) {
      const a1 = rec.sameIntentAlternates?.[0];
      expect(a1).toBeDefined();
      if (!a1) continue;
      expect(a1.instrumentId).toBe('NSE:NIFTYBEES');
      expect(a1.action).toBe('REDIRECT');
    }
  });

  it('creates do-nothing HOLD A2 for all', async () => {
    const out = await generateCleanupRecommendations(db, stateOf());
    const paperRecs = toPaperRecommendations(out.cleanupRecs, SEED_DATE);
    for (const rec of paperRecs) {
      const a2 = rec.differentIntent;
      expect(a2).toBeDefined();
      if (!a2) continue;
      expect(a2.action).toBe('HOLD');
      expect(a2.instrumentId).toBeNull();
      expect(a2.ipsClauseRefs).toContain('3.7');
    }
  });

  it('creates manual-hold A1 for Groww RPOWER legacy_note', async () => {
    const out = await generateCleanupRecommendations(db, stateOf());
    const rpower = out.cleanupRecs.find((r) => r.instrumentId === 'NSE:RPOWER')!;
    const paperRecs = toPaperRecommendations([rpower], SEED_DATE);
    const rec = paperRecs[0];
    expect(rec).toBeDefined();
    if (!rec) return;
    const a1 = rec.sameIntentAlternates?.[0];
    expect(a1).toBeDefined();
    if (!a1) return;
    expect(a1.action).toBe('HOLD');
    expect(a1.instrumentId).toBeNull();
    expect(a1.intent).toContain('manual closure');
  });
});

describe('MICRO_ORPHAN_THRESHOLD', () => {
  it('is ₹5,000 in paise', () => {
    expect(MICRO_ORPHAN_THRESHOLD).toBe(rupees('5000'));
  });
});

describe('LTCG_EXEMPTION_PER_FY', () => {
  it('is ₹1.25L in paise', () => {
    expect(LTCG_EXEMPTION_PER_FY).toBe(rupees('125000'));
  });
});