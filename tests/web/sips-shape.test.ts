import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { parseMfSips } from '../../src/sources/indmoney.js';
import { persistSipSnapshot } from '../../src/domain/sips.js';
import { logPurchase } from '../../src/domain/owner-log.js';
import { db, getSips } from '../../web/lib/data.js';

const live = parseMfSips({
  result: JSON.stringify(JSON.parse(await readFile('tests/fixtures/indmoney-mf-sips-2026-10-14.json', 'utf8')).payload),
});

// One web `db()` singleton per file: the empty case must run before a snapshot exists.
describe('getSips', () => {
  beforeAll(async () => { await runMigrations(await db()); });

  it('getSips with no snapshot: unknown everywhere', async () => {
    const d = await getSips();
    expect(d).toMatchObject({ asOf: null, sipTotalPaise: null, envelopePaise: null, rows: [] });
    expect(d.reason).toMatch(/never synced/);
    // Unknown envelope: remaining unknown (null, not 0n); spend is a sum of rows, always known.
    expect(d.remainingPaise).toBeNull();
    expect(d.spentPaise).toBe(0n);
  });

  it('getSips with a stale snapshot: no precise next step-up total beside "SIPs unknown"', async () => {
    await persistSipSnapshot(await db(), live, new Date(Date.now() - 8 * 86_400_000).toISOString());
    const d = await getSips();
    expect(d).toMatchObject({ stale: true, sipTotalPaise: null, envelopePaise: null });
    expect(d.rows).toHaveLength(live.length); // rows still shown, dated
    expect(d.nextStepUp?.on).toBe('2027-11-12');
    expect(d.nextStepUp?.totalPaise).toBeNull();
  });

  it('getSips: live SIPs, budget and envelope, with nulls never coerced to 0', async () => {
    await persistSipSnapshot(await db(), live, new Date().toISOString());
    const d = await getSips();
    expect(d.sipTotalPaise).toBe(live.reduce((s, r) => s + r.amountPaise, 0n));
    // The tactical rail is exposed so the page can say when it, not budget − SIPs, binds.
    const free = d.budgetPaise - d.sipTotalPaise!;
    expect(d.envelopePaise).toBe(free < d.tacticalPaise ? free : d.tacticalPaise);
    expect(d.rows.every((r) => r.assetClass === 'EQUITY')).toBe(true);
    expect(d.rows[0]).toMatchObject({ stepUp: '10%', stepUpInferred: true });
    expect(d.nextStepUp?.on).toBe('2027-11-12');
    // All three step 10% that day, each rounded down to the rupee: ₹15,401 + ₹2,476 + ₹12,101.
    expect(d.nextStepUp?.totalPaise).toBe(2_997_800n);
  });

  it('next step-up total: only the earliest-date SIPs move; an unknown new amount makes it unknown', async () => {
    const later = (s: number) => new Date(Date.now() + s * 1000).toISOString();
    await persistSipSnapshot(await db(), [live[0]!, { ...live[1]!, startDate: '2026-12-01' }], later(1));
    let d = await getSips();
    expect(d.nextStepUp).toEqual({ on: '2027-11-12', totalPaise: 1_540_100n + live[1]!.amountPaise });

    await persistSipSnapshot(await db(), [live[0]!, { ...live[2]!, stepUpRaw: null }], later(2));
    d = await getSips();
    expect(d.nextStepUp).toEqual({ on: '2027-11-12', totalPaise: null });
  });

  it('spent, remaining and departed rows: a SIP stopped after its instalment still counts; a last-month purchase does not', async () => {
    const later = (s: number) => new Date(Date.now() + s * 1000).toISOString();
    // Instalment day 01: any snapshot this IST month is on or after it, so it was debited.
    const gone = { ...live[1]!, sipId: 'DEPARTED-1', fundName: 'Stopped Fund', startDate: '2025-01-01' };
    await persistSipSnapshot(await db(), [...live, gone], later(3));
    await persistSipSnapshot(await db(), live, later(4));

    const nowIst = new Date(Date.now() + 330 * 60_000).toISOString();
    const today = nowIst.slice(0, 10);
    const [y, m] = today.split('-').map(Number) as [number, number];
    const lastMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
    await logPurchase(await db(), { boughtOn: today, description: 'Gold ETF', amountPaise: 10_000n });
    await logPurchase(await db(), { boughtOn: lastMonth, description: 'Old buy', amountPaise: 99_900n });

    const d = await getSips();
    const departed = d.rows.filter((r) => r.departed);
    expect(departed.map((r) => r.key)).toEqual(['DEPARTED-1']);
    expect(d.rows.filter((r) => !r.departed)).toHaveLength(live.length);
    // The rows sum to the SIPs total, departed included.
    expect(d.sipTotalPaise).toBe(d.rows.reduce((s, r) => s + r.amountPaise, 0n));
    expect(d.sipTotalPaise).toBe(live.reduce((s, r) => s + r.amountPaise, 0n) + gone.amountPaise);
    // A departed SIP has no next step-up.
    expect(departed[0]).toMatchObject({ nextOn: null, nextAmountPaise: null });

    expect(d.spentPaise).toBe(10_000n); // last month's ₹999 is not this month's spend
    expect(d.envelopePaise).not.toBeNull();
    const left = d.envelopePaise! - d.spentPaise;
    expect(d.remainingPaise).toBe(left > 0n ? left : 0n);
  });
});
