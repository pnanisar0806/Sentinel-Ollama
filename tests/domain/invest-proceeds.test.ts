import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadOpenLumpSums } from '../../src/domain/lump-sums.js';
import { logBondRedemption, logLumpSum, logPurchase, logSale } from '../../src/domain/owner-log.js';
import { redemptionFor } from '../../src/domain/bond-redemptions.js';
import { loadMonthSpend } from '../../src/domain/sips.js';
import { reverseEntry } from '../../src/domain/reversals.js';

/**
 * Open list #8: a sale or bond redemption the owner chooses to invest becomes money received
 * (a lump sum) in the same step, so a buy paid from it can say so on the purchase form without
 * the owner logging the same money twice.
 */
let db: Db;
const NOW = '2026-10-30T06:00:00Z';
const BOND = 'BOND:SAMMAAN-2026';

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});
afterEach(async () => { await db.close(); });

const sale = (over: Partial<Parameters<typeof logSale>[1]> = {}) => logSale(db, {
  on: '2026-10-21', instrumentId: 'US:NOW', units: 10, proceedsPaise: 12_00_000_00n, destination: null, note: '', ...over,
}, NOW);
const bond = (over: Partial<Parameters<typeof logBondRedemption>[1]> = {}) => logBondRedemption(db, {
  instrumentId: BOND, on: '2026-09-24', amountPaise: 3_24_300_00n, note: '', ...over,
}, NOW);
const saleAuditId = async () => (await db.query<{ id: string }>(
  `select id::text from audit_log where entity = 'owner_sale' and action = 'LOGGED' order by at desc, id desc limit 1`))[0]!.id;

describe('invest the proceeds of a sale (open list #8)', () => {
  it('unticked: a sale creates no lump sum', async () => {
    await sale();
    expect(await loadOpenLumpSums(db)).toEqual([]);
  });

  it('ticked: the proceeds become money received, named after the holding', async () => {
    await sale({ invest: true });
    const [l, ...rest] = await loadOpenLumpSums(db);
    expect(rest).toEqual([]);
    expect(l).toMatchObject({ receivedOn: '2026-10-21', amountPaise: 12_00_000_00n, remainingPaise: 12_00_000_00n });
    expect(l!.from).toMatch(/^Sale of /);
  });

  it('a buy paid from it stays out of the month', async () => {
    await sale({ invest: true });
    const [l] = await loadOpenLumpSums(db);
    await logPurchase(db, { boughtOn: '2026-10-29', description: 'Nifty 50 index fund', amountPaise: 1_00_000_00n, lumpSumId: l!.id }, NOW);
    expect((await loadMonthSpend(db, NOW)).ownerPaise).toBe(0n);
    expect((await loadOpenLumpSums(db))[0]!.remainingPaise).toBe(11_00_000_00n);
  });

  it('cannot both go into a goal pot and be invested', async () => {
    await expect(sale({ invest: true, destination: 'B2' })).rejects.toThrow(/pot/);
    expect(await db.query(`select 1 from owner_sales`)).toHaveLength(0);
    expect(await loadOpenLumpSums(db)).toEqual([]);
  });

  it('reversing the sale reverses its lump sum, and a buy paid from it returns to its month', async () => {
    await sale({ invest: true });
    const [l] = await loadOpenLumpSums(db);
    await logPurchase(db, { boughtOn: '2026-10-29', description: 'Nifty 50 index fund', amountPaise: 1_00_000_00n, lumpSumId: l!.id }, NOW);
    await reverseEntry(db, { entity: 'owner_sale', entityId: await saleAuditId(), reason: 'typo' }, NOW);
    expect(await loadOpenLumpSums(db)).toEqual([]);
    expect((await loadMonthSpend(db, NOW)).ownerPaise).toBe(1_00_000_00n);
  });
});

describe('invest a bond redemption (open list #8)', () => {
  it('records the redemption and its amount; unticked, no lump sum', async () => {
    await bond();
    expect((await redemptionFor(db, BOND))?.amountPaise).toBe(3_24_300_00n);
    expect(await loadOpenLumpSums(db)).toEqual([]);
  });

  it('ticked: what reached the bank becomes money received', async () => {
    await bond({ invest: true });
    const [l] = await loadOpenLumpSums(db);
    expect(l).toMatchObject({ receivedOn: '2026-09-24', amountPaise: 3_24_300_00n });
    expect(l!.from).toContain('Sammaan');
  });

  it('the same redemption cannot be invested twice while the first lump sum stands', async () => {
    await bond({ invest: true });
    await expect(bond({ invest: true })).rejects.toThrow(/already/);
    expect(await loadOpenLumpSums(db)).toHaveLength(1);
    const [l] = await loadOpenLumpSums(db);
    await reverseEntry(db, { entity: 'lump_sum', entityId: l!.id, reason: 'wrong amount' }, NOW);
    await bond({ invest: true, amountPaise: 3_24_000_00n });
    expect((await loadOpenLumpSums(db)).map((x) => x.amountPaise)).toEqual([3_24_000_00n]);
  });

  it('a failed invest leaves no half-written redemption', async () => {
    await logLumpSum(db, { receivedOn: '2026-09-24', amountPaise: 1n, from: 'x', origin: 'bond_redemption:ISIN:INE148I07GL3' }, NOW);
    await expect(bond({ invest: true })).rejects.toThrow(/already/);
    expect(await redemptionFor(db, BOND)).toBeNull();
  });
});
