import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { BUCKETS } from '../../src/domain/buckets.js';
import { formatInr, type Paise } from '../../src/money/paise.js';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';
import { logLifeEvent, reviewLine } from '../../src/domain/life-events.js';
import { goalReviewLines } from '../../web/lib/life-events.js';

/** Goal review lines (emergency target, education goal) are goal status: built only in web/. */
let db: Db;
const NOW = '2026-10-31T06:00:00Z';

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  for (const b of Object.values(BUCKETS)) {
    await db.query(`insert into buckets (id, name, mandate, target_paise, target_note) values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [b.id, b.name, b.mandate, b.targetPaise?.toString() ?? null, b.targetNote]);
  }
});
afterEach(async () => { await db.close(); });

describe('goalReviewLines', () => {
  it('a new dependent raises the emergency and education lines with the goal targets', async () => {
    const { id } = await logLifeEvent(db, { kind: 'NEW_DEPENDENT', on: '2026-10-01', detail: { expectedOn: '2027-06-01' }, note: '' }, NOW);
    const lines = await goalReviewLines(db, NOW);
    const lakhs = (p: bigint) => formatInr(p as Paise, { compact: true });
    expect(lines.map((l) => [l.eventId, l.key, l.kind, l.state, l.current])).toEqual([
      [id, 'emergency_target', 'goal', 'OPEN', `${lakhs(BUCKETS.B3.targetPaise!)} by ${ASSUMPTIONS.emergencyTargetMonth}`],
      [id, 'education_goal', 'goal', 'OPEN', `${lakhs(BUCKETS.B4.targetPaise!)} real by ${ASSUMPTIONS.educationEndYear}`],
    ]);
  });

  it('STILL_RIGHT closes a goal line; a salary change raises only the emergency line', async () => {
    const { id } = await logLifeEvent(db, { kind: 'SALARY_CHANGE', on: '2026-10-01', amountPaise: 1n, note: '' }, NOW);
    expect((await goalReviewLines(db, NOW)).map((l) => l.key)).toEqual(['emergency_target']);
    await reviewLine(db, { eventId: id, key: 'emergency_target', outcome: 'STILL_RIGHT' }, '2026-10-31T07:00:00Z');
    expect(await goalReviewLines(db, '2026-10-31T08:00:00Z')).toEqual([]);
  });

  it('a goal tracker that cannot load gives a null current, never a thrown page', async () => {
    await db.query(`insert into settings_rails (key, value) values ('goal_equity_ceiling_pct', '95'::jsonb)`);
    await logLifeEvent(db, { kind: 'MEDICAL_EXPENSE', on: '2026-10-01', amountPaise: 1n, note: '' }, NOW);
    expect((await goalReviewLines(db, NOW)).map((l) => l.current)).toEqual([null]);
  });
});
