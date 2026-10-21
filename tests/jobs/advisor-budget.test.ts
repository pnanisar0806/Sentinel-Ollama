import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { persistSipSnapshot } from '../../src/domain/sips.js';
import { classify } from '../../src/domain/networth.js';
import type { SipRow } from '../../src/sources/indmoney.js';
import { advisorBudget } from '../../src/jobs/report.js';
import { logPurchase } from '../../src/domain/owner-log.js';
import { recordSipPayment } from '../../src/domain/owner-sips.js';

/**
 * SIP tracking Task 8. The weekly job hands the advisor the month's budget as formatted
 * rupee strings: what is committed to SIPs, and what is free. An unknown SIP total is
 * null — never ₹0, never the whole budget.
 */
const NOW = '2026-10-14T10:00:00Z';
const row = (over: Partial<SipRow>): SipRow => ({
  sipId: 's', instrumentId: 'IND:1', isin: null, fundName: 'F', fundType: 'Equity', category: 'Index Funds',
  frequency: 'MONTHLY', amountPaise: 0n, stepUpRaw: null, stepUpFreq: null, startDate: '2025-01-05', ...over,
});
const nifty = row({ sipId: 'a', instrumentId: 'IND:5536', fundName: 'ICICI Nifty 50 Index Fund', amountPaise: 1_400_100n });
// By name alone this reads EQUITY; INDmoney's category says DEBT (Task 7's classifier).
const mm = row({ sipId: 'b', instrumentId: 'IND:9001', fundName: 'Axis Treasury Advantage', fundType: null, category: 'Money Market', amountPaise: 1_625_300n });

let db: Db;
beforeEach(async () => { db = await openDb(); await runMigrations(db); });

describe('advisorBudget', () => {
  it('formats budget, SIPs and free envelope as rupee strings, classing SIPs by category first', async () => {
    expect(classify('MF', mm.instrumentId, mm.fundName)).toBe('EQUITY'); // the premise
    await persistSipSnapshot(db, [nifty, mm], NOW);
    expect(await advisorBudget(db, NOW)).toEqual({
      monthlyBudget: '₹50,000', sipTotal: '₹30,254', sipAsOf: '2026-10-14', freeEnvelope: '₹19,746',
      spentThisMonth: '₹0', remaining: '₹19,746',
      sips: [
        { fund: 'Axis Treasury Advantage', amount: '₹16,253', assetClass: 'DEBT' },
        { fund: 'ICICI Nifty 50 Index Fund', amount: '₹14,001', assetClass: 'EQUITY' },
      ],
    });
    await db.close();
  });

  it('never synced: the envelope is null, not ₹0 and not the whole budget', async () => {
    expect(await advisorBudget(db, NOW)).toEqual({ monthlyBudget: '₹50,000', sipTotal: null, sipAsOf: null, freeEnvelope: null, spentThisMonth: '₹0', remaining: null, sips: [] });
    await db.close();
  });

  it('a stale snapshot: total and envelope null, its dated rows withheld like the rebalance withholds them', async () => {
    await persistSipSnapshot(db, [nifty], '2026-09-01T10:00:00Z');
    expect(await advisorBudget(db, NOW)).toEqual({ monthlyBudget: '₹50,000', sipTotal: null, sipAsOf: '2026-09-01', freeEnvelope: null, spentThisMonth: '₹0', remaining: null, sips: [] });
    await db.close();
  });

  it('shows what was spent this month and what remains (SIP gaps Task 2)', async () => {
    await persistSipSnapshot(db, [nifty, mm], NOW);
    await logPurchase(db, { boughtOn: '2026-10-05', description: 'Zerodha Gold ETF', amountPaise: 500_000n }, NOW);
    expect(await advisorBudget(db, NOW)).toMatchObject({ freeEnvelope: '₹19,746', spentThisMonth: '₹5,000', remaining: '₹14,746' });
    await db.close();
  });

  it('lists a SIP stopped after its instalment, tagged, so the list sums to sipTotal (final fix M2)', async () => {
    // Seen on the 14th (instalment day 5: debited), gone by the 20th: it still counts this month.
    await persistSipSnapshot(db, [nifty, mm], NOW);
    await persistSipSnapshot(db, [mm], '2026-10-20T00:00:00Z');
    const b = await advisorBudget(db, '2026-10-20T10:00:00Z');
    const rupees = (s: string) => BigInt(s.replace(/[^\d]/g, ''));
    expect(b.sips.reduce((s, x) => s + rupees(x.amount), 0n)).toBe(rupees(b.sipTotal!));
    expect(b.sips).toEqual([
      { fund: 'Axis Treasury Advantage', amount: '₹16,253', assetClass: 'DEBT' },
      { fund: 'ICICI Nifty 50 Index Fund', amount: '₹14,001', assetClass: 'EQUITY', status: 'stopped — counted this month' },
    ]);
    await db.close();
  });

  it('lists an owner-recorded payment (only what the feed lacks), so the list still sums to sipTotal', async () => {
    await db.query(`insert into instruments (id, kind, name) values ('IND:hdfc','MF','HDFC Mid Cap')`);
    await persistSipSnapshot(db, [nifty, mm], NOW);
    await recordSipPayment(db, { instrumentId: 'IND:hdfc', paidOn: '2026-10-12', amountPaise: 300_100n, source: 'owner-chat' }, NOW);
    const b = await advisorBudget(db, NOW);
    const rupees = (s: string) => BigInt(s.replace(/[^\d]/g, ''));
    expect(b.sipTotal).toBe('₹33,255');
    expect(b.sips.reduce((s, x) => s + rupees(x.amount), 0n)).toBe(rupees(b.sipTotal!));
    expect(b.sips).toContainEqual({ fund: 'HDFC Mid Cap', amount: '₹3,001', assetClass: 'EQUITY',
      status: 'paid 2026-10-12 — owner-recorded, counted this month' });
    await db.close();
  });
});
