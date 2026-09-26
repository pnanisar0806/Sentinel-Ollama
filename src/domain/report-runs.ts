import type { Db } from '../db/client.js';

/**
 * The record of a delivered weekly report, and what it said.
 *
 * This lives in `domain` rather than in `jobs/report.ts` because the web app reads it:
 * importing the job module pulls in `runMigrations`, whose dynamic `../../migrations`
 * import Next cannot resolve, and the build fails with
 * `Module not found: Can't resolve '../../migrations'`.
 */
export async function alreadyReportedFor(db: Db, asOf: string): Promise<boolean> {
  const rows = await db.query<{ one: number }>(
    `select 1 as one from audit_log
      where entity = 'weekly_report' and entity_id = $1 and action = 'REPORT_SENT' limit 1`,
    [asOf],
  );
  return rows.length > 0;
}

export interface ReportRunRecord {
  asOf: string;
  /** The LLM's prose. NULL when no key was configured or the model refused. */
  narrative: string | null;
  /** The deterministic summary the narrative rewrites. Kept so the two can be compared. */
  bullets: string[];
  /** What the owner was actually sent. */
  text: string;
}

/**
 * Records a delivered report, with what it said.
 *
 * A dry run delivered nothing, so it is not recorded and must not block the real run
 * that follows it.
 *
 * The narrative used to be composed, sent to Telegram and dropped, which is why
 * `/narrative` stayed a shell: there was no row to read. It is kept beside the bullets
 * it rewrites, because a narration is only trustworthy next to the deterministic
 * summary it came from — the point of reading it back later is to check it did not
 * drift from the engine.
 *
 * `audit_log` already carries the run record and is append-only, so this is the same
 * row gaining its content rather than a second place to look.
 */
export async function recordReportRun(
  db: Db,
  asOf: string,
  meta: { sent: boolean } & Partial<Omit<ReportRunRecord, 'asOf'>>,
): Promise<void> {
  if (!meta.sent) return;
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('weekly_report', $1, 'REPORT_SENT', 'system', $2::jsonb)`,
    [asOf, JSON.stringify({
      asOf,
      sent: true,
      narrative: meta.narrative ?? null,
      bullets: meta.bullets ?? [],
      text: meta.text ?? null,
    })],
  );
}

/** Delivered reports, newest first. Rows with no stored narrative predate its capture. */
export async function loadReportRuns(db: Db, limit = 20): Promise<ReportRunRecord[]> {
  const rows = await db.query<{ entity_id: string; payload: unknown }>(
    `select entity_id, payload from audit_log
      where entity = 'weekly_report' and action = 'REPORT_SENT'
      order by at desc, id desc limit $1`,
    [limit],
  );
  return rows.map((r) => {
    const p = (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as
      Partial<ReportRunRecord>;
    return {
      asOf: r.entity_id,
      narrative: p.narrative ?? null,
      bullets: Array.isArray(p.bullets) ? p.bullets : [],
      text: p.text ?? '',
    };
  });
}
