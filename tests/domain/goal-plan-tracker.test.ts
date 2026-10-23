import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { loadGoalTracker, type GoalCard, type GoalTracker } from '../../src/domain/goal-plan.js';
import { loadPositions } from '../../src/domain/networth.js';
import { logSale } from '../../src/domain/owner-log.js';
import { reverseEntry } from '../../src/domain/reversals.js';
import { levelMonthlyToClose, newMoneyMix, potsTotal, realRates } from '../../src/domain/goal-math.js';
import { BUCKETS } from '../../src/domain/buckets.js';
import { formatInr, rupees, type Paise } from '../../src/money/paise.js';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';

const NOW = '2026-10-21T06:00:00Z'; // IST 2026-10-21 11:30
const FRESH = '2026-10-19';          // 2 days before NOW
const STALE = '2026-10-13';          // 8 days before NOW

/** The fixture's positions, by asset class. Every expectation below is derived from these rows. */
const HOLDINGS = [
  { id: 'NSE:EQ', kind: 'EQUITY', name: 'Some equity', value: rupees(1_000_000) },
  { id: 'BOND:X', kind: 'BOND', name: 'Some bond', value: rupees(300_000) },
  { id: 'EPF:X', kind: 'EPF', name: 'EPF', value: rupees(1_354_000) },
  { id: 'GOLD:X', kind: 'GOLD', name: 'Gold', value: rupees(200_000) },
  { id: 'CASH:X', kind: 'CASH', name: 'Bank', value: rupees(300_000) },
] as const;
const RSU_STALE_VALUE = rupees(1_072_974); // the stale manual seed value_paise — must never be read
const RSU_QTY = 78n;
const NOW_CLOSE = 1_420_627n;              // ₹14,206.27 per share, already INR
const B2_FLOW = rupees(250_000);
const B3_FLOW = rupees(150_000);

let db: Db;

async function fixture(o: { rsuHolding?: boolean; priceDate?: string | null; b2?: bigint } = {}): Promise<void> {
  db = await openDb();
  await runMigrations(db);
  for (const b of Object.values(BUCKETS)) {
    await db.query(`insert into buckets (id, name, mandate, target_paise, target_note) values ($1,$2,$3,$4,$5)`,
      [b.id, b.name, b.mandate, b.targetPaise?.toString() ?? null, b.targetNote]);
  }
  const [snap] = await db.query<{ id: string }>(
    `insert into snapshots (business_date, source) values ('2026-10-20', 'manual-seed') returning id`);
  const rows: [string, string, string, bigint, bigint, string][] = HOLDINGS.map(
    (h) => [h.id, h.kind, h.name, 1n, h.value, 'INR']);
  if (o.rsuHolding !== false) rows.push(['US:NOW', 'RSU', 'ServiceNow', RSU_QTY, RSU_STALE_VALUE, 'USD']);
  for (const [id, kind, name, qty, value, ccy] of rows) {
    await db.query(`insert into instruments (id, kind, name, currency) values ($1,$2,$3,$4) on conflict do nothing`,
      [id, kind, name, ccy]);
    await db.query(
      `insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
       values ($1,$2,$3,$4,'x','2026-10-20T00:00:00Z','manual-seed')`,
      [snap!.id, id, qty.toString(), value.toString()]);
  }
  if (o.priceDate !== null) {
    await db.query(`insert into instruments (id, kind, name, currency) values ('US:NOW','RSU','ServiceNow','USD') on conflict do nothing`);
    await db.query(
      `insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of)
       values ('US:NOW', '2026-09-01', 999, 'yahoo', '2026-09-01T21:00:00Z'),
              ('US:NOW', $1, $2, 'yahoo', $1::date + time '21:00')`,
      [o.priceDate ?? FRESH, NOW_CLOSE.toString()]);
  }
  for (const [bucket, amt] of [['B2', o.b2 ?? B2_FLOW], ['B3', B3_FLOW]] as const) {
    await db.query(
      `insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, as_of, source)
       values ($1, '2026-10-01', $2, 'seed', now(), 'test')`, [bucket, amt.toString()]);
  }
}

const card = (t: GoalTracker, id: GoalCard['id']) => t.cards.find((c) => c.id === id)!;
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
const byKind = (k: string) => sum(HOLDINGS.filter((h) => h.kind === k).map((h) => h.value));

describe('goal tracker: FI', () => {
  beforeEach(() => fixture());

  it('FI pots exclude the RSU and take the bucket money out of cash first', async () => {
    const t = await loadGoalTracker(db, NOW);
    const flows = B2_FLOW + B3_FLOW;
    const cash = byKind('CASH');
    expect(t.fiPots).toEqual({
      equity: byKind('EQUITY'),
      debt: byKind('BOND') + byKind('EPF') - (flows > cash ? flows - cash : 0n),
      gold: byKind('GOLD'),
      cash: flows > cash ? 0n : cash - flows,
    });
    expect(card(t, 'FI').targetPaise).toBeGreaterThan(0n);
    expect(['ON_TRACK', 'SHORT']).toContain(card(t, 'FI').verdict);
  });

  it('FI corpus subtracts Planned spending (SP) like B2-B4, and skips reversed flows', async () => {
    const SP_FLOW = rupees(120_000);
    await db.query(
      `insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, label, as_of, source)
       values ('SP', '2026-10-01', $1, 'earmark', 'Himachal trip', now(), 'owner-web')`, [SP_FLOW.toString()]);
    const [typo] = await db.query<{ id: string }>(
      `insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, as_of, source)
       values ('B3', '2026-10-02', 5000000, 'seed', now(), 'owner-web') returning id::text`);
    await db.query(`insert into log_reversals (entity, entity_id, reason, as_of, source) values ('bucket_flow', $1, 'typo', now(), 'owner-web')`, [typo!.id]);
    const gross = sum(HOLDINGS.map((h) => h.value));
    const fi = card(await loadGoalTracker(db, NOW), 'FI');
    expect(fi.balancePaise).toBe(gross - B2_FLOW - B3_FLOW - SP_FLOW);
    expect(card(await loadGoalTracker(db, NOW), 'EMERGENCY').balancePaise).toBe(B3_FLOW);
  });

  it('Review Focus 2: no rupee is counted twice across the four goals', async () => {
    const t = await loadGoalTracker(db, NOW);
    const positions = await loadPositions(db);
    const assets = sum(positions.map((p) => p.valuePaise));
    const rsuPosition = sum(positions.filter((p) => p.kind === 'RSU').map((p) => p.valuePaise));
    const balances = sum(t.cards.map((c) => c.balancePaise ?? 0n));
    expect(balances).toBeLessThanOrEqual(assets - rsuPosition + RSU_QTY * NOW_CLOSE);
  });

  it('bucket money beyond cash, debt and equity comes out of gold too, and any excess is surfaced', async () => {
    const assets = sum(HOLDINGS.map((h) => h.value));
    const b2 = assets + rupees(10_000); // with B3, owed exceeds every FI pot, gold included
    await fixture({ b2 });
    const fi = card(await loadGoalTracker(db, NOW), 'FI');
    expect(fi.balancePaise).toBe(0n);
    expect(fi.reason).toBe(
      `House, emergency, education and planned-spending money exceeds the holdings by ${formatInr((b2 + B3_FLOW - assets) as Paise)}`);
  });

  it('FI assumptions state the nominal step-up from the same constant as the real one', async () => {
    const fi = card(await loadGoalTracker(db, NOW), 'FI');
    expect(fi.assumptions).toContain(
      `Both contributions grow 4% real a year (${ASSUMPTIONS.sipStepUp * 100}% nominal)`);
  });

  it('FI projects with the owner-signed equity ceiling, and its assumptions name the share used', async () => {
    const at60 = card(await loadGoalTracker(db, NOW), 'FI');
    expect(at60.assumptions[0]).toMatch(/: equity 60%, gold 7\.5%, debt the rest$/);
    await db.query(`insert into settings_rails (key, value) values ('goal_equity_ceiling_pct', '68'::jsonb)`);
    const at68 = card(await loadGoalTracker(db, NOW), 'FI');
    // Equity's real rate is above debt's, so more equity in new money projects higher.
    expect(realRates('central').equityBps).toBeGreaterThan(realRates('central').debtBps);
    expect(at68.projectedPaise!).toBeGreaterThan(at60.projectedPaise!);
    expect(at68.assumptions[0]).toMatch(/: equity 68% \(owner-signed goal ceiling; IPS §3\.3 is 60%\), gold 7\.5%, debt the rest$/);
  });

  it('T2: FI assumptions name the rate the shortfall is computed at', async () => {
    const t = await loadGoalTracker(db, NOW);
    const fi = card(t, 'FI');
    const c = realRates('central');
    const m = newMoneyMix(60);
    const blend = Math.floor((c.equityBps * m.equityBps + c.debtBps * m.debtBps + c.goldBps * m.goldBps) / 10_000);
    // The stated rate is the one the shortfall really uses.
    const months = (ASSUMPTIONS.ownerBirthYear + ASSUMPTIONS.fiTargetAge) * 12 - (2026 * 12 + 9);
    expect(fi.shortMonthlyPaise).toBe(levelMonthlyToClose(fi.targetPaise - fi.projectedPaise!, months, blend));
    expect(fi.assumptions).toContain(`₹/month short: the gap closed with new money at ${blend / 100}% real (the new-money mix, central rates)`);
  });

  it('FI finish year in central is no later than its projection at 2050 implies', async () => {
    const fi = card(await loadGoalTracker(db, NOW), 'FI');
    if (fi.verdict === 'ON_TRACK') expect(fi.finishYear.central).toBeLessThanOrEqual(2050);
    else expect(fi.finishYear.central === null || fi.finishYear.central >= 2050).toBe(true);
  });
});

describe('goal tracker: house', () => {
  it('balance = B2 flows + 78 × the fresh close; the stale value_paise is ignored', async () => {
    await fixture();
    const house = card(await loadGoalTracker(db, NOW), 'HOUSE');
    expect(house.balancePaise).toBe(B2_FLOW + RSU_QTY * NOW_CLOSE);
    expect(house.balancePaise).not.toBe(B2_FLOW + RSU_STALE_VALUE);
    expect(house.balanceParts.map((p) => p.paise)).toEqual([B2_FLOW, RSU_QTY * NOW_CLOSE]);
  });

  it('Review Focus 1: a price 8 days old makes the house UNKNOWN with a null balance', async () => {
    await fixture({ priceDate: STALE });
    const house = card(await loadGoalTracker(db, NOW), 'HOUSE');
    expect(house.verdict).toBe('UNKNOWN');
    expect(house.balancePaise).toBeNull();
    expect(house.projectedPaise).toBeNull();
    expect(house.shortMonthlyPaise).toBeNull();
    expect(house.reason).toBe('ServiceNow price is 8 days old');
  });

  it('Review Focus 1: no price at all is UNKNOWN, never ₹0', async () => {
    await fixture({ priceDate: null });
    const house = card(await loadGoalTracker(db, NOW), 'HOUSE');
    expect(house.verdict).toBe('UNKNOWN');
    expect(house.balancePaise).toBeNull();
  });

  it('Review Focus 1: no RSU holding row gives a known balance of B2 only', async () => {
    await fixture({ rsuHolding: false });
    const house = card(await loadGoalTracker(db, NOW), 'HOUSE');
    expect(house.balancePaise).toBe(B2_FLOW);
    expect(house.verdict).not.toBe('UNKNOWN');
  });

  it('M-4: the RSU comes from the latest snapshot per source; a newer snapshot without it means not held', async () => {
    await fixture();
    const [snap] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ('2026-10-21', 'manual-seed') returning id`);
    await db.query(`insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
                    values ($1, 'NSE:EQ', 1, 100, 'x', '2026-10-21T00:00:00Z', 'manual-seed')`, [snap!.id]);
    const house = card(await loadGoalTracker(db, NOW), 'HOUSE');
    expect(house.balancePaise).toBe(B2_FLOW);
    expect(house.balanceParts.map((p) => p.label)).toEqual(['House fund (B2) money']);
    // The same newer snapshot holding 80 shares: 80 is counted, not the older 78.
    await db.query(`insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
                    values ($1, 'US:NOW', 80, 1, 'x', '2026-10-21T00:00:00Z', 'manual-seed')`, [snap!.id]);
    expect(card(await loadGoalTracker(db, NOW), 'HOUSE').balancePaise).toBe(B2_FLOW + 80n * NOW_CLOSE);
  });

  it('a logged sale of 10 of the 78 seeded shares into B2 leaves 68 shares plus the proceeds; reversing restores 78', async () => {
    await fixture();
    const PROCEEDS = rupees(1_200_000);
    await logSale(db, { on: '2026-10-21', instrumentId: 'US:NOW', units: 10, proceedsPaise: PROCEEDS, destination: 'B2', note: '' }, NOW);
    const house = card(await loadGoalTracker(db, NOW), 'HOUSE');
    expect(house.balanceParts.map((p) => p.paise)).toEqual([B2_FLOW + PROCEEDS, 68n * NOW_CLOSE]);
    expect(house.balanceParts[1]!.label).toMatch(/^68 ServiceNow shares @/);
    // A sale dated before the seed row's as_of (2026-10-20 IST) is already in its 78.
    await logSale(db, { on: '2026-10-19', instrumentId: 'US:NOW', units: 5, proceedsPaise: 1n, destination: null, note: '' }, NOW);
    expect(card(await loadGoalTracker(db, NOW), 'HOUSE').balanceParts[1]!.paise).toBe(68n * NOW_CLOSE);
    const [a] = await db.query<{ id: string }>(`select id::text from audit_log where entity = 'owner_sale' order by id limit 1`);
    await reverseEntry(db, { entity: 'owner_sale', entityId: a!.id, reason: 'typo' }, NOW);
    expect(card(await loadGoalTracker(db, NOW), 'HOUSE').balanceParts.map((p) => p.paise)).toEqual([B2_FLOW, RSU_QTY * NOW_CLOSE]);
  });

  it('a sold-out RSU is not held: the house is B2 money only', async () => {
    await fixture();
    await logSale(db, { on: '2026-10-21', instrumentId: 'US:NOW', units: 78, proceedsPaise: 1n, destination: null, note: '' }, NOW);
    expect(card(await loadGoalTracker(db, NOW), 'HOUSE').balanceParts.map((p) => p.label)).toEqual(['House fund (B2) money']);
  });

  it('Review Focus 3: a house over target is ON_TRACK with a shortfall of 0n', async () => {
    await fixture({ b2: BUCKETS.B2.targetPaise! + 1n });
    const house = card(await loadGoalTracker(db, NOW), 'HOUSE');
    expect(house.verdict).toBe('ON_TRACK');
    expect(house.shortMonthlyPaise).toBe(0n);
  });

  it('a short house needs the level monthly that closes the projected gap at the debt rate', async () => {
    await fixture();
    const house = card(await loadGoalTracker(db, NOW), 'HOUSE');
    expect(house.verdict).toBe('SHORT');
    const months = 2033 * 12 - (2026 * 12 + 9); // Oct 2026 → Jan 2033
    expect(house.shortMonthlyPaise).toBe(
      levelMonthlyToClose(house.targetPaise - house.projectedPaise!, months, realRates('central').debtBps));
  });
});

describe('goal tracker: emergency and education', () => {
  beforeEach(() => fixture());

  it.each([
    ['2026-10-21T06:00:00Z', 3n],
    ['2026-11-15T06:00:00Z', 2n],
    ['2026-12-31T17:00:00Z', 1n], // 22:30 IST on Dec 31: still December
    ['2027-03-01T06:00:00Z', 1n], // target month already past
  ])('emergency at %s divides the gap over %s months, rounded up', async (now, months) => {
    const e = card(await loadGoalTracker(db, now), 'EMERGENCY');
    const gap = BUCKETS.B3.targetPaise! - B3_FLOW;
    expect(e.balancePaise).toBe(B3_FLOW);
    expect(e.shortMonthlyPaise).toBe(((gap + months * 100n - 1n) / (months * 100n)) * 100n);
  });

  it('education is NOT_STARTED in 2026, with the 2028→2046 level monthly at the equity rate', async () => {
    const ed = card(await loadGoalTracker(db, NOW), 'EDUCATION');
    expect(ed.verdict).toBe('NOT_STARTED');
    expect(ed.balancePaise).toBe(0n); // absent B4 flows = known ₹0
    expect(ed.shortMonthlyPaise).toBe(
      levelMonthlyToClose(BUCKETS.B4.targetPaise!, (2046 - 2028) * 12, realRates('central').equityBps));
  });

  it('every card carries a target label and assumptions', async () => {
    const t = await loadGoalTracker(db, NOW);
    expect(t.cards.map((c) => c.id)).toEqual(['FI', 'HOUSE', 'EMERGENCY', 'EDUCATION']);
    for (const c of t.cards) {
      expect(c.targetLabel).not.toBe('');
      expect(c.assumptions.length).toBeGreaterThan(0);
    }
    expect(t.monthlyBudgetPaise).toBe(50_00_000n);
    expect(potsTotal(t.fiPots!)).toBe(card(t, 'FI').balancePaise);
  });

  it('the goal set-aside never feeds FI: FI projects as if the budget were smaller by it', async () => {
    const setRail = (k: string, v: number) => db.query(`insert into settings_rails (key, value) values ($1, $2::jsonb)
      on conflict (key) do update set value = excluded.value`, [k, JSON.stringify(v)]);
    await setRail('monthly_budget_paise', 40_00_000);
    const smaller = card(await loadGoalTracker(db, NOW), 'FI');
    await setRail('monthly_budget_paise', 50_00_000);
    await setRail('goal_setaside_monthly_paise', 10_00_000);
    const t = await loadGoalTracker(db, NOW);
    expect(t.goalSetAsidePaise).toBe(10_00_000n);
    expect(card(t, 'FI').projectedPaise).toBe(smaller.projectedPaise);
    expect(card(t, 'FI').finishYear).toEqual(smaller.finishYear);
  });
});
