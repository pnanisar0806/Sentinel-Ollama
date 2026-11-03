import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  endLifeEvent, loadReviewLines, logLifeEvent, REVIEW_ITEMS, reviewLine, stopEventsInForce, type LifeEventKind,
} from '../../src/domain/life-events.js';
import { proposeRailChange } from '../../src/domain/controls.js';
import { reverseEntry } from '../../src/domain/reversals.js';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';

/** Batch C spec "Life events": six kinds, review lines per kind, and the two IPS stop-events. */
let db: Db;
const NOW = '2026-10-31T06:00:00Z';
const at = (h: number) => `2026-10-31T${String(6 + h).padStart(2, '0')}:00:00Z`;

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});
afterEach(async () => { await db.close(); });

describe('logLifeEvent', () => {
  const ok: [LifeEventKind, Parameters<typeof logLifeEvent>[1]][] = [
    ['SALARY_CHANGE', { kind: 'SALARY_CHANGE', on: '2026-10-01', amountPaise: 2_50_000_00n, note: 'raise' }],
    ['JOB_LOSS', { kind: 'JOB_LOSS', on: '2026-10-01', detail: { expectedOn: '2027-01-01' }, note: '' }],
    ['NEW_DEPENDENT', { kind: 'NEW_DEPENDENT', on: '2026-10-01', detail: { expectedOn: '2027-06-01' }, note: '' }],
    ['RETIREMENT_AGE', { kind: 'RETIREMENT_AGE', on: '2026-10-01', detail: { fiTargetAge: 50 }, note: '' }],
    ['MEDICAL_EXPENSE', { kind: 'MEDICAL_EXPENSE', on: '2026-10-01', amountPaise: 5_00_000_00n, note: '' }],
  ];
  it.each(ok)('logs %s with an owner audit row keyed for reversal', async (kind, e) => {
    const { id } = await logLifeEvent(db, e, NOW);
    const [row] = await db.query<{ kind: string; source: string }>(`select kind, source from life_events where id = $1`, [id]);
    expect(row).toEqual({ kind, source: 'owner-web' });
    const audit = await db.query(`select 1 from audit_log where actor = 'owner' and entity = 'life_event' and payload->>'rowId' = $1`, [id]);
    expect(audit).toHaveLength(1);
  });

  const bad: [string, Parameters<typeof logLifeEvent>[1], RegExp][] = [
    ['salary without amount', { kind: 'SALARY_CHANGE', on: '2026-10-01', note: '' }, /amount/],
    ['job loss in the future', { kind: 'JOB_LOSS', on: '2026-11-15', note: '' }, /future/],
    ['dependent without expected date', { kind: 'NEW_DEPENDENT', on: '2026-10-01', note: '' }, /expected/],
    ['a windfall (it is Money received)', { kind: 'WINDFALL', on: '2026-10-01', amountPaise: 10_00_000_00n, detail: { from: 'inheritance' }, note: '' }, /log a windfall under Money received/],
    ['FI age 76', { kind: 'RETIREMENT_AGE', on: '2026-10-01', detail: { fiTargetAge: 76 }, note: '' }, /35–75/],
    ['FI age 50.5', { kind: 'RETIREMENT_AGE', on: '2026-10-01', detail: { fiTargetAge: 50.5 }, note: '' }, /35–75/],
    ['medical without amount', { kind: 'MEDICAL_EXPENSE', on: '2026-10-01', note: '' }, /amount/],
  ];
  it.each(bad)('refuses %s', async (_, e, msg) => {
    await expect(logLifeEvent(db, e, NOW)).rejects.toThrow(msg);
  });

  it('a new dependent may be logged with a future date', async () => {
    await expect(logLifeEvent(db, { kind: 'NEW_DEPENDENT', on: '2027-03-01', detail: { expectedOn: '2027-03-01' }, note: '' }, NOW))
      .resolves.toHaveProperty('id');
  });
});

describe('review lines', () => {
  it('REVIEW_ITEMS matches the spec table', () => {
    const keys = Object.fromEntries(Object.entries(REVIEW_ITEMS).map(([k, v]) => [k, v.map((i) => `${i.kind}:${i.key}`)]));
    expect(keys).toEqual({
      SALARY_CHANGE: ['rail:monthly_budget_paise', 'rail:goal_setaside_monthly_paise', 'constant:salaryStepUp', 'goal:emergency_target'],
      JOB_LOSS: ['goal:emergency_target', 'rail:monthly_budget_paise'],
      NEW_DEPENDENT: ['constant:childArrivalYear', 'constant:childMonthlyDentInr', 'goal:emergency_target', 'goal:education_goal'],
      WINDFALL: [],
      RETIREMENT_AGE: ['constant:fiTargetAge', 'constant:fund_mix_horizon'],
      MEDICAL_EXPENSE: ['goal:emergency_target'],
    });
    expect(REVIEW_ITEMS.RETIREMENT_AGE[1]!.label).toBe('fund-mix horizon band — re-proposal follows the age');
  });

  it('a salary change yields its 3 rail and constant lines, all open, with current values', async () => {
    const { id } = await logLifeEvent(db, { kind: 'SALARY_CHANGE', on: '2026-10-01', amountPaise: 2_50_000_00n, note: '' }, NOW);
    const lines = await loadReviewLines(db, NOW);
    // Derived from the table, so dropping an item from REVIEW_ITEMS changes the expectation.
    const expected = REVIEW_ITEMS.SALARY_CHANGE.filter((i) => i.kind !== 'goal').map((i) => i.key);
    expect(lines.map((l) => l.key)).toEqual(expected);
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.eventId === id && l.eventKind === 'SALARY_CHANGE' && l.eventOn === '2026-10-01' && l.state === 'OPEN')).toBe(true);
    expect(lines.find((l) => l.key === 'salaryStepUp')!.current).toBe(String(ASSUMPTIONS.salaryStepUp));
    expect(lines.find((l) => l.key === 'monthly_budget_paise')!.current).toBe('₹50,000');
  });

  it('a constant with no code value has a null current, never "undefined"', async () => {
    await logLifeEvent(db, { kind: 'RETIREMENT_AGE', on: '2026-10-01', detail: { fiTargetAge: 50 }, note: '' }, NOW);
    const lines = await loadReviewLines(db, NOW);
    expect(lines.find((l) => l.key === 'fund_mix_horizon')!.current).toBeNull();
    expect(lines.find((l) => l.key === 'fiTargetAge')!.current).toBe(String(ASSUMPTIONS.fiTargetAge));
  });

  it('STILL_RIGHT closes a constant line; NEEDS_CHANGE needs text, waits, and a later STILL_RIGHT closes it', async () => {
    const { id } = await logLifeEvent(db, { kind: 'NEW_DEPENDENT', on: '2026-10-01', detail: { expectedOn: '2027-06-01' }, note: '' }, NOW);
    await reviewLine(db, { eventId: id, key: 'childArrivalYear', outcome: 'STILL_RIGHT' }, at(1));
    await expect(reviewLine(db, { eventId: id, key: 'childMonthlyDentInr', outcome: 'NEEDS_CHANGE' }, at(1))).rejects.toThrow(/new value/);
    await reviewLine(db, { eventId: id, key: 'childMonthlyDentInr', outcome: 'NEEDS_CHANGE', newValueText: '15000' }, at(2));
    let lines = await loadReviewLines(db, at(3));
    expect(lines.map((l) => [l.key, l.state, l.newValueText])).toEqual([['childMonthlyDentInr', 'NEEDS_CHANGE', '15000']]);
    await reviewLine(db, { eventId: id, key: 'childMonthlyDentInr', outcome: 'STILL_RIGHT' }, at(3));
    lines = await loadReviewLines(db, at(4));
    expect(lines).toEqual([]);
  });

  it('refuses a key that is not one of the event kind\'s items', async () => {
    const { id } = await logLifeEvent(db, { kind: 'MEDICAL_EXPENSE', on: '2026-10-01', amountPaise: 1_00_000_00n, note: '' }, NOW);
    await expect(reviewLine(db, { eventId: id, key: 'salaryStepUp', outcome: 'STILL_RIGHT' }, at(1))).rejects.toThrow(/salaryStepUp/);
    // A goal key is one of its items: the web module's goal lines use the same buttons.
    await expect(reviewLine(db, { eventId: id, key: 'emergency_target', outcome: 'STILL_RIGHT' }, at(1))).resolves.toBeUndefined();
  });

  it('a rail line closes after a rail proposal newer than the event, not an older one', async () => {
    // proposeRailChange stamps audit_log.at with the database clock, so the event sits a day earlier.
    const eventNow = new Date(Date.now() - 86_400_000).toISOString();
    await db.query(`insert into audit_log (at, entity, entity_id, action, actor) values ($1, 'rail', 'monthly_budget_paise', 'RAIL_CHANGE_PROPOSED', 'owner')`,
      [new Date(Date.now() - 2 * 86_400_000).toISOString()]);
    await logLifeEvent(db, { kind: 'JOB_LOSS', on: eventNow.slice(0, 10), note: '' }, eventNow);
    expect((await loadReviewLines(db, new Date().toISOString())).map((l) => l.key)).toEqual(['monthly_budget_paise']);
    await proposeRailChange(db, 'monthly_budget_paise', 40_00_000); // a lower budget is a tightening
    expect(await loadReviewLines(db, new Date().toISOString())).toEqual([]);
  });

  it('a rail proposal later refused by the cooling-off check leaves the line open; one after now does not count', async () => {
    const day = 86_400_000;
    const iso = (ms: number) => new Date(ms).toISOString();
    const t0 = Date.now() - 10 * day;
    await logLifeEvent(db, { kind: 'JOB_LOSS', on: iso(t0).slice(0, 10), note: '' }, iso(t0));
    const audit = (ms: number, action: string) => db.query(
      `insert into audit_log (at, entity, entity_id, action, actor) values ($1, 'rail', 'monthly_budget_paise', $2, 'agent')`, [iso(ms), action]);
    await audit(t0 + day, 'RAIL_CHANGE_PROPOSED');
    await audit(t0 + 3 * day, 'RAIL_CHANGE_REFUSED');
    expect((await loadReviewLines(db, iso(t0 + 4 * day))).map((l) => l.key)).toEqual(['monthly_budget_paise']);
    // A proposal not yet made at the review's clock does not close the line.
    await audit(t0 + 5 * day, 'RAIL_CHANGE_PROPOSED');
    expect((await loadReviewLines(db, iso(t0 + 4 * day))).map((l) => l.key)).toEqual(['monthly_budget_paise']);
    expect(await loadReviewLines(db, iso(t0 + 6 * day))).toEqual([]);
  });

  it('a reversed event has no lines', async () => {
    const { id } = await logLifeEvent(db, { kind: 'SALARY_CHANGE', on: '2026-10-01', amountPaise: 2_50_000_00n, note: '' }, NOW);
    await reverseEntry(db, { entity: 'life_event', entityId: id, reason: 'typo' }, at(1));
    expect(await loadReviewLines(db, at(2))).toEqual([]);
  });
});

describe('stopEventsInForce', () => {
  const NOV = '2026-11-15T06:00:00Z';
  it('a job loss counts from three months, and not once ended', async () => {
    await logLifeEvent(db, { kind: 'JOB_LOSS', on: '2026-09-15', note: '' }, NOV); // 2 months
    expect(await stopEventsInForce(db, NOV)).toEqual([]);
    const { id } = await logLifeEvent(db, { kind: 'JOB_LOSS', on: '2026-08-15', note: '' }, NOV); // 3 months
    const stops = await stopEventsInForce(db, NOV);
    expect(stops).toEqual([{ eventId: id, kind: 'JOB_LOSS', since: '2026-08-15',
      text: 'IPS stop-event in force (job loss since 2026-08-15): pausing SIPs is permitted, not advised. Sentinel changes nothing.' }]);
    await endLifeEvent(db, { eventId: id, on: '2026-11-10', note: 'new job' }, NOV);
    expect(await stopEventsInForce(db, NOV)).toEqual([]);
    await expect(endLifeEvent(db, { eventId: id, on: '2026-11-11', note: '' }, NOV)).rejects.toThrow(/already ended/);
  });

  it('a medical expense counts above ₹30,00,000, not at it', async () => {
    await logLifeEvent(db, { kind: 'MEDICAL_EXPENSE', on: '2026-11-01', amountPaise: 300_000_000n, note: '' }, NOV);
    expect(await stopEventsInForce(db, NOV)).toEqual([]);
    const { id } = await logLifeEvent(db, { kind: 'MEDICAL_EXPENSE', on: '2026-11-02', amountPaise: 300_000_100n, note: '' }, NOV);
    const stops = await stopEventsInForce(db, NOV);
    expect(stops.map((s) => [s.eventId, s.kind, s.since])).toEqual([[id, 'MEDICAL_EXPENSE', '2026-11-02']]);
    expect(stops[0]!.text).toBe('IPS stop-event in force (medical expense ₹30,00,001): pausing SIPs is permitted, not advised. Sentinel changes nothing.');
  });

  it('only a job loss or a medical expense can be ended', async () => {
    const { id } = await logLifeEvent(db, { kind: 'SALARY_CHANGE', on: '2026-11-01', amountPaise: 1n, note: '' }, NOV);
    await expect(endLifeEvent(db, { eventId: id, on: '2026-11-02', note: '' }, NOV)).rejects.toThrow(/job loss or a medical expense/);
  });

  it('a reversed end puts the stop-event back in force', async () => {
    const { id } = await logLifeEvent(db, { kind: 'JOB_LOSS', on: '2026-08-01', note: '' }, NOV);
    const end = await endLifeEvent(db, { eventId: id, on: '2026-11-10', note: '' }, NOV);
    await reverseEntry(db, { entity: 'life_event', entityId: end.id, reason: 'not yet' }, NOV);
    expect(await stopEventsInForce(db, NOV)).toHaveLength(1);
  });
});

it('the domain module imports no goal reader (no-catch-up)', () => {
  const src = readFileSync(new URL('../../src/domain/life-events.ts', import.meta.url), 'utf8');
  expect(src).not.toMatch(/goal-plan|funded-status|buckets\.js/);
});
