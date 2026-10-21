import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { recordSipPayment } from '../../src/domain/owner-sips.js';
import { loadFreeEnvelope, loadOwnerSipPayments, loadSipCommitment, persistSipSnapshot } from '../../src/domain/sips.js';
import { logPurchase } from '../../src/domain/owner-log.js';

const NOW = '2026-10-15T10:00:00Z';
const payment = { instrumentId: 'IND:test', paidOn: '2026-10-12', amountPaise: 300_100n, source: 'owner-chat' };
const sip = (instrumentId: string, sipId: string, amountPaise: bigint, fundName = 'Test fund') => ({ instrumentId, sipId, fundName,
  isin: null, fundType: 'Equity', category: null, frequency: 'MONTHLY', stepUpRaw: null, stepUpFreq: null,
  startDate: '2026-01-12', amountPaise });
let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await db.query(`insert into instruments (id, kind, name) values ('IND:test','MF','Test fund')`);
  await persistSipSnapshot(db, [], NOW);
});
afterEach(async () => { await db.close(); });

describe('owner SIP payments', () => {
  it('counts a payment missing from every snapshot only in its IST month', async () => {
    await recordSipPayment(db, payment, NOW);
    const c = await loadSipCommitment(db, NOW);
    expect(c.totalPaise).toBe(300_100n);
    expect(c.ownerPaidThisMonth[0]).toMatchObject({ countedPaise: 300_100n, source: 'owner-chat', paidOn: '2026-10-12' });
    // 19:00Z on 31 Oct is 00:30 IST on 1 Nov: already the next month.
    await persistSipSnapshot(db, [], '2026-10-31T19:00:00Z');
    expect((await loadSipCommitment(db, '2026-10-31T19:00:00Z')).totalPaise).toBe(0n);
  });
  it('never adds on top of the feed: counts only what the feed does not carry for that fund', async () => {
    await recordSipPayment(db, payment, NOW);
    await persistSipSnapshot(db, [sip('IND:test', 'a', 200_000n), sip('IND:test', 'b', 100_100n)], NOW);
    const c = await loadSipCommitment(db, NOW);
    expect(c.totalPaise).toBe(300_100n);
    expect(c.ownerPaidThisMonth[0]!.countedPaise).toBe(0n);
  });
  it('reconciles MFU and IND aliases by ISIN and rejects an alias duplicate', async () => {
    await db.query(`update instruments set isin='INFTEST00001' where id='IND:test'`);
    await db.query(`insert into instruments (id,kind,name,isin) values ('MFU:test','MF','Test fund','INFTEST00001')`);
    await recordSipPayment(db, { ...payment, instrumentId: 'MFU:test' }, NOW);
    await expect(recordSipPayment(db, payment, NOW)).rejects.toThrow(/already recorded/);
    await persistSipSnapshot(db, [sip('IND:test', 'a', 200_000n)], NOW);
    const c = await loadSipCommitment(db, NOW);
    expect(c.totalPaise).toBe(300_100n);
    expect(c.ownerPaidThisMonth[0]!.countedPaise).toBe(100_100n);
  });
  it('keeps stale or absent feeds unknown despite owner payments', async () => {
    await recordSipPayment(db, payment, NOW);
    expect((await loadSipCommitment(db, '2026-10-23T10:00:00Z')).totalPaise).toBeNull();
    const other = await openDb();
    try {
      await runMigrations(other);
      await other.query(`insert into instruments (id,kind,name) values ('IND:test','MF','Test fund')`);
      await recordSipPayment(other, payment, NOW);
      expect((await loadSipCommitment(other, NOW)).totalPaise).toBeNull();
    } finally { await other.close(); }
  });
  it('rejects duplicates and invalid inputs without an audit row', async () => {
    await recordSipPayment(db, payment, NOW);
    await expect(recordSipPayment(db, payment, NOW)).rejects.toThrow(/already recorded/);
    await expect(recordSipPayment(db, { ...payment, paidOn: '2026-02-30' }, NOW)).rejects.toThrow(/date/);
    await expect(recordSipPayment(db, { ...payment, paidOn: '2026-10-16' }, NOW)).rejects.toThrow(/future/);
    await expect(recordSipPayment(db, { ...payment, amountPaise: 0n }, NOW)).rejects.toThrow(/positive/);
    await expect(recordSipPayment(db, { ...payment, paidOn: '2026-09-12', source: ' ' }, NOW)).rejects.toThrow(/source/);
    await expect(recordSipPayment(db, { ...payment, paidOn: '2026-09-12', instrumentId: 'IND:nope' }, NOW)).rejects.toThrow(/mutual fund/);
    expect(await db.query(`select * from audit_log where entity = 'owner_sip_payment'`)).toHaveLength(1);
    expect(await loadOwnerSipPayments(db, NOW)).toHaveLength(1);
  });
  it('keeps rows immutable including truncate, with RLS and audit provenance', async () => {
    await recordSipPayment(db, payment, NOW);
    await expect(db.exec(`update owner_sip_payments set note = 'changed'`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`delete from owner_sip_payments`)).rejects.toThrow(/append-only/);
    await expect(db.exec(`truncate owner_sip_payments`)).rejects.toThrow(/append-only/);
    expect((await db.query<{ enabled: boolean }>(`select relrowsecurity enabled from pg_class where relname='owner_sip_payments'`))[0]!.enabled).toBe(true);
    const [a] = await db.query<{ payload: { source: string; asOf: string } }>(`select payload from audit_log where entity='owner_sip_payment'`);
    expect(a!.payload).toMatchObject({ source: 'owner-chat', asOf: NOW });
  });
});

// R1 (owner, 2026-10-15/16): October 2026 as it really happened.
describe('R1: October 2026 remaining-to-invest', () => {
  const feed = [sip('IND:icici', 'icici', 1_400_100n, 'ICICI Nifty 50'), sip('IND:ppfas', 'ppfas', 1_100_100n, 'PPFAS Flexi Cap'),
    sip('IND:bandhan', 'bandhan', 225_100n, 'Bandhan Small Cap')];
  const OCT = '2026-10-16T06:00:00Z';
  beforeEach(async () => {
    await db.query(`insert into instruments (id, kind, name) values ('IND:icici','MF','ICICI Nifty 50'),
      ('IND:ppfas','MF','PPFAS Flexi Cap'),('IND:bandhan','MF','Bandhan Small Cap'),('IND:hdfc','MF','HDFC Mid Cap')`);
    await persistSipSnapshot(db, feed, OCT);
    await recordSipPayment(db, { instrumentId: 'IND:hdfc', paidOn: '2026-10-12', amountPaise: 300_100n, source: 'owner-chat' }, OCT);
    await logPurchase(db, { boughtOn: '2026-10-15', description: 'logged purchase', amountPaise: 1_972_400n }, OCT);
  });

  it('SIPs ₹30,254, spent ₹19,724, remaining ₹22 of a ₹50,000 budget', async () => {
    const e = await loadFreeEnvelope(db, OCT);
    expect(e.budgetPaise).toBe(5_000_000n);
    expect(e.sipTotalPaise).toBe(3_025_400n);
    expect(e.spentPaise).toBe(1_972_400n);
    expect(e.remainingPaise).toBe(2_200n);
  });

  it('a recorded payment for a fund the feed already shows does not double count', async () => {
    await recordSipPayment(db, { instrumentId: 'IND:icici', paidOn: '2026-10-12', amountPaise: 1_400_100n, source: 'owner-chat' }, OCT);
    const e = await loadFreeEnvelope(db, OCT);
    expect(e.sipTotalPaise).toBe(3_025_400n);
    expect(e.remainingPaise).toBe(2_200n);
  });

  it('November: the HDFC record no longer counts', async () => {
    const NOV = '2026-11-14T06:00:00Z';
    await persistSipSnapshot(db, feed, NOV);
    const e = await loadFreeEnvelope(db, NOV);
    expect(e.sipTotalPaise).toBe(2_725_300n);
    expect(e.spentPaise).toBe(0n);
    expect((await loadSipCommitment(db, NOV)).ownerPaidThisMonth).toEqual([]);
  });
});
