import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import {
  completeMilestone, loadOwnerTimeline, logGoalMove, logNote, logPurchase,
} from '../../src/domain/owner-log.js';

/**
 * The owner tells Sentinel what they did — moved money into a goal, finished a
 * milestone, anything else — from the web app instead of in a chat. Each entry is a fact
 * the rest of the system reads, and each lands in the audit trail.
 */
let db: Db;
const NOW = '2026-09-27T10:00:00Z';
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

describe('moving money into or out of a goal', () => {
  it('records a deposit B3 then counts as funded', async () => {
    await logGoalMove(db, {
      bucketId: 'B3', occurredOn: '2026-09-26', amountPaise: 32_430_000n,
      kind: 'maturity', note: 'Sammaan 2026 proceeds into IDFC First',
    }, NOW);
    const [row] = await db.query<{ amount_paise: string; kind: string; source: string }>(
      `select amount_paise::text, kind, source from bucket_flows where bucket_id = 'B3'`);
    expect(row).toEqual({ amount_paise: '32430000', kind: 'maturity', source: 'owner-web' });
    const [audit] = await db.query<{ action: string; actor: string }>(
      `select action, actor from audit_log where entity = 'bucket_flow'`);
    expect(audit).toEqual({ action: 'LOGGED', actor: 'owner' });
  });

  it('stores a withdrawal as a negative flow', async () => {
    await logGoalMove(db, {
      bucketId: 'B3', occurredOn: '2026-09-26', amountPaise: 1_000_000n, kind: 'withdrawal', note: '',
    }, NOW);
    const [row] = await db.query<{ amount_paise: string }>(`select amount_paise::text from bucket_flows`);
    expect(row!.amount_paise).toBe('-1000000');
  });

  it('refuses a zero amount, a future date and an unknown goal', async () => {
    const base = { bucketId: 'B3', occurredOn: '2026-09-26', amountPaise: 100n, kind: 'sip' as const, note: '' };
    await expect(logGoalMove(db, { ...base, amountPaise: 0n }, NOW)).rejects.toThrow(/positive/);
    await expect(logGoalMove(db, { ...base, occurredOn: '2026-09-28' }, NOW)).rejects.toThrow(/future/);
    await expect(logGoalMove(db, { ...base, bucketId: 'B9' }, NOW)).rejects.toThrow(/goal/);
    expect(await db.query(`select 1 from bucket_flows`)).toHaveLength(0);
  });
});

describe('milestones and notes', () => {
  it('marks a milestone complete once, and says so the second time', async () => {
    await db.query(`update milestones set completed_on = null`);
    await completeMilestone(db, 'M1', '2026-09-20', NOW);
    const [m] = await db.query<{ completed_on: string }>(`select completed_on::text from milestones where id = 'M1'`);
    expect(m!.completed_on).toBe('2026-09-20');
    await expect(completeMilestone(db, 'M1', '2026-09-21', NOW)).rejects.toThrow(/already/);
  });

  it('keeps a free-text note, and refuses an empty one', async () => {
    await logNote(db, { on: '2026-09-25', text: 'Opened an IDFC First savings account' }, NOW);
    await expect(logNote(db, { on: '2026-09-25', text: '   ' }, NOW)).rejects.toThrow(/empty/);
  });
});

describe('the timeline', () => {
  it('lists what the owner did, newest first, and nothing the system did', async () => {
    await logNote(db, { on: '2026-09-25', text: 'Opened an IDFC First savings account' }, NOW);
    await logGoalMove(db, {
      bucketId: 'B3', occurredOn: '2026-09-26', amountPaise: 32_430_000n, kind: 'maturity', note: 'Sammaan',
    }, NOW);
    await db.query(`insert into audit_log (entity, entity_id, action, actor) values ('rsu_vest', 'v1', 'CONFIRMED', 'system')`);
    const t = await loadOwnerTimeline(db);
    expect(t.map((e) => e.on)).toEqual(['2026-09-26', '2026-09-25']);
    expect(t[0]!.summary).toContain('B3');
    expect(t.some((e) => e.kind === 'RSU')).toBe(false);
  });
});

describe('a purchase made outside Sentinel', () => {
  const base = { boughtOn: '2026-09-26', description: 'Zerodha Gold ETF', amountPaise: 1_000_000n };

  it('is stored with as_of and owner-web source, and audited as the owner, in one go', async () => {
    await logPurchase(db, { ...base, instrumentId: 'NSE:GOLDBEES', units: '12.5', note: ' top-up ' }, NOW);
    const [row] = await db.query<Record<string, string | null>>(
      `select bought_on::text, instrument_id, description, amount_paise::text, units::text, note, as_of::text, source from owner_purchases`);
    expect(row).toMatchObject({
      bought_on: '2026-09-26', instrument_id: 'NSE:GOLDBEES', description: 'Zerodha Gold ETF',
      amount_paise: '1000000', units: '12.5', note: 'top-up', source: 'owner-web',
    });
    expect(row!['as_of']).not.toBeNull();
    const [audit] = await db.query<{ entity: string; action: string; actor: string }>(
      `select entity, action, actor from audit_log where entity = 'owner_purchase'`);
    expect(audit).toEqual({ entity: 'owner_purchase', action: 'LOGGED', actor: 'owner' });
  });

  it('refuses a zero amount, a future date, and an empty or over-long description', async () => {
    await expect(logPurchase(db, { ...base, amountPaise: 0n }, NOW)).rejects.toThrow(/positive/);
    await expect(logPurchase(db, { ...base, amountPaise: -5n }, NOW)).rejects.toThrow(/positive/);
    await expect(logPurchase(db, { ...base, boughtOn: '2026-09-28' }, NOW)).rejects.toThrow(/future/);
    await expect(logPurchase(db, { ...base, description: '   ' }, NOW)).rejects.toThrow(/description/);
    await expect(logPurchase(db, { ...base, description: 'x'.repeat(201) }, NOW)).rejects.toThrow(/200/);
    expect(await db.query(`select 1 from owner_purchases`)).toHaveLength(0);
    expect(await db.query(`select 1 from audit_log where entity = 'owner_purchase'`)).toHaveLength(0);
  });

  it('a purchase bought today in India is not "in the future" while UTC is still on yesterday', async () => {
    // 01:30 IST on 28 September is 20:00 UTC on the 27th.
    await logPurchase(db, { ...base, boughtOn: '2026-09-28' }, '2026-09-27T20:00:00Z');
    expect(await db.query(`select 1 from owner_purchases`)).toHaveLength(1);
  });

  it('shows on the timeline as "Bought ₹X of <description>"', async () => {
    await logPurchase(db, base, NOW);
    const [e] = await loadOwnerTimeline(db);
    expect(e).toMatchObject({ on: '2026-09-26', summary: 'Bought ₹10,000 of Zerodha Gold ETF' });
  });
});
