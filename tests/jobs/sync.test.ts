import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { runSync } from '../../src/jobs/sync.js';
import { FileIndmoneySource } from '../../src/sources/indmoney.js';
import type { Source } from '../../src/sources/types.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

const failing: Source = {
  name: 'composite',
  fetch: async () => { throw new Error('Invalid access token'); },
};

describe('sync job', () => {
  it('writes a snapshot per healthy source', async () => {
    const result = await runSync(db, {
      now: '2026-08-12T17:30:00+05:30',
      sources: [new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json')],
    });
    // indmoney + nse-bhavcopy (weekday, no network call = skipped with log)
    expect(result.synced).toEqual(expect.arrayContaining(['indmoney']));
    expect(result.failed).toEqual([]);
  });

  it('records a failing source without aborting the healthy ones', async () => {
    const result = await runSync(db, {
      now: '2026-08-12T17:30:00+05:30',
      sources: [failing, new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json')],
    });
    expect(result.synced).toEqual(expect.arrayContaining(['indmoney']));
    expect(result.failed[0]).toMatchObject({ source: 'composite' });
    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents where kind = 'SYNC_FAILURE' and resolved_at is null`,
    );
    expect(Number(open[0]!.n)).toBe(1);
  });

  // The escalation test alone never pinned the FIRST severity, so hard-coding
  // severity = 'BLOCK' in runSync stayed green and the WARN->BLOCK ladder was untested.
  it('records the FIRST failure as WARN, not BLOCK', async () => {
    await runSync(db, { now: '2026-08-12T17:30:00+05:30', sources: [failing] });
    const rows = await db.query<{ severity: string }>(
      `select severity from incidents where kind = 'SYNC_FAILURE' order by opened_at`,
    );
    expect(rows.map((r) => r.severity)).toEqual(['WARN']);
  });

  it('escalates to BLOCK severity after two consecutive failures (PRD 8.2)', async () => {
    const opts = { now: '2026-08-12T17:30:00+05:30', sources: [failing] };
    await runSync(db, opts);
    await runSync(db, { ...opts, now: '2026-08-13T17:30:00+05:30' });
    const rows = await db.query<{ severity: string }>(
      `select severity from incidents where kind = 'SYNC_FAILURE' order by opened_at`,
    );
    // The whole ladder, in order — not merely "a BLOCK exists somewhere".
    expect(rows.map((r) => r.severity)).toEqual(['WARN', 'BLOCK']);
  });

  it('de-escalates: a recovered source resolves its incident', async () => {
    const opts = { now: '2026-08-12T17:30:00+05:30', sources: [failing] };
    await runSync(db, opts);

    const healthy = {
      name: failing.name,
      fetch: async () => ({ rows: [], asOf: '2026-08-13T00:00:00Z' }),
    };
    await runSync(db, { now: '2026-08-13T17:30:00+05:30', sources: [healthy] });

    const open = await db.query<{ n: string }>(
      `select count(*) as n from incidents
        where kind = 'SYNC_FAILURE' and subject = $1 and resolved_at is null`,
      [failing.name],
    );
    expect(Number(open[0]!.n)).toBe(0);
  });

  it('refreshes loan schedules and projected vests as part of the sync', async () => {
    await runSync(db, {
      now: '2026-08-12T17:30:00+05:30',
      sources: [new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json')],
    });
    const [sched] = await db.query<{ n: string }>('select count(*) as n from loan_schedule');
    const [vests] = await db.query<{ n: string }>('select count(*) as n from rsu_vests');
    expect(Number(sched!.n)).toBeGreaterThan(0);
    expect(Number(vests!.n)).toBeGreaterThan(0);
  });

  it('never projects model tranches onto a grant whose schedule comes from the statement', async () => {
    // The statement's tranches are the schedule for these grants. A quarterly model row
    // beside them (2026-11-15 on the semi-annual 21RUIN4A1, say) is a vest that does not
    // exist; three of them were the ~Rs 4L "vesting on 15 Nov" the digest kept showing.
    await runSync(db, {
      now: '2026-09-26T17:30:00+05:30',
      sources: [new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json')],
    });
    const statementGrants = await db.query<{ grant_id: string }>(
      `select distinct grant_id from rsu_vests where source = 'fidelity-awards-details'`);
    expect(statementGrants.length).toBeGreaterThan(0);
    const phantom = await db.query<{ grant_id: string; vest_on: string }>(
      `select grant_id, vest_on::text from rsu_vests
        where source = 'model'
          and grant_id in (select grant_id from rsu_vests where source = 'fidelity-awards-details')`);
    expect(phantom).toEqual([]);
  });
});
describe('EOD quote steps (Phase 1 Task 13)', () => {
  const equityRow = {
    isin: 'INE040A01034', symbol: 'HDFCBANK', series: 'EQ',
    close: 1650.25, prevClose: 1640.10, tradeDate: '2026-09-11',
  };

  it('ingests prices and NAVs when the fetchers are wired', async () => {
    await db.query(`update instruments set isin = $1 where id = 'NSE:RPOWER'`, [equityRow.isin]);
    const result = await runSync(db, {
      now: '2026-09-11T12:00:00Z',
      sources: [],
      fetchPrices: async () => ({
        equity: [equityRow],
        index: [{ seriesCode: 'NIFTY 500', close: 24000.5, tradeDate: '2026-09-11' }],
      }),
      fetchNavs: async () => ({ rows: [] }),
    });

    expect(result.synced).toContain('nse-bhavcopy');
    expect(result.synced).toContain('amfi');
    const [price] = await db.query<{ close_paise: string | number | bigint }>(
      `select close_paise from prices_eod where instrument_id = 'NSE:RPOWER'`,
    );
    // 1650.25 rupees, carried as paise without a float round-trip.
    expect(BigInt(price!.close_paise)).toBe(165_025n);
  });

  it('skips the step loudly instead of reporting success with no fetcher', async () => {
    // The placeholder version ran, did nothing, and recorded a successful sync — the
    // silent degradation PRD 8.2 forbids.
    const result = await runSync(db, { now: '2026-09-11T12:00:00Z', sources: [] });
    expect(result.synced).not.toContain('nse-bhavcopy');
    expect(result.synced).not.toContain('amfi');
    expect(result.failed).toEqual([]);
  });

  it('does not ask NSE for a weekend', async () => {
    let asked = false;
    const result = await runSync(db, {
      now: '2026-09-13T12:00:00Z', // a Sunday
      sources: [],
      fetchPrices: async () => {
        asked = true;
        return { equity: [], index: [] };
      },
    });
    expect(asked).toBe(false);
    expect(result.synced).toContain('nse-bhavcopy');
  });

  it('raises a SYNC_FAILURE when the download itself fails', async () => {
    const result = await runSync(db, {
      now: '2026-09-11T12:00:00Z',
      sources: [],
      fetchPrices: async () => {
        throw new Error('NSE moved the archive path');
      },
    });
    expect(result.failed.map((f) => f.source)).toContain('nse-bhavcopy');
    const open = await db.query<{ subject: string }>(
      `select subject from incidents where kind = 'SYNC_FAILURE' and resolved_at is null`,
    );
    expect(open.map((r) => r.subject)).toContain('nse-bhavcopy');
  });
});
