import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { alreadyReportedFor, loadReportRuns, recordReportRun } from '../../src/jobs/report.js';

/**
 * The weekly narration was composed, sent to Telegram and dropped, which is why
 * `/narrative` stayed a shell — there was no row to read. It is now kept in the same
 * `audit_log` row that already recorded the run, beside the deterministic bullets it
 * rewrites: a narration is only worth reading back next to the engine output it came
 * from, to see whether it drifted.
 */
describe('a delivered weekly report keeps what it said', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
  });

  const bullets = ['Net worth Rs 45.2L, up 1.1% on the week', 'No action this month'];

  it('stores the narration, the bullets and the delivered text', async () => {
    await recordReportRun(db, '2026-09-20', {
      sent: true, narrative: 'A quiet week. Nothing needs doing.', bullets, text: 'full message',
    });

    const [run] = await loadReportRuns(db);
    expect(run!.asOf).toBe('2026-09-20');
    expect(run!.narrative).toBe('A quiet week. Nothing needs doing.');
    expect(run!.bullets).toEqual(bullets);
    expect(run!.text).toBe('full message');
    await db.close();
  });

  it('records nothing for a dry run, so it cannot mask a failed send', async () => {
    await recordReportRun(db, '2026-09-20', { sent: false, narrative: 'x', bullets });
    expect(await loadReportRuns(db)).toEqual([]);
    // And the idempotence guard must still let the real run through afterwards.
    expect(await alreadyReportedFor(db, '2026-09-20')).toBe(false);
    await db.close();
  });

  it('reads a run stored before the narration was kept, without inventing one', async () => {
    // The shape `recordReportRun` wrote before 2026-09-21.
    await db.query(
      `insert into audit_log (entity, entity_id, action, actor, payload)
       values ('weekly_report', '2026-09-13', 'REPORT_SENT', 'system',
               '{"asOf":"2026-09-13","sent":true}'::jsonb)`,
    );
    const [run] = await loadReportRuns(db);
    expect(run!.narrative).toBeNull();
    expect(run!.bullets).toEqual([]);
    await db.close();
  });

  it('returns runs newest first', async () => {
    await recordReportRun(db, '2026-09-06', { sent: true, narrative: 'older', bullets });
    await recordReportRun(db, '2026-09-13', { sent: true, narrative: 'newer', bullets });
    expect((await loadReportRuns(db)).map((r) => r.asOf)).toEqual(['2026-09-13', '2026-09-06']);
    await db.close();
  });

  it('a narration that was never produced stays null, never an empty string', async () => {
    await recordReportRun(db, '2026-09-20', { sent: true, bullets });
    const [run] = await loadReportRuns(db);
    // No LLM key configured. An empty string would render as a blank narration panel
    // and read as "the model said nothing", which is a different fact.
    expect(run!.narrative).toBeNull();
    await db.close();
  });
});
