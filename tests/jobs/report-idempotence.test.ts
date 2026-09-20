import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { alreadyReportedFor, recordReportRun } from '../../src/jobs/report.js';

/**
 * The weekly report is scheduled once a week, and GitHub Actions drops scheduled runs
 * under load — the Sunday 2026-09-20 slot was dropped, which is what motivated a retry
 * cron. A retry is only safe if a second run on the same business date is a no-op:
 * `persistRecommendation` is a plain INSERT into an append-only table, so a duplicate
 * run would write advisory rows that cannot be deleted afterwards.
 */
describe('weekly report idempotence', () => {
  let db: Db;

  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
  });

  it('reports not-yet-run for a date with no audit row', async () => {
    expect(await alreadyReportedFor(db, '2026-09-20')).toBe(false);
    await db.close();
  });

  it('reports already-run once the run has been recorded', async () => {
    await recordReportRun(db, '2026-09-20', { sent: true });
    expect(await alreadyReportedFor(db, '2026-09-20')).toBe(true);
    await db.close();
  });

  it('keeps business dates independent', async () => {
    await recordReportRun(db, '2026-09-20', { sent: true });
    expect(await alreadyReportedFor(db, '2026-09-27')).toBe(false);
    await db.close();
  });

  it('writes one append-only audit row carrying the date and outcome', async () => {
    await recordReportRun(db, '2026-09-20', { sent: true });
    const rows = await db.query<{
      entity: string; entity_id: string; action: string; actor: string; payload: unknown;
    }>(
      `select entity, entity_id, action, actor, payload from audit_log
        where entity = 'weekly_report'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity: 'weekly_report',
      entity_id: '2026-09-20',
      action: 'REPORT_SENT',
      actor: 'system',
    });
    // jsonb must arrive as an object, not a JSON string double-encoded into the column.
    expect(rows[0]!.payload).toMatchObject({ asOf: '2026-09-20', sent: true });
    await db.close();
  });

  // A dry run composed the report but delivered nothing, so it must not block the real
  // run that follows it.
  it('does not mark the date as reported when nothing was sent', async () => {
    await recordReportRun(db, '2026-09-20', { sent: false });
    expect(await alreadyReportedFor(db, '2026-09-20')).toBe(false);
    await db.close();
  });
});
