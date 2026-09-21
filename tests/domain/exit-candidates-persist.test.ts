import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadPositions } from '../../src/domain/networth.js';
import {
  evaluateExits, loadExitCandidates, persistExitCandidates, type ExitCandidate,
} from '../../src/domain/sell-triggers.js';

/**
 * `evaluateExits` was recomputed on every weekly report and every /cleanup render and
 * written nowhere, so nothing could say when a name was first flagged, whether this
 * month's breach is last month's, or whether the owner acted. The digest re-sent the
 * same standing candidates every week with no memory.
 *
 * Candidates are NOT recommendations. They are recorded so the engine has a memory,
 * without consuming the FR-12 monthly action budget.
 */
describe('exit candidates are recorded', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
  });

  const exitsFor = async (month: string) => {
    const positions = await loadPositions(db);
    return evaluateExits(db, { positions, blockedIds: [] }, month);
  };

  it('the seeded portfolio produces hard-cap candidates — otherwise this is vacuous', async () => {
    const exits = await exitsFor('2026-08');
    expect(exits.some((e) => e.trigger === 'hard-cap')).toBe(true);
    await db.close();
  });

  it('writes each candidate once, however often the weekly job runs', async () => {
    const exits = await exitsFor('2026-08');
    const first = await persistExitCandidates(db, exits, '2026-08-31');
    expect(first).toBe(exits.length);
    expect(first).toBeGreaterThan(0);

    // The weekly job runs four or five times inside one month.
    expect(await persistExitCandidates(db, exits, '2026-09-07')).toBe(0);
    expect(await persistExitCandidates(db, exits, '2026-09-14')).toBe(0);

    const [count] = await db.query<{ n: string }>(`select count(*) as n from exit_candidates`);
    expect(Number(count!.n)).toBe(exits.length);
    await db.close();
  });

  it('round-trips a candidate without losing its size or its hold flag', async () => {
    const exits = await exitsFor('2026-08');
    await persistExitCandidates(db, exits, '2026-08-31');

    const back = await loadExitCandidates(db, '2026-08');
    expect(back.length).toBe(exits.length);
    const same = (a: ExitCandidate) => `${a.instrumentId}|${a.trigger}`;
    for (const original of exits) {
      const stored = back.find((b) => same(b) === same(original));
      expect(stored, same(original)).toBeDefined();
      expect(stored!.amountPaise).toBe(original.amountPaise);
      expect(stored!.action).toBe(original.action);
      expect(stored!.blockedByMinimumHold).toBe(original.blockedByMinimumHold);
      expect(stored!.ipsClauseRefs).toEqual(original.ipsClauseRefs);
      expect(stored!.heldMonths).toBe(original.heldMonths);
    }
    await db.close();
  });

  it('keeps last month as it was when this month is written', async () => {
    await persistExitCandidates(db, await exitsFor('2026-08'), '2026-08-31');
    await persistExitCandidates(db, await exitsFor('2026-09'), '2026-09-30');

    // The table is append-only: August is the record of what was true in August.
    expect((await loadExitCandidates(db, '2026-08')).length).toBeGreaterThan(0);
    expect((await loadExitCandidates(db, '2026-09')).length).toBeGreaterThan(0);
    // No argument means the latest month, not everything ever recorded.
    expect((await loadExitCandidates(db)).every((c) => c.month === '2026-09')).toBe(true);
    await db.close();
  });
});

describe('exit candidates carry a size', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
  });

  it('a hard-cap TRIM asks for the excess, not the whole position', async () => {
    const positions = await loadPositions(db);
    const exits = await evaluateExits(db, { positions, blockedIds: [] }, '2026-08');
    const trim = exits.find((e) => e.trigger === 'hard-cap' && e.instrumentId === 'US:NOW');
    expect(trim).toBeDefined();
    expect(trim!.action).toBe('TRIM');

    const total = positions.reduce((a, p) => a + p.valuePaise, 0n);
    const own = positions.filter((p) => p.instrumentId === 'US:NOW')
      .reduce((a, p) => a + p.valuePaise, 0n);
    // US:NOW breaches single-stock, employer and single-issuer at once; whichever hit
    // lands last wins the map, so assert the property every cap shares rather than one
    // cap's number: the trim is a real fraction of the position, never all of it.
    expect(trim!.amountPaise).not.toBeNull();
    expect(trim!.amountPaise!).toBeGreaterThan(0n);
    expect(trim!.amountPaise!).toBeLessThan(own);

    // And it must be the excess over SOME cap, i.e. own minus an exact percentage of
    // the total — derived here from the real numbers, not copied from the source.
    const capsBp = [1000n, 2500n, 1500n]; // single-stock 10%, employer 25%, issuer 15%
    const allowed = capsBp.map((bp) => own - (total * bp) / 10_000n);
    expect(allowed).toContain(trim!.amountPaise!);
    await db.close();
  });

  it('a full exit is sized at the whole position', async () => {
    const positions = await loadPositions(db);
    // Force a falsifiable red flag path by checking any SELL the engine produced.
    const exits = await evaluateExits(db, { positions, blockedIds: [] }, '2026-08');
    for (const e of exits.filter((x) => x.action === 'SELL' || x.action === 'REDEEM')) {
      const own = positions.filter((p) => p.instrumentId === e.instrumentId)
        .reduce((a, p) => a + p.valuePaise, 0n);
      if (own === 0n) {
        expect(e.amountPaise, `${e.instrumentId} is not held`).toBeNull();
      } else {
        expect(e.amountPaise, e.instrumentId).toBe(own);
      }
    }
    await db.close();
  });
});
