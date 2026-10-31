import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { BUCKETS } from '../../src/domain/buckets.js';
import { endLifeEvent, logLifeEvent, reviewLine } from '../../src/domain/life-events.js';
import { istDate } from '../../src/domain/sips.js';
import { loadOwnerTimeline } from '../../src/domain/owner-log.js';
import { db, getEndableLifeEvents, getLifeEventReview } from '../../web/lib/data.js';

/** Batch C Task 8: the Overview's life-event review (open, waiting, stops) and /log's in-force list. */
const today = () => istDate(new Date().toISOString());
const monthsAgo = (n: number) => { const d = new Date(); d.setUTCMonth(d.getUTCMonth() - n); return istDate(d.toISOString()); };

describe('getLifeEventReview', () => {
  beforeAll(async () => {
    const d = await db();
    await runMigrations(d);
    for (const b of Object.values(BUCKETS)) {
      await d.query(`insert into buckets (id, name, mandate, target_paise, target_note) values ($1,$2,$3,$4,$5) on conflict do nothing`,
        [b.id, b.name, b.mandate, b.targetPaise?.toString() ?? null, b.targetNote]);
    }
  });

  it('a salary change opens 4 lines; needs-changing moves one to waiting; a 3-month job loss is a stop', async () => {
    const d = await db();
    expect(await getLifeEventReview()).toEqual({ open: [], waiting: [], stops: [] });

    const { id } = await logLifeEvent(d, { kind: 'SALARY_CHANGE', on: today(), amountPaise: 25_000_000n, note: '' });
    const r1 = await getLifeEventReview();
    expect(r1.open.map((l) => l.key)).toEqual(['monthly_budget_paise', 'goal_setaside_monthly_paise', 'salaryStepUp', 'emergency_target']);
    expect(r1.waiting).toEqual([]);

    await reviewLine(d, { eventId: id, key: 'salaryStepUp', outcome: 'NEEDS_CHANGE', newValueText: '8%' });
    const r2 = await getLifeEventReview();
    expect(r2.open).toHaveLength(3);
    expect(r2.waiting.map((l) => [l.key, l.newValueText])).toEqual([['salaryStepUp', '8%']]);
    expect(r2.stops).toEqual([]);

    const job = await logLifeEvent(d, { kind: 'JOB_LOSS', on: monthsAgo(4), note: '' });
    const r3 = await getLifeEventReview();
    expect(r3.stops.map((s) => s.eventId)).toEqual([job.id]);
    expect(r3.stops[0]!.text).toContain('pausing SIPs is permitted, not advised');
  });

  it('/log lists live job losses and medical expenses until ended; the timeline shows life events', async () => {
    const d = await db();
    const med = await logLifeEvent(d, { kind: 'MEDICAL_EXPENSE', on: today(), amountPaise: 5_000_000n, note: '' });
    const endable = await getEndableLifeEvents();
    expect(endable.map((e) => e.kind)).toEqual(['JOB_LOSS', 'MEDICAL_EXPENSE']);
    await endLifeEvent(d, { eventId: med.id, on: today(), note: 'settled' });
    expect((await getEndableLifeEvents()).map((e) => e.kind)).toEqual(['JOB_LOSS']);

    const timeline = (await loadOwnerTimeline(d)).filter((e) => e.kind === 'Life event');
    expect(timeline.map((e) => e.summary)).toEqual(expect.arrayContaining([
      'Medical expense of ₹50,000', 'Ended a medical expense — settled', 'Salary change: take-home now ₹2,50,000 a month',
    ]));
    expect(timeline.every((e) => e.reversible?.entity === 'life_event')).toBe(true);
  });
});
