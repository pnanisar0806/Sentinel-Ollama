import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import {
  completeMilestone, loadOwnerTimeline, logEarmark, logGoalMove, logNote, logPurchase, logSale, logSpend,
} from '../../src/domain/owner-log.js';
import { loadBucketBalances, loadSpLabels } from '../../src/domain/bucket-balances.js';
import { loadGoalTracker } from '../../src/domain/goal-plan.js';
import { loadFreeEnvelope } from '../../src/domain/sips.js';
import { loadPositions } from '../../src/domain/networth.js';
import { reverseEntry } from '../../src/domain/reversals.js';
import { SEED_HOLDINGS, SEED_INSTRUMENTS } from '../../src/seed/seed-data.js';

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

describe('an earmark into a cash pot with no bank balance', () => {
  it('is refused: idle bank cash is unknown, never ₹0', async () => {
    const e = { on: '2026-09-26', from: 'FI' as const, to: 'SP' as const, amountPaise: 1n, label: 'Himachal trip', note: '', fiCorpusPaise: 10n ** 12n };
    await expect(logEarmark(db, e, NOW)).rejects.toThrow('bank balance is unknown');
    await expect(logEarmark(db, { ...e, to: 'B3' }, NOW)).rejects.toThrow('bank balance is unknown');
    await logEarmark(db, { ...e, to: 'B4' }, NOW);                       // not a cash pot: corpus only
    expect(await db.query(`select 1 from bucket_flows`)).toHaveLength(1);
  });
});

describe('earmarks and spends (spec §3.2, §3.3, §7.3, §7.6)', () => {
  type E = Parameters<typeof logEarmark>[1];
  type S = Parameters<typeof logSpend>[1];
  const fiCorpus = async () => {
    const p = (await loadGoalTracker(db, NOW)).fiPots!;
    return p.equity + p.debt + p.gold + p.cash;
  };
  const fund = (bucketId: string, amountPaise: bigint) =>
    logGoalMove(db, { bucketId, occurredOn: '2026-09-20', amountPaise, kind: 'sip', note: '' }, NOW);
  const earmark = (e: Partial<E>) =>
    logEarmark(db, { on: '2026-09-26', from: 'FI', to: 'SP', amountPaise: 25_000_000n, note: '', ...e }, NOW);
  const spend = (s: Partial<S>) =>
    logSpend(db, { on: '2026-09-26', amountPaise: 1_000_000n, purpose: 'Himachal trip', from: 'SP', label: 'Himachal trip', note: '', ...s }, NOW);
  const flows = () => db.query<{ bucket_id: string; amount_paise: string; kind: string; label: string | null }>(
    `select bucket_id, amount_paise::text, kind, label from bucket_flows where kind in ('earmark', 'spend') order by as_of, amount_paise`);
  // The seed carries no bank row; give it ₹50L of bank cash (idle cash, before any B3/SP).
  beforeEach(async () => {
    await db.query(`insert into instruments (id, kind, name, currency) values ('CASH:T','CASH','Bank','INR')`);
    await db.query(`insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
      select id, 'CASH:T', 1, 500000000, 'x', now(), 'manual-seed' from snapshots where source = 'manual-seed'`);
  });

  it('an earmark into SP or B3 from FI must fit in idle bank cash, even when the corpus covers it', async () => {
    const fi = await fiCorpus();
    expect(fi).toBeGreaterThan(600_000_000n);
    await expect(earmark({ label: 'Himachal trip', amountPaise: 600_000_000n, fiCorpusPaise: fi }))
      .rejects.toThrow(/Idle bank cash holds ₹50,00,000/);
    await expect(earmark({ to: 'B3', amountPaise: 600_000_000n, fiCorpusPaise: fi })).rejects.toThrow(/Idle bank cash holds ₹50,00,000/);
    await earmark({ to: 'B3', amountPaise: 100_000_000n, fiCorpusPaise: fi });        // B3 now holds ₹10L of the bank
    await expect(earmark({ label: 'Himachal trip', amountPaise: 400_000_001n, fiCorpusPaise: fi }))
      .rejects.toThrow(/Idle bank cash holds ₹40,00,000/);
    await earmark({ label: 'Himachal trip', amountPaise: 400_000_000n, fiCorpusPaise: fi });
    expect(await loadSpLabels(db)).toEqual([{ label: 'Himachal trip', balancePaise: 400_000_000n }]);
  });

  it('B2→SP needs both the House fund balance and idle bank cash; FI→B2 needs only the corpus', async () => {
    await fund('B2', 10_000_000n);
    await expect(earmark({ from: 'B2', label: 'Laptop', amountPaise: 20_000_000n })).rejects.toThrow(/House fund holds ₹1,00,000/);
    await earmark({ to: 'B2', amountPaise: 700_000_000n, fiCorpusPaise: await fiCorpus() });   // above idle cash: fine for B2
    await expect(earmark({ from: 'B2', label: 'Laptop', amountPaise: 600_000_000n })).rejects.toThrow(/Idle bank cash holds ₹50,00,000/);
    await earmark({ from: 'B2', label: 'Laptop', amountPaise: 8_000_000n });
    expect(await flows()).toContainEqual({ bucket_id: 'B2', amount_paise: '-8000000', kind: 'earmark', label: null });
    expect(await flows()).toContainEqual({ bucket_id: 'SP', amount_paise: '8000000', kind: 'earmark', label: 'Laptop' });
  });

  it('SP→B3 is cash to cash: only the label balance must cover it', async () => {
    await earmark({ label: 'Himachal trip', amountPaise: 500_000_000n, fiCorpusPaise: await fiCorpus() });   // idle cash now ₹0
    await earmark({ from: 'SP', to: 'B3', label: 'Himachal trip', amountPaise: 200_000_000n });
    expect((await loadBucketBalances(db)).get('B3')).toBe(200_000_000n);
    await expect(earmark({ from: 'SP', to: 'B3', label: 'Himachal trip', amountPaise: 300_000_001n }))
      .rejects.toThrow(/Planned spending: Himachal trip holds ₹30,00,000/);
  });

  it('FI→SP opens the label, writes one row, and the FI corpus drops by X', async () => {
    const before = await fiCorpus();
    await earmark({ label: 'Himachal trip', expectedOn: '2026-12-20', fiCorpusPaise: before });
    expect(await flows()).toEqual([{ bucket_id: 'SP', amount_paise: '25000000', kind: 'earmark', label: 'Himachal trip' }]);
    expect(await loadSpLabels(db)).toEqual([{ label: 'Himachal trip', balancePaise: 25_000_000n }]);
    expect(await fiCorpus()).toBe(before - 25_000_000n);
    const [a] = await db.query<{ payload: Record<string, unknown> }>(`select payload from audit_log where entity = 'earmark'`);
    expect(a!.payload).toMatchObject({
      source: 'owner-web', from: 'FI', to: 'SP', amountPaise: '25000000', label: 'Himachal trip', expectedOn: '2026-12-20',
    });
    expect(a!.payload['rowIds']).toHaveLength(1);
  });

  it('an FI source needs a known corpus that covers the amount', async () => {
    await expect(earmark({ label: 'Himachal trip' })).rejects.toThrow('FI corpus is unknown');
    await expect(earmark({ label: 'Himachal trip', fiCorpusPaise: null })).rejects.toThrow('FI corpus is unknown');
    await expect(earmark({ label: 'Himachal trip', fiCorpusPaise: 10_000_000n })).rejects.toThrow(/FI holds ₹1,00,000/);
    expect(await flows()).toHaveLength(0);
  });

  it('B2→B3 writes −X and +X under one audit row', async () => {
    await fund('B2', 5_000_000n);
    await earmark({ from: 'B2', to: 'B3', amountPaise: 2_000_000n });
    expect(await flows()).toEqual([
      { bucket_id: 'B2', amount_paise: '-2000000', kind: 'earmark', label: null },
      { bucket_id: 'B3', amount_paise: '2000000', kind: 'earmark', label: null },
    ]);
    const b = await loadBucketBalances(db);
    expect([b.get('B2'), b.get('B3')]).toEqual([3_000_000n, 2_000_000n]);
    const [a] = await db.query<{ payload: { rowIds: string[] } }>(`select payload from audit_log where entity = 'earmark'`);
    expect(a!.payload.rowIds).toHaveLength(2);
  });

  it('an over-balance earmark or spend is refused, naming the balance', async () => {
    await fund('B3', 500_000n);
    await expect(earmark({ from: 'B3', to: 'B4', amountPaise: 600_000n })).rejects.toThrow(/Emergency fund holds ₹5,000/);
    await expect(spend({ from: 'B3', amountPaise: 600_000n, label: undefined })).rejects.toThrow(/Emergency fund holds ₹5,000/);
    await expect(earmark({ from: 'B2', to: 'B3', amountPaise: 1n })).rejects.toThrow(/House fund holds ₹0/);
    await earmark({ label: 'Himachal trip', amountPaise: 1_000_000n, fiCorpusPaise: await fiCorpus() });
    await expect(spend({ amountPaise: 1_000_001n })).rejects.toThrow(/Planned spending: Himachal trip holds ₹10,000/);
    expect((await flows()).filter((f) => f.kind === 'spend')).toHaveLength(0);
  });

  it('with two labels, a spend reduces only the chosen one', async () => {
    const fi = await fiCorpus();
    await earmark({ label: 'Himachal trip', amountPaise: 25_000_000n, fiCorpusPaise: fi });
    await earmark({ label: 'Laptop', amountPaise: 8_000_000n, fiCorpusPaise: fi });
    await spend({ amountPaise: 10_000_000n, purpose: 'Hotels', label: 'Himachal trip' });
    expect(await loadSpLabels(db)).toEqual([
      { label: 'Himachal trip', balancePaise: 15_000_000n },
      { label: 'Laptop', balancePaise: 8_000_000n },
    ]);
  });

  it('a label closes at ₹0 and can no longer be spent from', async () => {
    await earmark({ label: 'Laptop', amountPaise: 8_000_000n, fiCorpusPaise: await fiCorpus() });
    await spend({ amountPaise: 8_000_000n, purpose: 'Laptop', label: 'Laptop' });
    expect(await loadSpLabels(db)).toEqual([]);
    await expect(spend({ label: 'Laptop' })).rejects.toThrow(/no open Planned spending pot "Laptop"/);
  });

  it('SP→FI releases leftover money: one −X row, and FI is whole again', async () => {
    const fi = await fiCorpus();
    await earmark({ label: 'Himachal trip', amountPaise: 25_000_000n, fiCorpusPaise: fi });
    await earmark({ from: 'SP', to: 'FI', amountPaise: 25_000_000n, label: 'Himachal trip' });
    // Both rows share as_of = NOW, so `flows()` orders them by amount.
    expect((await flows()).map((f) => f.amount_paise)).toEqual(['-25000000', '25000000']);
    expect(await loadSpLabels(db)).toEqual([]);
    expect(await fiCorpus()).toBe(fi);
  });

  it('a BANK spend writes no flow, only the audit row', async () => {
    await spend({ from: 'BANK', label: undefined, purpose: 'Dentist' });
    expect(await db.query(`select 1 from bucket_flows`)).toHaveLength(0);
    const [a] = await db.query<{ payload: Record<string, unknown> }>(`select payload from audit_log where entity = 'spend'`);
    expect(a!.payload).toMatchObject({ source: 'owner-web', rowIds: [], from: 'BANK', purpose: 'Dentist' });
  });

  it('refuses a same-bucket move, a missing or long label, and an empty or long purpose', async () => {
    await fund('B2', 5_000_000n);
    await expect(earmark({ from: 'B2', to: 'B2', amountPaise: 1n })).rejects.toThrow(/different/);
    await expect(earmark({ from: 'B2', amountPaise: 1n })).rejects.toThrow(/label/);
    await expect(earmark({ from: 'B2', amountPaise: 1n, label: 'x'.repeat(81) })).rejects.toThrow(/80/);
    await expect(earmark({ from: 'SP', to: 'FI', amountPaise: 1n })).rejects.toThrow(/label/);
    await expect(earmark({ from: 'B2', to: 'B3', amountPaise: 0n })).rejects.toThrow(/positive/);
    await expect(earmark({ label: 'Trip', expectedOn: '2026-02-30', fiCorpusPaise: 1n })).rejects.toThrow(/not a date: 2026-02-30/);
    await expect(earmark({ label: 'Trip', expectedOn: '2026-13-45', fiCorpusPaise: 1n })).rejects.toThrow(/not a date/);
    await expect(spend({ from: 'BANK', purpose: '  ' })).rejects.toThrow(/purpose/);
    await expect(spend({ from: 'BANK', purpose: 'x'.repeat(121) })).rejects.toThrow(/120/);
    await expect(spend({ from: 'SP', label: undefined })).rejects.toThrow(/label/);
    expect(await flows()).toHaveLength(0);
  });

  it('leaves the free envelope unchanged', async () => {
    const before = await loadFreeEnvelope(db, NOW);
    await earmark({ label: 'Himachal trip', fiCorpusPaise: await fiCorpus() });
    await spend({ amountPaise: 1_000_000n });
    await spend({ from: 'BANK', label: undefined });
    expect(await loadFreeEnvelope(db, NOW)).toEqual(before);
  });

  it('shows on the timeline, reversible by the audit id', async () => {
    await earmark({ label: 'Himachal trip', amountPaise: 25_000_000n, fiCorpusPaise: await fiCorpus() });
    await spend({ amountPaise: 12_000_000n });
    const t = await loadOwnerTimeline(db);
    expect(t.map((e) => e.summary)).toEqual([
      'Spent ₹1,20,000 on Himachal trip (from Planned spending)',
      'Earmarked ₹2,50,000 from FI to Planned spending: Himachal trip',
    ]);
    const [a] = await db.query<{ id: string }>(`select id::text from audit_log where entity = 'earmark'`);
    expect(t[1]!.reversible).toEqual({ entity: 'earmark', entityId: a!.id });
  });
});

describe('a sale (spec §3.1, §7.7)', () => {
  type L = Parameters<typeof logSale>[1];
  const ON = '2026-09-26';
  const sale = (s: Partial<L>) =>
    logSale(db, { on: ON, instrumentId: 'US:NOW', units: 10, proceedsPaise: 1_200_000_00n, destination: 'B2', note: '', ...s }, NOW);
  const nowValue = async () => (await loadPositions(db)).find((p) => p.instrumentId === 'US:NOW')?.valuePaise;
  const seedNow = SEED_HOLDINGS.find((h) => h.instrumentId === 'US:NOW')!;
  const saleAudit = async () => (await db.query<{ id: string; payload: Record<string, unknown> }>(
    `select id::text, payload from audit_log where entity = 'owner_sale' order by id desc limit 1`))[0]!;

  it('10 of 78 US:NOW into B2: one sale row, a +proceeds B2 flow, and the value scales to 68/78', async () => {
    await sale({});
    expect(await nowValue()).toBe((seedNow.valuePaise * 68n) / 78n);
    expect((await loadBucketBalances(db)).get('B2')).toBe(1_200_000_00n);
    const [f] = await db.query<{ kind: string; label: string | null }>(`select kind, label from bucket_flows`);
    expect(f).toEqual({ kind: 'sale', label: null });
    const [row] = await db.query<{ id: string; units: string; source: string; destination: string }>(
      `select id::text, units::text, source, destination from owner_sales`);
    expect(row).toMatchObject({ units: '10.000000', source: 'owner-web', destination: 'B2' });
    const a = await saleAudit();
    expect(a.payload).toMatchObject({ source: 'owner-web', rowId: row!.id, instrumentId: 'US:NOW', units: '10', proceedsPaise: '120000000' });
    expect(a.payload['rowIds']).toHaveLength(1);
  });

  it('reversing a sale with a destination restores 78 shares and removes the flow (Task 2 deferred: group path)', async () => {
    await sale({});
    await reverseEntry(db, { entity: 'owner_sale', entityId: (await saleAudit()).id, reason: 'wrong date' }, NOW);
    expect(await nowValue()).toBe(seedNow.valuePaise);
    expect((await loadBucketBalances(db)).get('B2') ?? 0n).toBe(0n);
  });

  it('reversing a sale with no destination (rowIds: []) restores the shares and writes no flow reversal', async () => {
    await sale({ destination: null });
    expect(await db.query(`select 1 from bucket_flows`)).toHaveLength(0);
    const a = await saleAudit();
    expect(a.payload['rowIds']).toEqual([]);
    await reverseEntry(db, { entity: 'owner_sale', entityId: a.id, reason: 'never sold' }, NOW);
    expect(await nowValue()).toBe(seedNow.valuePaise);
    expect(await db.query<{ entity: string }>(`select entity from log_reversals`)).toEqual([{ entity: 'owner_sale' }]);
  });

  it('Review Focus 3: selling more than the manual-seed holding, net of earlier sales, is refused', async () => {
    await expect(sale({ units: 79 })).rejects.toThrow(/holds 78 /);
    await sale({ units: 70 });
    await expect(sale({ units: 9 })).rejects.toThrow(/holds 8 /);
    await expect(sale({ units: 9 })).rejects.toThrow(/holds 8 units; cannot sell 9$/);
    await sale({ units: 7 });
    await expect(sale({ units: 2 })).rejects.toThrow(/holds 1 unit; cannot sell 2$/);
  });

  it('Review Focus 3: a sold-out seed holding still refuses a further sale; reversing the sale restores 78', async () => {
    await sale({ units: 78 });
    expect(await nowValue()).toBeUndefined();                      // all sold: no longer held
    await expect(sale({ units: 1 })).rejects.toThrow(/holds 0 units/);
    await reverseEntry(db, { entity: 'owner_sale', entityId: (await saleAudit()).id, reason: 'typo' }, NOW);
    expect(await nowValue()).toBe(seedNow.valuePaise);
  });

  it('a sale dated before the seed row does not reduce it: the seed already reflects it', async () => {
    await sale({ on: '2026-08-11' });
    expect(await nowValue()).toBe(seedNow.valuePaise);
  });

  it('a synced holding is not adjusted and not oversell-checked: the feed is the truth', async () => {
    const [snap] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source, taken_at) values ('2026-09-01', 'composite', '2026-09-01T00:00:00Z') returning id`);
    await db.query(`insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
      values ($1, 'NSE:RPOWER', 5, 2222200, 'zerodha', '2026-09-01T00:00:00Z', 'composite')`, [snap!.id]);
    await sale({ instrumentId: 'NSE:RPOWER', units: 1000, destination: null });
    expect((await loadPositions(db)).find((p) => p.instrumentId === 'NSE:RPOWER')?.valuePaise).toBe(2_222_200n);
  });

  it('refuses a bond, missing units on an RSU or stock, bad units, a future date and an SP sale without a label', async () => {
    await expect(sale({ instrumentId: 'BOND:SAMMAAN-2029', units: 1 })).rejects.toThrow('use the bond redemption form');
    await expect(sale({ units: null })).rejects.toThrow(/units/);
    await expect(sale({ instrumentId: 'NSE:RPOWER', units: null })).rejects.toThrow(/units/);
    await expect(sale({ instrumentId: 'NSE:NIFTYBEES', units: null })).rejects.toThrow(/units sold are required/);
    await expect(sale({ units: 0 })).rejects.toThrow(/units/);
    await expect(sale({ units: 0.0000001 })).rejects.toThrow(/6 decimal/);
    await expect(sale({ proceedsPaise: 0n })).rejects.toThrow(/positive/);
    await expect(sale({ on: '2026-09-28' })).rejects.toThrow(/future/);
    await expect(sale({ destination: 'SP' })).rejects.toThrow(/label/);
    await expect(sale({ instrumentId: 'NSE:NOPE' })).rejects.toThrow(/no holding NSE:NOPE/);
    expect(await db.query(`select 1 from owner_sales`)).toHaveLength(0);
  });

  it('an MF sale may omit units; proceeds into SP need no idle bank cash (the money is new cash)', async () => {
    // The seed has no bank row, so an earmark into SP would be refused: bank balance unknown.
    await sale({ instrumentId: 'MF:PPFC', units: null, destination: 'SP', label: 'Himachal trip' });
    expect(await loadSpLabels(db)).toEqual([{ label: 'Himachal trip', balancePaise: 1_200_000_00n }]);
  });

  it('leaves the free envelope unchanged', async () => {
    const before = await loadFreeEnvelope(db, NOW);
    await sale({});
    await sale({ destination: null, units: 1 });
    expect(await loadFreeEnvelope(db, NOW)).toEqual(before);
  });

  it('shows on the timeline as "Sold <units> <name> for ₹X → <destination>", reversible by the audit id', async () => {
    await sale({});
    await sale({ instrumentId: 'MF:PPFC', units: null, destination: null, proceedsPaise: 5_000_00n });
    await sale({ instrumentId: 'MF:PPFC', units: 0.5, destination: 'SP', label: 'Laptop', proceedsPaise: 1_000_00n });
    const t = await loadOwnerTimeline(db);
    const ppfc = SEED_INSTRUMENTS.find((i) => i.id === 'MF:PPFC')!.name;
    expect(t.map((e) => e.summary)).toEqual([
      `Sold 0.5 ${ppfc} for ₹1,000 → Planned spending: Laptop`,
      `Sold ${ppfc} for ₹5,000 → bank`,
      `Sold 10 ${SEED_INSTRUMENTS.find((i) => i.id === 'US:NOW')!.name} for ₹12,00,000 → House fund`,
    ]);
    const [a] = await db.query<{ id: string }>(`select id::text from audit_log where entity = 'owner_sale' order by id limit 1`);
    expect(t[2]!.reversible).toEqual({ entity: 'owner_sale', entityId: a!.id });
  });
});
