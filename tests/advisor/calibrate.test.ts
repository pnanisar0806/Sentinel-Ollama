import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { calibrateByOrigin } from '../../src/advisor/calibrate.js';
import { MIN_EVALS_FOR_CALIBRATION } from '../../src/domain/scoring.js';

/**
 * Phase 2.5 Task 7. Calibration by origin (engine vs signed advice), conviction and horizon.
 * One recommendation counts once per horizon, however many benchmark snapshots it has.
 * A bucket below the minimum states no hit-rate. An unscoreable outcome is excluded and
 * counted as excluded — never as a miss.
 */
let db: Db;
beforeEach(async () => { db = await openDb(); await runMigrations(db); });

let n = 0;
async function rec(advisor: boolean): Promise<number> {
  n++;
  const [r] = await db.query<{ id: string }>(
    `insert into recommendations (created_on, kind, intent, primary_rec, alternates, ips_clause_refs, engine_evidence)
     values ('2026-01-01', 'satellite', 'i', '{}', '[]', '[]', $1::jsonb) returning id`,
    [JSON.stringify(advisor ? { advisorProposalId: n } : {})]);
  return Number(r!.id);
}
async function bench(recId: number, asOf: string, excessBps: number | null, healthy: boolean | null, conviction = 'MEDIUM'): Promise<void> {
  await db.query(
    `insert into benchmarks (recommendation_id, benchmark_as_of, benchmark_jsonb, eval_3m_as_of, eval_3m_jsonb)
     values ($1, $2, $3::jsonb, $2, $4::jsonb)`,
    [recId, asOf, JSON.stringify({ conviction }), JSON.stringify({ excessBps, convictionHealthy: healthy, horizon: 3 })]);
}

describe('advisor calibration', () => {
  it('counts a recommendation once even with two benchmark snapshots', async () => {
    const id = await rec(true);
    await bench(id, '2026-01-01', 100, true);
    await bench(id, '2026-01-02', -50, false);
    const c = await calibrateByOrigin(db);
    expect(c.rows.find((r) => r.origin === 'advisor')!.evaluated).toBe(1);
    await db.close();
  });

  it('keeps advisor and engine decisions apart', async () => {
    await bench(await rec(true), '2026-01-01', 100, true);
    await bench(await rec(false), '2026-01-01', 100, true);
    const c = await calibrateByOrigin(db);
    expect(c.rows.map((r) => r.origin).sort()).toEqual(['advisor', 'engine']);
    await db.close();
  });

  it('withholds a hit-rate one short of the minimum and states it at the minimum', async () => {
    for (let i = 0; i < MIN_EVALS_FOR_CALIBRATION - 1; i++) await bench(await rec(true), '2026-01-01', 100, true);
    expect((await calibrateByOrigin(db)).rows[0]!.hitRate).toBeNull();
    await bench(await rec(true), '2026-01-01', 100, true);
    expect((await calibrateByOrigin(db)).rows[0]!.hitRate).toBe(1);
    await db.close();
  });

  it('excludes an unscoreable outcome and counts it as excluded, not a miss', async () => {
    await bench(await rec(true), '2026-01-01', null, null);
    const row = (await calibrateByOrigin(db)).rows[0]!;
    expect(row).toMatchObject({ evaluated: 0, excluded: 1 });
    await db.close();
  });
});
