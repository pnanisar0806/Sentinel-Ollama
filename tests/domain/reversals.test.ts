import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadOwnerTimeline, logGoalMove, logPurchase } from '../../src/domain/owner-log.js';
import { recordSipPayment } from '../../src/domain/owner-sips.js';
import { loadMonthSpend } from '../../src/domain/sips.js';
import { loadBucketBalances } from '../../src/domain/bucket-balances.js';
import { isReversed, reverseEntry } from '../../src/domain/reversals.js';
import { loadLiveSales } from '../../src/domain/owner-sales.js';
import { readFileSync } from 'node:fs';

/** Spec §3.4: a mistaken owner entry is corrected by a reversal row; the original stays. */
let db: Db;
const NOW = '2026-10-20T06:00:00Z';
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});
afterEach(async () => { await db.close(); });

const auditPayload = async (entity: string) => {
  const [a] = await db.query<{ id: string; payload: Record<string, unknown> }>(
    `select id::text, payload from audit_log where entity = $1 order by id desc limit 1`, [entity]);
  return a!;
};

/** A hand-built group, as Task 3 will write it: flows plus one owner audit row with `rowIds`. */
async function group(entity: 'earmark' | 'spend', flows: { bucket: string; amount: bigint; label?: string; note?: string; on?: string }[]): Promise<string> {
  const rowIds: string[] = [];
  for (const f of flows) {
    const [r] = await db.query<{ id: string }>(
      `insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, note, label, as_of, source)
       values ($1, $2, $3, $4, $5, $6, $7, 'owner-web') returning id::text`,
      [f.bucket, f.on ?? '2026-10-10', f.amount.toString(), entity, f.note ?? '', f.label ?? null, NOW]);
    rowIds.push(r!.id);
  }
  const [a] = await db.query<{ id: string }>(
    `insert into audit_log (entity, entity_id, action, actor, payload) values ($1, 'x', 'LOGGED', 'owner', $2::jsonb) returning id::text`,
    [entity, JSON.stringify({ on: '2026-10-10', rowIds, source: 'owner-web' })]);
  return a!.id;
}

describe('reverseEntry', () => {
  it('a reversed purchase leaves the month spend', async () => {
    await logPurchase(db, { boughtOn: '2026-10-15', description: 'typo', amountPaise: 1_000_000n }, NOW);
    const { payload } = await auditPayload('owner_purchase');
    expect((await loadMonthSpend(db, NOW)).ownerPaise).toBe(1_000_000n);
    await reverseEntry(db, { entity: 'owner_purchase', entityId: String(payload['rowId']), reason: 'wrong amount' }, NOW);
    expect((await loadMonthSpend(db, NOW)).ownerPaise).toBe(0n);
    expect(await isReversed(db, 'owner_purchase', String(payload['rowId']))).toBe(true);
    const [a] = await db.query<{ action: string; payload: Record<string, unknown> }>(
      `select action, payload from audit_log where entity = 'reversal'`);
    expect(a).toEqual({ action: 'REVERSED', payload: { entity: 'owner_purchase', entityId: payload['rowId'], reason: 'wrong amount', rowIds: [] } });
  });

  it('a reversed goal move leaves the bucket balance', async () => {
    await logGoalMove(db, { bucketId: 'B3', occurredOn: '2026-10-10', amountPaise: 500_000n, kind: 'sip', note: '' }, NOW);
    await logGoalMove(db, { bucketId: 'B3', occurredOn: '2026-10-11', amountPaise: 200_000n, kind: 'sip', note: '' }, NOW);
    const { payload } = await auditPayload('bucket_flow');
    await reverseEntry(db, { entity: 'bucket_flow', entityId: String(payload['rowId']), reason: 'double entry' }, NOW);
    expect((await loadBucketBalances(db)).get('B3')).toBe(500_000n);
  });

  it('Review Focus 1: a reversed SIP payment can be logged again, but two live ones for a fund-month cannot', async () => {
    await db.query(`insert into instruments (id, kind, name) values ('IND:hdfc','MF','HDFC Mid Cap')`);
    const pay = { instrumentId: 'IND:hdfc', paidOn: '2026-10-12', amountPaise: 300_100n, source: 'owner-chat' };
    await recordSipPayment(db, { ...pay, amountPaise: 30_010n }, NOW);
    const { payload } = await auditPayload('owner_sip_payment');
    await reverseEntry(db, { entity: 'owner_sip_payment', entityId: String(payload['rowId']), reason: 'missed a zero' }, NOW);
    await expect(recordSipPayment(db, pay, NOW)).resolves.toBeUndefined();
    await expect(recordSipPayment(db, pay, NOW)).rejects.toThrow(/already recorded/);
  });

  it('Review Focus 2: an earmark a later spend depends on cannot be reversed, and the refusal names the spend', async () => {
    const earmark = await group('earmark', [{ bucket: 'SP', amount: 25_000_000n, label: 'Himachal trip' }]);
    await group('spend', [{ bucket: 'SP', amount: -10_000_000n, label: 'Himachal trip', note: 'Himachal hotel', on: '2026-10-18' }]);
    await expect(reverseEntry(db, { entity: 'earmark', entityId: earmark, reason: 'wrong pot' }, NOW))
      .rejects.toThrow(/reverse the ₹1,00,000 .*Himachal hotel.* on 2026-10-18 first/);
    expect(await isReversed(db, 'earmark', earmark)).toBe(false);
    expect((await loadBucketBalances(db)).get('SP')).toBe(15_000_000n);
  });

  it('the refusal names the outflow to reverse first, never a later top-up into the same pot', async () => {
    const earmark = await group('earmark', [{ bucket: 'SP', amount: 25_000_000n, label: 'Himachal trip' }]);
    await group('spend', [{ bucket: 'SP', amount: -10_000_000n, label: 'Himachal trip', note: 'Himachal hotel', on: '2026-10-18' }]);
    await group('earmark', [{ bucket: 'SP', amount: 5_000_000n, label: 'Himachal trip', note: 'top-up', on: '2026-10-20' }]);
    await expect(reverseEntry(db, { entity: 'earmark', entityId: earmark, reason: 'wrong pot' }, NOW))
      .rejects.toThrow(/reverse the ₹1,00,000 Himachal hotel on 2026-10-18 first/);
  });

  it('reverses a group together: the key plus every flow, in one go', async () => {
    const earmark = await group('earmark', [{ bucket: 'B3', amount: -100_000n }, { bucket: 'B4', amount: 100_000n }]);
    await group('earmark', [{ bucket: 'B3', amount: 300_000n }]); // so B3 stays non-negative either way
    await reverseEntry(db, { entity: 'earmark', entityId: earmark, reason: 'meant B2' }, NOW);
    const b = await loadBucketBalances(db);
    expect([b.get('B3'), b.get('B4')]).toEqual([300_000n, undefined]); // a bucket with only reversed rows is absent, not 0
    expect(await db.query(`select entity from log_reversals order by id`)).toEqual(
      [{ entity: 'earmark' }, { entity: 'bucket_flow' }, { entity: 'bucket_flow' }]);
    const t = await loadOwnerTimeline(db);
    expect(t.find((e) => e.key === earmark)).toMatchObject({
      reversible: { entity: 'earmark', entityId: earmark }, reversed: { on: '2026-10-20', reason: 'meant B2' } });
  });

  it('refuses a flow that belongs to a group: the group reverses as one', async () => {
    await group('earmark', [{ bucket: 'B4', amount: 100_000n }]);
    const [f] = await db.query<{ id: string }>(`select id::text from bucket_flows`);
    await expect(reverseEntry(db, { entity: 'bucket_flow', entityId: f!.id, reason: 'x' }, NOW)).rejects.toThrow(/not a reversible/);
  });

  it('reversing twice is refused', async () => {
    await logPurchase(db, { boughtOn: '2026-10-15', description: 'typo', amountPaise: 100n }, NOW);
    const id = String((await auditPayload('owner_purchase')).payload['rowId']);
    await reverseEntry(db, { entity: 'owner_purchase', entityId: id, reason: 'typo' }, NOW);
    await expect(reverseEntry(db, { entity: 'owner_purchase', entityId: id, reason: 'typo' }, NOW)).rejects.toThrow(/already reversed/);
  });

  it('refuses a missing, empty or over-long reason', async () => {
    await logPurchase(db, { boughtOn: '2026-10-15', description: 'typo', amountPaise: 100n }, NOW);
    const id = String((await auditPayload('owner_purchase')).payload['rowId']);
    await expect(reverseEntry(db, { entity: 'owner_purchase', entityId: id, reason: '   ' }, NOW)).rejects.toThrow(/reason/);
    await expect(reverseEntry(db, { entity: 'owner_purchase', entityId: id, reason: 'x'.repeat(501) }, NOW)).rejects.toThrow(/500/);
    expect(await isReversed(db, 'owner_purchase', id)).toBe(false);
  });

  it('reversing a sync or seed row is refused', async () => {
    const [seedFlow] = await db.query<{ id: string }>(
      `insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, as_of, source)
       values ('B3', '2026-08-12', 100, 'seed', now(), 'manual-seed') returning id::text`);
    await db.query(`insert into audit_log (entity, entity_id, action, actor, payload) values ('bucket_flow', 'B3', 'LOGGED', 'owner', $1::jsonb)`,
      [JSON.stringify({ rowId: seedFlow!.id })]);
    await expect(reverseEntry(db, { entity: 'bucket_flow', entityId: seedFlow!.id, reason: 'x' }, NOW)).rejects.toThrow(/owner-entered/);

    await db.query(`insert into instruments (id, kind, name) values ('IND:x','MF','X')`);
    const [sync] = await db.query<{ id: string }>(
      `insert into owner_sip_payments (instrument_id, paid_on, month, amount_paise, as_of, source)
       values ('IND:x', '2026-10-05', '2026-10', 100, now(), 'indmoney-sync') returning id::text`);
    await db.query(`insert into audit_log (entity, entity_id, action, actor, payload) values ('owner_sip_payment', $1, 'RECORDED', 'owner', $2::jsonb)`,
      [sync!.id, JSON.stringify({ rowId: sync!.id, source: 'indmoney-sync' })]);
    await expect(reverseEntry(db, { entity: 'owner_sip_payment', entityId: sync!.id, reason: 'x' }, NOW)).rejects.toThrow(/owner-entered/);
    expect(await db.query(`select 1 from log_reversals`)).toHaveLength(0);
  });

  it('entries written before this change carry no rowId and are not reversible', async () => {
    const [old] = await db.query<{ id: string }>(
      `insert into owner_purchases (bought_on, description, amount_paise, as_of, source)
       values ('2026-10-01', 'Zerodha gold', 100, now(), 'owner-web') returning id::text`);
    await db.query(`insert into audit_log (entity, entity_id, action, actor, payload) values ('owner_purchase', $1, 'LOGGED', 'owner', $2::jsonb)`,
      [old!.id, JSON.stringify({ on: '2026-10-01', amountPaise: '100', description: 'Zerodha gold' })]);
    await expect(reverseEntry(db, { entity: 'owner_purchase', entityId: old!.id, reason: 'x' }, NOW)).rejects.toThrow(/not a reversible/);
    const [e] = await loadOwnerTimeline(db);
    expect(e).toMatchObject({ summary: 'Bought ₹1 of Zerodha gold', reversible: null, reversed: null });
  });

  it('new entries show as reversible on the timeline, then as reversed', async () => {
    await logGoalMove(db, { bucketId: 'B3', occurredOn: '2026-10-10', amountPaise: 500_000n, kind: 'sip', note: '' }, NOW);
    const id = String((await auditPayload('bucket_flow')).payload['rowId']);
    expect((await loadOwnerTimeline(db))[0]).toMatchObject({ reversible: { entity: 'bucket_flow', entityId: id }, reversed: null });
    await reverseEntry(db, { entity: 'bucket_flow', entityId: id, reason: 'wrong goal' }, '2026-10-20T20:00:00Z');
    // 20:00Z on the 20th is the 21st in India.
    expect((await loadOwnerTimeline(db))[0]).toMatchObject({ reversed: { on: '2026-10-21', reason: 'wrong goal' } });
  });
});

describe('legacy string payloads (production double-encoding, browser QA 2026-10-23)', () => {
  // postgres-js stored JSON.stringify(...)::jsonb as a jsonb STRING on Supabase; PGlite parses it
  // into an object, so tests never saw it. These rows are append-only and stay that way forever.
  const legacyAudit = async (entity: string, payload: object) => (await db.query<{ id: string }>(
    `insert into audit_log (entity, entity_id, action, actor, payload) values ($1, 'x', 'LOGGED', 'owner', to_jsonb($2::text)) returning id::text`,
    [entity, JSON.stringify(payload)]))[0]!.id;

  it('the fixture really is a jsonb string', async () => {
    const id = await legacyAudit('owner_purchase', { rowId: '1' });
    const [r] = await db.query<{ t: string }>(`select jsonb_typeof(payload) t from audit_log where id = $1`, [id]);
    expect(r!.t).toBe('string');
  });

  it('a purchase whose audit payload is a string can be reversed', async () => {
    const [p] = await db.query<{ id: string }>(
      `insert into owner_purchases (bought_on, description, amount_paise, as_of, source) values ('2026-10-15', 'x', 1000000, $1, 'owner-web') returning id::text`, [NOW]);
    await legacyAudit('owner_purchase', { rowId: p!.id, source: 'owner-web' });
    await reverseEntry(db, { entity: 'owner_purchase', entityId: p!.id, reason: 'test' }, NOW);
    expect((await loadMonthSpend(db, NOW)).ownerPaise).toBe(0n);
  });

  it('a sale whose audit payload is a string can be reversed, and then stops reducing the seed', async () => {
    const [s] = await db.query<{ id: string }>(
      `insert into owner_sales (sold_on, instrument_id, units, proceeds_paise, as_of, source) values ('2026-10-15', 'US:NOW', 10, 100000, $1, 'owner-web') returning id::text`, [NOW]);
    const auditId = await legacyAudit('owner_sale', { rowId: s!.id, rowIds: [], source: 'owner-web' });
    expect(await loadLiveSales(db)).toHaveLength(1);
    await reverseEntry(db, { entity: 'owner_sale', entityId: auditId, reason: 'test' }, NOW);
    expect(await loadLiveSales(db)).toHaveLength(0);
  });

  it('owner log writers store objects, never strings: no JSON.stringify bound to ::jsonb', () => {
    const files = ['src/domain/owner-log.ts', 'src/domain/reversals.ts', 'src/domain/owner-sips.ts'];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      const hits = [...src.matchAll(/::jsonb[^;]*?JSON\.stringify\(/gs)];
      expect(hits.map((h) => `${f}: ${h[0].slice(0, 60)}`)).toEqual([]);
    }
  });
});

describe('migration 0036 checks', () => {
  it('log_reversals refuses an unknown entity or an empty source; an SP flow needs a label', async () => {
    await expect(db.query(`insert into log_reversals (entity, entity_id, reason, as_of, source) values ('order', '1', 'x', now(), 'owner-web')`)).rejects.toThrow(/check/);
    await expect(db.query(`insert into log_reversals (entity, entity_id, reason, as_of, source) values ('spend', '1', 'x', now(), '')`)).rejects.toThrow(/check/);
    await expect(db.query(`insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, as_of, source)
      values ('SP', '2026-10-10', 100, 'earmark', now(), 'owner-web')`)).rejects.toThrow(/check/);
    // Labels live on SP only, so a labelled outflow is always an SP one.
    await expect(db.query(`insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, label, as_of, source)
      values ('B3', '2026-10-10', 100, 'earmark', 'Himachal trip', now(), 'owner-web')`)).rejects.toThrow(/bucket_flows_label_sp_only_check/);
  });
});
