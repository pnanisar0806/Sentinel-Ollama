import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import {
  FIDELITY_GRANTS, FIDELITY_TOTAL_OUTSTANDING_PAISE, FIDELITY_TRANCHE_SUM_PAISE,
  FIDELITY_UNVESTED,
} from '../../src/seed/seed-rsu-actual.js';
import { persistVests } from '../../src/domain/rsu.js';
import { paise } from '../../src/money/paise.js';

/**
 * Source: "Fidelity NetBenefits - Awards Details", 2026-09-21 23:35 IST, NOW $135.47.
 *
 * The seeded grants were an approximation whose 1,105-unit total was right while every
 * grant but the last had the wrong date and size, and `projectVests` then spread each
 * over uniform quarterly tranches. 25RUST vests ANNUALLY and both 21RUIN4A* grants
 * semi-annually, so the digest announced roughly ₹4L vesting on 15 Nov 2026 where the
 * real tranche is 18 units.
 */
describe('the RSU pipeline is the statement, not a projection', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
  });

  it('carries the 400 unvested units the statement reports', () => {
    expect(FIDELITY_UNVESTED.reduce((a, v) => a + v.units, 0)).toBe(400);
  });

  it('documents the statement’s own six-paise rounding rather than closing it', () => {
    const sum = FIDELITY_UNVESTED.reduce((a, v) => a + v.grossPaise, 0n);
    // Fidelity rounds each tranche to the paisa and computes its header from the
    // unrounded unit value, so the two figures it prints differ by 6 paise. Neither is
    // adjusted to agree with the other: both are the source's.
    expect(sum).toBe(FIDELITY_TRANCHE_SUM_PAISE);
    expect(sum - FIDELITY_TOTAL_OUTSTANDING_PAISE).toBe(6n);
  });

  it('grants total the 1,105 units the statement reports', () => {
    expect(FIDELITY_GRANTS.reduce((a, g) => a + g.units, 0)).toBe(1105);
  });

  it('seeds the real grants and drops the invented ones', async () => {
    const rows = await db.query<{ id: string; units: string }>(
      `select id, units from rsu_grants order by id`,
    );
    expect(rows.map((r) => r.id)).toEqual(
      ['12RUIN5012', '21RUIN4A', '21RUIN4A1', '21RUIN4A3', '25RUST', '26RSU'],
    );
    // G2021..G2026 were the approximation.
    expect(rows.some((r) => r.id.startsWith('G20'))).toBe(false);
    await db.close();
  });

  it('records the next vest as the statement gives it, not as a quarter of a grant', async () => {
    const [next] = await db.query<{ grant_id: string; units: string; gross_paise: string }>(
      `select grant_id, units, gross_paise from rsu_vests
        where vest_on = date '2026-11-15'`,
    );
    expect(next?.grant_id).toBe('26RSU');
    expect(Number(next!.units)).toBe(18);
    // Rs 2,33,641.05 — not the ~Rs 4L the projection announced.
    expect(BigInt(next!.gross_paise)).toBe(23_364_105n);
    await db.close();
  });

  it('keeps the irregular cadences instead of forcing everything quarterly', async () => {
    const rows = await db.query<{ vest_on: string | Date }>(
      `select vest_on from rsu_vests where grant_id = '25RUST' order by vest_on`,
    );
    const dates = rows.map((r) => (r.vest_on instanceof Date
      ? r.vest_on.toISOString().slice(0, 10) : String(r.vest_on).slice(0, 10)));
    // Annual, every 15 February — three tranches, not twelve quarters.
    expect(dates).toEqual(['2027-02-15', '2028-02-15', '2029-02-15']);
    await db.close();
  });

  it('a model projection cannot overwrite a tranche from the statement', async () => {
    await persistVests(db, [{
      grantId: '26RSU', vestOn: '2026-11-15', units: 99, status: 'PROJECTED',
      grossPaise: paise(99_999_999n), netPaise: paise(70_000_000n),
    }]);
    const [row] = await db.query<{ units: string }>(
      `select units from rsu_vests where grant_id = '26RSU' and vest_on = date '2026-11-15'`,
    );
    // Otherwise every `sync` would put the fiction back.
    expect(Number(row!.units)).toBe(18);
    await db.close();
  });

  it('every unvested tranche is in the future of the statement date', () => {
    for (const v of FIDELITY_UNVESTED) expect(v.vestOn > '2026-09-21').toBe(true);
  });
});
