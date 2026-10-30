import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadLumpSum, loadOpenLumpSums, openLumpSumPaise } from '../../src/domain/lump-sums.js';
import { loadOwnerTimeline, logLumpSum, logPurchase } from '../../src/domain/owner-log.js';
import { loadMonthSpend } from '../../src/domain/sips.js';
import { reverseEntry } from '../../src/domain/reversals.js';

/** Batch B §3: money received (a lump sum) is logged, purchases link to it, and it stays out of the month. */
let db: Db;
const NOW = '2026-10-30T06:00:00Z';

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});
afterEach(async () => { await db.close(); });

const lump = (over: Partial<Parameters<typeof logLumpSum>[1]> = {}) => logLumpSum(db, {
  receivedOn: '2026-10-28', amountPaise: 2_069_100n, from: 'Edelweiss bond interest', ...over,
}, NOW);
const buy = (amountPaise: bigint, lumpSumId?: string) => logPurchase(db, {
  boughtOn: '2026-10-29', description: 'Parag Parikh Flexi Cap', amountPaise, ...(lumpSumId ? { lumpSumId } : {}),
}, NOW);

describe('lump sums', () => {
  it('logs ₹20,691 of Edelweiss bond interest', async () => {
    const { id } = await lump({ note: 'Q3 coupon' });
    expect(await loadOpenLumpSums(db)).toEqual([{
      id, receivedOn: '2026-10-28', amountPaise: 2_069_100n, from: 'Edelweiss bond interest', note: 'Q3 coupon',
      spentPaise: 0n, remainingPaise: 2_069_100n,
    }]);
    const [row] = await db.query<{ source: string; as_of: string | Date }>(`select source, as_of from lump_sums`);
    expect(row!.source).toBe('owner-web');
    expect(new Date(row!.as_of).toISOString()).toBe('2026-10-30T06:00:00.000Z');
    const [a] = await db.query<{ actor: string }>(`select actor from audit_log where entity = 'lump_sum'`);
    expect(a!.actor).toBe('owner');
    const [t] = (await loadOwnerTimeline(db)).filter((e) => e.kind === 'Lump sum');
    expect(t!.summary).toBe('Money received: ₹20,691 from Edelweiss bond interest');
    expect(t!.on).toBe('2026-10-28');
    expect(t!.reversible).toEqual({ entity: 'lump_sum', entityId: id });
    expect(await openLumpSumPaise(db)).toBe(2_069_100n);
    expect(await openLumpSumPaise(db, id)).toBe(0n);
  });

  it('a linked purchase reduces what is left and does not count against the month', async () => {
    const { id } = await lump();
    const before = (await loadMonthSpend(db, NOW)).ownerPaise;
    await buy(1_200_000n, id);
    expect((await loadLumpSum(db, id))!.remainingPaise).toBe(869_100n);
    expect((await loadLumpSum(db, id))!.spentPaise).toBe(1_200_000n);
    expect((await loadMonthSpend(db, NOW)).ownerPaise).toBe(before);
    // An unlinked purchase still counts (the exclusion is not blanket).
    await buy(100_000n);
    expect((await loadMonthSpend(db, NOW)).ownerPaise).toBe(before + 100_000n);
    // A reversed linked purchase gives the lump sum back.
    const [p] = await db.query<{ id: string }>(`select id::text from owner_purchases where lump_sum_id is not null`);
    await reverseEntry(db, { entity: 'owner_purchase', entityId: p!.id, reason: 'typo' }, NOW);
    expect((await loadLumpSum(db, id))!.remainingPaise).toBe(2_069_100n);
  });

  it('refuses a purchase above what is left', async () => {
    const { id } = await lump();
    await expect(buy(2_100_000n, id)).rejects.toThrow('more than the ₹20,691 left of this lump sum');
    await buy(2_069_100n, id); // exactly what is left is fine
    expect(await loadOpenLumpSums(db)).toEqual([]); // spent in full: no longer open
    await expect(buy(100n, id)).rejects.toThrow('more than the ₹0 left of this lump sum');
  });

  it('reversal returns linked purchases to the month', async () => {
    const { id } = await lump();
    const before = (await loadMonthSpend(db, NOW)).ownerPaise;
    await buy(1_200_000n, id);
    await reverseEntry(db, { entity: 'lump_sum', entityId: id, reason: 'logged twice' }, NOW);
    expect(await loadOpenLumpSums(db)).toEqual([]);
    expect(await loadLumpSum(db, id)).toBeNull();
    expect(await openLumpSumPaise(db)).toBe(0n);
    expect((await loadMonthSpend(db, NOW)).ownerPaise).toBe(before + 1_200_000n);
    await expect(buy(100n, id)).rejects.toThrow(`no open lump sum ${id}`);
    const [t] = (await loadOwnerTimeline(db)).filter((e) => e.kind === 'Lump sum');
    expect(t!.reversed?.reason).toBe('logged twice');
  });

  it('an order from a lump-sum recommendation counts against the lump, not the month', async () => {
    const { id } = await lump();
    const before = (await loadMonthSpend(db, NOW)).ordersPaise;
    const recommend = async (lumpSumId: string | null) => (await db.query<{ id: string }>(
      `insert into recommendations (created_on, kind, intent, primary_rec, alternates, ips_clause_refs, engine_evidence, lump_sum_id)
       values ('2026-10-30', 'satellite', 'BUY', 'x', '', '', '', $1) returning id::text`, [lumpSumId]))[0]!.id;
    const order = (recId: string, paise: bigint) => db.query(
      `insert into order_intents (recommendation_id, intent, instrument_id, quantity, order_type, payload_snapshot, as_of, source, created_by, status)
       values ($1, 'BUY', 'NSE:GOLDBEES', $2, 'MARKET', '{}'::jsonb, $3, 'advisor', 'advisor', 'PENDING_APPROVAL')`,
      [recId, paise.toString(), NOW]);
    await order(await recommend(id), 1_000_000n);
    expect((await loadLumpSum(db, id))!.remainingPaise).toBe(1_069_100n);
    expect((await loadMonthSpend(db, NOW)).ordersPaise).toBe(before);
    await order(await recommend(null), 50_000n);
    expect((await loadMonthSpend(db, NOW)).ordersPaise).toBe(before + 50_000n);
    // A reversed lump sum's orders count against the month again.
    await reverseEntry(db, { entity: 'lump_sum', entityId: id, reason: 'wrong' }, NOW);
    expect((await loadMonthSpend(db, NOW)).ordersPaise).toBe(before + 1_050_000n);
  });

  it('refuses', async () => {
    await expect(lump({ amountPaise: 0n })).rejects.toThrow('the amount must be positive');
    await expect(lump({ amountPaise: -1n })).rejects.toThrow('the amount must be positive');
    await expect(lump({ from: '   ' })).rejects.toThrow('say where the money came from');
    await expect(lump({ from: 'x'.repeat(201) })).rejects.toThrow('keep it under 200 characters');
    await expect(lump({ receivedOn: '2026-10-31' })).rejects.toThrow('2026-10-31 is in the future');
    await expect(buy(100n, 'nope')).rejects.toThrow('no open lump sum nope');
    await expect(buy(100n, '00000000-0000-0000-0000-000000000000')).rejects.toThrow('no open lump sum 00000000-0000-0000-0000-000000000000');
    expect(await db.query(`select 1 from lump_sums`)).toEqual([]);
  });

  it('lump_sums is append-only with RLS on', async () => {
    await lump();
    await expect(db.query(`update lump_sums set source = source`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from lump_sums`)).rejects.toThrow(/append-only/);
    await expect(db.query(`truncate lump_sums cascade`)).rejects.toThrow(/append-only/);
    expect((await db.query<{ enabled: boolean }>(`select relrowsecurity enabled from pg_class where relname = 'lump_sums'`))[0]!.enabled).toBe(true);
  });

  it('advisor_proposals accepts a LUMP_SUM proposal', async () => {
    await expect(db.query(`insert into advisor_proposals (kind, payload, input_snapshot, prompt_version, schema_version, as_of)
       values ('LUMP_SUM', '{}'::jsonb, '{}'::jsonb, 'v', 'v', now())`)).resolves.toBeDefined();
  });
});
