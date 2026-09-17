import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { persistSchedules } from '../../src/domain/loans.js';
import { installIps } from '../../src/domain/ips.js';
import { confirmVest, persistVests } from '../../src/domain/rsu.js';
import { buildDigestInput, composeDigest } from '../../src/notify/digest.js';
import { formatInr } from '../../src/money/paise.js';
import { dollars } from '../../src/money/paise.js';
import { rateMicros } from '../../src/money/fx.js';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
  await persistSchedules(db, '2026-09-01');
  await installIps(db);
});

const mockLiveInputs = {
    nowPriceCents: 18547n,
    usdInr: 83.5,
    asOf: '2026-08-12T08:45:00+05:30',
  };

describe('daily digest', () => {
  it('leads with total net worth including NOW and EPF', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30', mockLiveInputs));
    expect(text).toMatch(/Net worth/i);
    expect(text).toMatch(/ServiceNow|NOW/);
    expect(text).toMatch(/EPF/i);
  });

  // This asserted only /Liabilities/i, so swapping netPaise for assetsPaise in the
  // renderer kept it green. The figures are asserted exactly in digest-money.test.ts;
  // here we pin that net is not merely present but DIFFERENT from assets.
  it('shows liabilities and a true net figure', async () => {
    const input = await buildDigestInput(db, '2026-08-12T08:45:00+05:30', mockLiveInputs);
    const text = composeDigest(input);
    expect(text).toMatch(/Liabilities/i);
    expect(input.liabilitiesPaise).toBeGreaterThan(0n);
    expect(text).toContain(formatInr(input.netPaise, { compact: true }));
    expect(text).not.toContain(`*Net: ${formatInr(input.assetsPaise, { compact: true })}*`);
  });

  it('reports all four buckets and nags both milestones', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30', mockLiveInputs));
    for (const b of ['FI corpus', 'House fund', 'Emergency fund', 'Education corpus']) {
      expect(text).toContain(b);
    }
    expect(text).toMatch(/Term life cover/);
    expect(text).toMatch(/Health super top-up/);
  });

  it('flags the employer concentration breach the seeded portfolio actually has', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30', mockLiveInputs));
    expect(text).toMatch(/Employer cap/i);
  });

  it('badges staleness loudly when a source is old (FR-31)', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-20T08:45:00+05:30', mockLiveInputs));
    expect(text).toMatch(/STALE/i);
  });

  // `/fresh/i` was matched by the section header "*Data freshness*" itself, so this
  // passed when every single source was stale. Assert the actual all-clear line.
  it('says data is fresh when it is', async () => {
    const input = await buildDigestInput(db, '2026-08-12T08:45:00+05:30', mockLiveInputs);
    const text = composeDigest(input);
    expect(input.staleness.filter((x) => x.stale).map((x) => x.source)).not.toContain('manual-seed');
    expect(text).not.toMatch(/STALE: manual-seed/);
  });

  it('cites the IPS version it is reporting against', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30', mockLiveInputs));
    expect(text).toMatch(/IPS v1/);
  });

  it('states that Phase 0 has no pending approvals rather than omitting the section', async () => {
    const text = composeDigest(await buildDigestInput(db, '2026-08-12T08:45:00+05:30', mockLiveInputs));
    expect(text).toMatch(/Pending approvals/i);
  });

  it('is a pure function — the same input renders the same output', async () => {
    const input = await buildDigestInput(db, '2026-08-12T08:45:00+05:30', mockLiveInputs);
    expect(composeDigest(input)).toBe(composeDigest(input));
  });

  it('stops announcing a vest once the owner confirmed it ACTUAL (no double forecast)', async () => {
    const before = await buildDigestInput(db, '2026-08-12T08:45:00+05:30', mockLiveInputs);
    expect(before.nextVest).not.toBeNull();
    const target = before.nextVest!;

    // Approve the projected vest exactly as the owner would on the statement.
    await persistVests(db, [{
      grantId: target.grantId, vestOn: target.vestOn, units: target.units,
      status: 'PROJECTED', grossPaise: target.grossPaise, netPaise: target.netPaise,
    }], { asOf: '2026-08-12T08:45:00+05:30' });
    const [row] = await db.query<{ id: string }>(
      'select id from rsu_vests where grant_id = $1 and vest_on = $2',
      [target.grantId, target.vestOn],
    );
    await confirmVest(db, row!.id, {
      units: target.units,
      priceUsdCents: dollars(ASSUMPTIONS.seedNowPriceUsd),
      usdInrMicros: rateMicros(ASSUMPTIONS.seedUsdInr),
      netPaise: target.netPaise,
    }, { asOf: '2026-08-12T08:45:00+05:30' });

    const after = await buildDigestInput(db, '2026-08-12T08:45:00+05:30', mockLiveInputs);
    expect(after.nextVest).not.toBeNull();
    // Grant grantIds share the same quarterly cycle, so the next announcement is the same
    // date one grant along — never the confirmed pair again.
    expect(after.nextVest!.grantId).not.toBe(target.grantId);
    expect(after.nextVest!.vestOn).toBe(target.vestOn);
  });

  it('shows 14-day bond maturity alert when a bond is maturing soon', async () => {
    // Sammaan 2026 bond matures 2026-09-26; use 2026-09-20 (6 days before)
    const mockLiveInputs = {
      nowPriceCents: 18547n, // $185.47
      usdInr: 83.5,
      asOf: '2026-09-20T08:45:00+05:30',
    };
    const input = await buildDigestInput(db, '2026-09-20T08:45:00+05:30', mockLiveInputs);
    expect(input.upcomingMaturities.length).toBeGreaterThan(0);
    const sammaan = input.upcomingMaturities.find(m => m.instrumentId === 'BOND:SAMMAAN-2026');
    expect(sammaan).toBeDefined();
    expect(sammaan!.daysUntil).toBeLessThanOrEqual(14);

    const text = composeDigest(input);
    expect(text).toMatch(/Bond maturities — 14-day alert/);
    expect(text).toContain('Sammaan Capital');
    expect(text).toContain('INE148I07GL3');
    expect(text).toMatch(/Per IPS §3\.9/);
  });

  it('does not show bond maturity alert when no bonds are maturing within 14 days', async () => {
    // Use seed date 2026-08-12, which is ~45 days before Sammaan maturity
    const mockLiveInputs = {
      nowPriceCents: 18547n,
      usdInr: 83.5,
      asOf: '2026-08-12T08:45:00+05:30',
    };
    const input = await buildDigestInput(db, '2026-08-12T08:45:00+05:30', mockLiveInputs);
    expect(input.upcomingMaturities.length).toBe(0);

    const text = composeDigest(input);
    expect(text).not.toMatch(/Bond maturities — 14-day alert/);
  });
});