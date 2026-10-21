import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { persistSipSnapshot } from '../../src/domain/sips.js';
import { recordSipPayment } from '../../src/domain/owner-sips.js';
import { db, getSips } from '../../web/lib/data.js';

describe('Overview SIP rows with an owner-recorded payment', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-15T08:00:00Z'));
    const d = await db();
    await runMigrations(d);
    await d.query(`insert into instruments (id, kind, name, currency) values ('MF:PAID', 'MF', 'Stopped midcap fund', 'INR')`);
    await persistSipSnapshot(d, [], '2026-10-15T07:00:00Z');
  });
  afterAll(async () => { vi.useRealTimers(); await (await db()).close(); });

  it('shows the recorded payment as a counted row, and the rows sum to the SIP total', async () => {
    const d = await db();
    await recordSipPayment(d, { instrumentId: 'MF:PAID', paidOn: '2026-10-12', amountPaise: 300100n, source: 'owner-chat' }, new Date().toISOString());
    const result = await getSips();
    expect(result.sipTotalPaise).toBe(300100n);
    expect(result.rows).toEqual([expect.objectContaining({ fund: 'Stopped midcap fund', amountPaise: 300100n, recordedPaise: 300100n, ownerPaid: true, paidOn: '2026-10-12' })]);
    expect(result.rows.reduce((sum, row) => sum + row.amountPaise, 0n)).toBe(result.sipTotalPaise);
  });

  it('a partly-covered payment row carries the full recorded amount beside the part counted', async () => {
    const d = await db();
    await persistSipSnapshot(d, [{ instrumentId: 'MF:PAID', sipId: 'x', fundName: 'Stopped midcap fund', isin: null, fundType: 'Equity',
      category: null, frequency: 'MONTHLY', stepUpRaw: null, stepUpFreq: null, startDate: '2026-01-20', amountPaise: 200000n }], new Date().toISOString());
    const result = await getSips();
    expect(result.rows.find((r) => r.ownerPaid)).toMatchObject({ amountPaise: 100100n, recordedPaise: 300100n });
    expect(result.rows.reduce((sum, row) => sum + row.amountPaise, 0n)).toBe(result.sipTotalPaise);
  });

  it('rolls the recorded payment out next month', async () => {
    vi.setSystemTime(new Date('2026-11-15T08:00:00Z'));
    await persistSipSnapshot(await db(), [], '2026-11-15T07:00:00Z');
    const result = await getSips();
    expect(result.rows).toHaveLength(0);
    expect(result.sipTotalPaise).toBe(0n);
  });
});
