import type { Db } from '../db/client.js';
import { decideProposal, loadProposals } from '../advisor/proposals.js';
import type { RevisionLine } from '../advisor/watchlist.js';

/**
 * The owner's per-line sign-off on a quarterly watchlist revision (Phase 2.5 Task 9),
 * outside src/advisor/. An accepted ADD appends a watchlist row; an accepted REMOVE appends
 * a `watchlist_removals` event (the watchlist itself is append-only). A declined line
 * changes nothing. Each line is decided once, recorded in audit_log; when every line is
 * decided the revision is marked signed.
 */
export async function decideWatchlistLine(
  db: Db, proposalId: number, line: number, accept: boolean, on: string,
): Promise<void> {
  const p = (await loadProposals(db, 'WATCHLIST_REVISION', 200)).find((x) => x.id === proposalId);
  if (!p) throw new Error(`no watchlist revision ${proposalId}`);
  const lines = (p.payload['lines'] ?? []) as RevisionLine[];
  const l = lines[line];
  if (!l) throw new Error(`revision ${proposalId} has no line ${line}`);
  const key = `${proposalId}:${line}`;
  const done = await db.query(`select 1 from audit_log where entity = 'watchlist_revision' and entity_id = $1`, [key]);
  if (done.length > 0) throw new Error(`line ${line} is already decided`);

  await db.withTransaction(async (tx) => {
    if (accept && l.op === 'ADD') {
      await tx.query(
        `insert into watchlist (instrument_id, added_on, source, reason)
         select $1, $2::date, 'owner-signed', $3
          where not exists (select 1 from watchlist_effective where instrument_id = $1 and removed_on is null)`,
        [l.instrumentId, on, l.reason]);
    }
    if (accept && l.op === 'REMOVE') {
      await tx.query(`insert into watchlist_removals (instrument_id, removed_on, reason, source) values ($1, $2, $3, 'owner-signed')`,
        [l.instrumentId, on, l.reason]);
    }
    await tx.query(
      `insert into audit_log (entity, entity_id, action, actor, payload) values ('watchlist_revision', $1, $2, 'owner', $3::jsonb)`,
      [key, accept ? 'ACCEPTED' : 'DECLINED', JSON.stringify({ ...l, on })]);
  });

  const decided = await db.query(`select 1 from audit_log where entity = 'watchlist_revision' and entity_id like $1`, [`${proposalId}:%`]);
  if (decided.length === lines.length) await decideProposal(db, proposalId, 'SIGNED', `${lines.length} line(s) decided`);
}
