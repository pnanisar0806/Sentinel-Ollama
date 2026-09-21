import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { promoteExitCandidate } from '../../src/domain/exit-promotion.js';
import type { ExitCandidate } from '../../src/domain/sell-triggers.js';

/**
 * Owner decision 2026-09-21: exits are promotable ON DEMAND.
 *
 * Not automatically, because promotion spends one of FR-12's four recommendation slots
 * and a standing breach re-fires every month — three cap breaches on one holding would
 * consume the whole monthly budget on an unchanged fact, forever.
 */
const candidate = (over: Partial<ExitCandidate> = {}): ExitCandidate => ({
  trigger: 'hard-cap',
  instrumentId: 'US:NOW',
  action: 'TRIM',
  month: '2026-09',
  evidence: 'employer 23.7% vs 10% cap',
  ipsClauseRefs: ['3.5'],
  overridesMinimumHold: true,
  heldMonths: 40,
  blockedByMinimumHold: false,
  amountPaise: 9_000_000n,
  paper: true,
  ...over,
});

describe('promoting an exit candidate', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
  });

  it('writes an FR-11 recommendation carrying the trigger and its size', async () => {
    const result = await promoteExitCandidate(db, candidate(), '2026-09-21');
    expect(result.suppressed).toBe(false);
    expect(result.id).not.toBeNull();

    const [row] = await db.query<{ kind: string; primary_rec: string; engine_evidence: string }>(
      `select kind, primary_rec, engine_evidence from recommendations where id = $1`, [result.id],
    );
    expect(row!.kind).toBe('sell');
    const primary = JSON.parse(row!.primary_rec) as Record<string, unknown>;
    expect(primary.instrumentId).toBe('US:NOW');
    expect(primary.action).toBe('TRIM');
    expect(primary.amountPaise).toBe('9000000');
    // The falsification field exists and is NULL: an exit's thesis is the one that
    // already failed, and FR-11 requires the field, not a fabricated value in it.
    expect(primary.falsification).toBeNull();
    await db.close();
  });

  it('refuses a candidate inside the §3.7 minimum hold', async () => {
    const result = await promoteExitCandidate(
      db, candidate({ blockedByMinimumHold: true, overridesMinimumHold: false }), '2026-09-21',
    );
    expect(result.suppressed).toBe(true);
    expect(result.blocked).toBe('minimum-hold');
    expect(result.reason).toMatch(/3\.7/);
    await db.close();
  });

  it('refuses to promote the same name twice in a month', async () => {
    await promoteExitCandidate(db, candidate(), '2026-09-21');
    const second = await promoteExitCandidate(
      db, candidate({ trigger: 'red-flag', action: 'SELL' }), '2026-09-22',
    );
    // US:NOW breaches three caps at once; promoting each would spend three of four slots
    // on one unchanged fact.
    expect(second.suppressed).toBe(true);
    expect(second.blocked).toBe('already-promoted');
    await db.close();
  });

  it('surfaces the FR-12 monthly cap rather than silently dropping the promotion', async () => {
    for (const id of ['NSE:RPOWER', 'NSE:GOLDBEES', 'NSE:LIQUIDBEES', 'US:INDMONEY-BASKET']) {
      await promoteExitCandidate(db, candidate({ instrumentId: id, action: 'SELL' }), '2026-09-21');
    }
    const fifth = await promoteExitCandidate(db, candidate(), '2026-09-21');
    expect(fifth.suppressed).toBe(true);
    expect(fifth.reason).toMatch(/FR-12/);
    await db.close();
  });

  it('carries a null size through rather than writing 0', async () => {
    const result = await promoteExitCandidate(db, candidate({ amountPaise: null }), '2026-09-21');
    const [row] = await db.query<{ primary_rec: string }>(
      `select primary_rec from recommendations where id = $1`, [result.id],
    );
    expect((JSON.parse(row!.primary_rec) as { amountPaise: unknown }).amountPaise).toBeNull();
    await db.close();
  });

  it('refuses rather than throwing when the name IS the index route', async () => {
    // `buildRecommendation` offers NSE:NIFTYBEES as alternate A1 when no same-intent
    // challenger exists, so exiting NIFTYBEES itself cannot satisfy FR-11. That is a
    // refusal, not a 500 out of the API route.
    const result = await promoteExitCandidate(
      db, candidate({ instrumentId: 'NSE:NIFTYBEES', action: 'SELL' }), '2026-09-21',
    );
    expect(result.suppressed).toBe(true);
    expect(result.blocked).toBe('fr-11');
    await db.close();
  });
});
