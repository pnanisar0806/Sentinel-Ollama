import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadBucketBalances, loadSpLabels } from '../../src/domain/bucket-balances.js';
import { loadSizingInput } from '../../src/domain/sizing-input.js';
import { checkPortfolioRails } from '../../src/domain/rails.js';
import type { Position } from '../../src/domain/networth.js';
import { rupees, type Paise } from '../../src/money/paise.js';
import { BUCKETS } from '../../src/domain/buckets.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  for (const b of Object.values(BUCKETS)) {
    await db.query(`insert into buckets (id, name, mandate, target_note) values ($1,$2,$3,$4)`, [b.id, b.name, b.mandate, b.targetNote]);
  }
});

/** Inserts one flow and returns its uuid as text. */
async function flow(bucket: string, amount: bigint, label: string | null = null): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    `insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, label, as_of, source)
     values ($1, '2026-10-20', $2, 'earmark', $3, now(), 'owner-web') returning id::text`,
    [bucket, amount.toString(), label]);
  return row!.id;
}
const reverse = (id: string, entity = 'bucket_flow') => db.query(
  `insert into log_reversals (entity, entity_id, reason, as_of, source) values ($1, $2, 'typo', now(), 'owner-web')`,
  [entity, id]);

describe('migration 0036', () => {
  it('seeds the SP bucket and the id check accepts SP and still refuses others', async () => {
    const [sp] = await db.query<{ name: string; mandate: string; target_paise: string | null; target_note: string }>(
      `select name, mandate, target_paise::text, target_note from buckets where id = 'SP'`);
    expect(sp).toEqual({ name: 'Planned spending', mandate: 'Cash set aside for a known expense; not invested', target_paise: null, target_note: '' });
    await expect(db.query(`insert into buckets (id, name, mandate, target_note) values ('B9','x','x','')`)).rejects.toThrow(/buckets_id_check/);
  });

  it('allows two owner SIP payments for one fund in one month (the rule moved to the domain)', async () => {
    await db.query(`insert into instruments (id, kind, name, currency) values ('MF:X','MF','X','INR')`);
    const ins = () => db.query(`insert into owner_sip_payments (instrument_id, paid_on, month, amount_paise, as_of, source)
      values ('MF:X', '2026-10-05', '2026-10', 100, now(), 'owner-web')`);
    await ins();
    await expect(ins()).resolves.toBeDefined();
  });
});

describe('loadBucketBalances', () => {
  it('sums flows per bucket, skips reversed flows, and omits buckets with no rows', async () => {
    await flow('B3', 500_000n);
    const typo = await flow('B3', 9_999_900n);
    await flow('B2', 200_000n);
    await reverse(typo);
    // A reversal of some other entity with the same id text must not hide the flow.
    const kept = await flow('B4', 300n);
    await reverse(kept, 'owner_purchase');

    const balances = await loadBucketBalances(db);
    expect(balances.get('B3')).toBe(500_000n);
    expect(balances.get('B2')).toBe(200_000n);
    expect(balances.get('B4')).toBe(300n);
    expect(balances.has('B1')).toBe(false);
    expect(balances.has('SP')).toBe(false);
  });
});

describe('loadSpLabels', () => {
  it('lists open SP labels from non-reversed rows only', async () => {
    await flow('SP', 25_000_000n, 'Himachal trip');
    await flow('SP', -10_000_000n, 'Himachal trip');
    await flow('SP', 5_000_000n, 'Laptop');
    await flow('SP', -5_000_000n, 'Laptop');                 // closed at ₹0
    const wrong = await flow('SP', 7_000_000n, 'Typo');
    await reverse(wrong);
    expect(await loadSpLabels(db)).toEqual([{ label: 'Himachal trip', balancePaise: 15_000_000n }]);
  });
});

describe('SP is held back from investable cash, exactly like B3 (spec §7.1)', () => {
  beforeEach(() => seed(db, { asOf: '2026-08-12' }));

  it('loadSizingInput cash excludes SP and a reversed SP flow comes back', async () => {
    // The seed carries no bank row; add one to its snapshot.
    await db.query(`insert into instruments (id, kind, name, currency) values ('CASH:T','CASH','Bank','INR')`);
    await db.query(`insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
      select id, 'CASH:T', 1, 50000000, 'x', now(), 'manual-seed' from snapshots where source = 'manual-seed'`);
    const before = (await loadSizingInput(db, '2026-09-27')).cashAvailablePaise;
    expect(before).not.toBeNull();
    const id = await flow('SP', 1_000_000n, 'Himachal trip');
    await flow('B3', 400_000n);
    expect((await loadSizingInput(db, '2026-09-27')).cashAvailablePaise).toBe(before! - 1_400_000n);
    await reverse(id);
    expect((await loadSizingInput(db, '2026-09-27')).cashAvailablePaise).toBe(before! - 400_000n);
  });

  it('the cash ceiling excuses SP money', async () => {
    const pos = (id: string, assetClass: 'CASH' | 'EQUITY', value: Paise): Position => ({
      instrumentId: id, name: id, kind: assetClass, valuePaise: value, sector: null, currency: 'INR', account: 'bank',
      source: 'test', asOf: new Date().toISOString(), assetClass, issuer: null, isEmployer: false, avgCostPaise: null,
    });
    const positions = [pos('CASH:S', 'CASH', rupees(200_000)), pos('NSE:EQ', 'EQUITY', rupees(800_000))];
    const ceiling = async () => (await checkPortfolioRails(db, positions, rupees(1_000_000))).filter((b) => b.code === 'CASH_CEILING');
    expect(await ceiling()).toHaveLength(1);             // 20% idle
    await flow('SP', rupees(100_000), 'Himachal trip');   // 10% idle after SP: at the inclusive cap
    expect(await ceiling()).toHaveLength(0);
  });
});
