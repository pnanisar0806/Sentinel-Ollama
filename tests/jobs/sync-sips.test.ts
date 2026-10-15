import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { runSync } from '../../src/jobs/sync.js';
import { FileIndmoneySource, parseMfSips } from '../../src/sources/indmoney.js';
import { assessStaleness } from '../../src/sources/staleness.js';

const live = parseMfSips({
  result: JSON.stringify(JSON.parse(await readFile('tests/fixtures/indmoney-mf-sips-2026-10-14.json', 'utf8')).payload),
});
const NOW = '2026-10-14T17:30:00+05:30';
let db: Db;
beforeEach(async () => { db = await openDb(); await runMigrations(db); await seed(db, { asOf: '2026-10-14' }); });
const sources = () => [new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json')];

describe('indmoney-sips sync step', () => {
  it('writes one snapshot of the live SIPs', async () => {
    const r = await runSync(db, { now: NOW, sources: sources(), fetchSips: async () => ({ rows: live, asOf: NOW }) });
    expect(r.synced).toContain('indmoney-sips');
    expect(await db.query('select 1 from sip_snapshots')).toHaveLength(1);
    expect(await db.query('select 1 from sips')).toHaveLength(live.length);
  });

  it('a failed fetch writes nothing and opens a WARN, then a BLOCK', async () => {
    const fetchSips = async () => { throw new Error('INDmoney refused mf_sips: rate_limit_exceeded'); };
    await runSync(db, { now: NOW, sources: sources(), fetchSips });
    await runSync(db, { now: NOW, sources: sources(), fetchSips });
    expect(await db.query('select 1 from sip_snapshots')).toHaveLength(0);
    const inc = await db.query<{ severity: string }>(
      `select severity from incidents where kind = 'SYNC_FAILURE' and subject = 'indmoney-sips' order by opened_at`);
    expect(inc.map((i) => i.severity)).toEqual(['WARN', 'BLOCK']);
  });

  it('no fetcher is an explicit skip, never a success', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await runSync(db, { now: NOW, sources: sources() });
    const said = err.mock.calls.map((c) => String(c[0]));
    err.mockRestore();
    expect(said.some((m) => m.startsWith('indmoney-sips skipped'))).toBe(true);
    expect(r.synced).not.toContain('indmoney-sips');
    expect(r.failed.map((f) => f.source)).not.toContain('indmoney-sips');
  });

  it('staleness assesses indmoney-sips against a 7-day limit', async () => {
    const row = (await assessStaleness(db, NOW)).find((s) => s.source === 'indmoney-sips');
    expect(row).toMatchObject({ limitHours: 168, stale: true }); // never synced
  });

  it('a synced snapshot is fresh for 7 days, then stale', async () => {
    await runSync(db, { now: NOW, sources: sources(), fetchSips: async () => ({ rows: live, asOf: NOW }) });
    const at = async (now: string) => (await assessStaleness(db, now)).find((s) => s.source === 'indmoney-sips');
    expect(await at('2026-10-21T17:30:00+05:30')).toMatchObject({ stale: false });
    expect(await at('2026-10-21T17:30:01+05:30')).toMatchObject({ stale: true });
  });
});
