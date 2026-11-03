import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { logLifeEvent } from '../../src/domain/life-events.js';
import { stopEventLines } from '../../src/jobs/report.js';

/** Batch C Task 8: the weekly report carries one line per IPS stop-event in force. */
const NOW = '2026-11-15T06:00:00Z';
let db: Db;
beforeEach(async () => { db = await openDb(); await runMigrations(db); });

describe('stopEventLines', () => {
  it('a job loss of 3+ months adds the stop-event line', async () => {
    await logLifeEvent(db, { kind: 'JOB_LOSS', on: '2026-08-01', note: '' }, NOW);
    expect(await stopEventLines(db, NOW)).toBe(
      '\n\nIPS stop-event in force (job loss since 2026-08-01): pausing SIPs is permitted, not advised. Sentinel changes nothing.');
  });

  it('without a stop-event there is no line', async () => {
    await logLifeEvent(db, { kind: 'JOB_LOSS', on: '2026-10-01', note: '' }, NOW);
    expect(await stopEventLines(db, NOW)).not.toContain('pausing SIPs is permitted, not advised');
    expect(await stopEventLines(db, NOW)).toBe('');
  });
});
