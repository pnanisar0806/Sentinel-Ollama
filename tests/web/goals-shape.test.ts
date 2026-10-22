import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { BUCKETS } from '../../src/domain/buckets.js';
import { rupees } from '../../src/money/paise.js';
import { db, getAdvisor, getGoals } from '../../web/lib/data.js';
import { balanceText, budgetRaise, finishBand, pendingBlocks, setAsideLine, verdictLine } from '../../web/lib/goals.js';
import { BUDGET_RAIL_NAMES } from '../../src/domain/rail-values.js';
import type { GoalCard } from '../../src/domain/goal-plan.js';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * One web `db()` singleton per file. The fixture: a ServiceNow RSU whose only close is 8 days
 * old (house UNKNOWN), and an emergency fund already at target (a met goal).
 */
describe('goal getters', () => {
  beforeAll(async () => {
    const d = await db();
    await runMigrations(d);
    for (const b of Object.values(BUCKETS)) {
      await d.query(`insert into buckets (id, name, mandate, target_paise, target_note) values ($1,$2,$3,$4,$5) on conflict do nothing`,
        [b.id, b.name, b.mandate, b.targetPaise?.toString() ?? null, b.targetNote]);
    }
    const [snap] = await d.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ($1, 'manual-seed') returning id`, [day(-1)]);
    for (const [id, kind, qty, value] of [['NSE:EQ', 'EQUITY', '1', rupees(1_000_000)], ['CASH:X', 'CASH', '1', rupees(900_000)],
      ['US:NOW', 'RSU', '78', rupees(1_072_974)]] as const) {
      await d.query(`insert into instruments (id, kind, name, currency) values ($1,$2,$1,'INR') on conflict do nothing`, [id, kind]);
      await d.query(`insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
                     values ($1,$2,$3,$4,'x',now(),'manual-seed')`, [snap!.id, id, qty, value.toString()]);
    }
    await d.query(`insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of)
                   values ('US:NOW', $1, 1420627, 'yahoo', now())`, [day(-8)]);
    await d.query(`insert into bucket_flows (bucket_id, occurred_on, amount_paise, kind, as_of, source)
                   values ('B3', $1, $2, 'seed', now(), 'test')`, [day(-1), BUCKETS.B3.targetPaise!.toString()]);
  });

  it('an unknown house card has a null balance and renders "unknown", never ₹0', async () => {
    const g = await getGoals();
    expect(g.reason).toBeNull();
    const house = g.tracker!.cards.find((c) => c.id === 'HOUSE')!;
    expect(house.verdict).toBe('UNKNOWN');
    expect(house.balancePaise).toBeNull();
    expect(balanceText(house)).toBe('unknown');
    expect(house.balanceParts.find((p) => p.paise === null)?.label).toBe(`78 ServiceNow shares @ ₹14,206.27 (close ${day(-8)})`);
  });

  it('a met goal has no route button data; the plan comes with the tracker', async () => {
    const a = await getAdvisor();
    expect(a.goalPlanReason).toBeNull();
    const { tracker, plan } = a.goalPlan!;
    expect(tracker.cards.find((c) => c.id === 'EMERGENCY')!.verdict).toBe('ON_TRACK');
    expect(plan.money.map((r) => r.goal)).not.toContain('EMERGENCY');
    expect(plan.money.map((r) => r.goal)).not.toContain('HOUSE'); // unknown is not short
  });

  it('a stored ceiling outside 60–92 gives null plus the reason, never a thrown page', async () => {
    const d = await db();
    await d.query(`insert into settings_rails (key, value) values ('goal_equity_ceiling_pct', '95'::jsonb)`);
    try {
      const g = await getGoals();
      expect(g.tracker).toBeNull();
      expect(g.reason).toBe('goal_equity_ceiling_pct 95 is outside 60–92');
      const a = await getAdvisor();
      expect(a.goalPlan).toBeNull();
      expect(a.goalPlanReason).toBe(g.reason);
    } finally {
      await d.query(`delete from settings_rails where key = 'goal_equity_ceiling_pct'`);
    }
  });
});

describe('budgetRaise (ruling 2)', () => {
  const B = rupees(50_000);
  const X = rupees(20_000);
  it('raises the tactical cap to budget − SIPs only when it binds', () => {
    // SIPs ₹30k: new budget ₹70k leaves ₹40k beyond SIPs; a ₹20k tactical cap binds.
    expect(budgetRaise(X, B, rupees(20_000), rupees(30_000), 'FI').proposals).toEqual([
      { key: 'monthly_budget_paise', value: Number(B + X), note: 'Goal plan: extra money for FI' },
      { key: 'tactical_monthly_paise', value: Number(B + X - rupees(30_000)), note: 'Goal plan: extra money for FI' },
    ]);
    // A ₹40k cap does not bind: exactly budget − SIPs.
    expect(budgetRaise(X, B, rupees(40_000), rupees(30_000), 'FI').proposals.map((p) => p.key)).toEqual(['monthly_budget_paise']);
  });
  it('house/emergency: set-aside first, then the budget, both by X; the envelope is unchanged so no tactical raise', () => {
    const S = rupees(5_000);
    const r = budgetRaise(X, B, rupees(1), rupees(30_000), 'House fund', { current: S, extra: X });
    expect(r.proposals).toEqual([
      { key: 'goal_setaside_monthly_paise', value: Number(S + X), note: 'Goal plan: set aside for House fund' },
      { key: 'monthly_budget_paise', value: Number(B + X), note: 'Goal plan: extra money for House fund' },
    ]);
    expect(budgetRaise(X, B, rupees(1), null, 'House fund', { current: 0n, extra: X }).tacticalUnchecked).toBe(false);
  });
  it('a mixed total: the tactical check is against budget − SIPs − the new set-aside', () => {
    // Budget 50k + 30k (10k house, 20k FI); SIPs 30k; set-aside 0 → 10k. Free after: 80 − 30 − 10 = 40k.
    const r = budgetRaise(rupees(30_000), B, rupees(20_000), rupees(30_000), 'FI, House', { current: 0n, extra: rupees(10_000) });
    expect(r.proposals.map((p) => [p.key, p.value])).toEqual([
      ['goal_setaside_monthly_paise', Number(rupees(10_000))],
      ['monthly_budget_paise', Number(B + rupees(30_000))],
      ['tactical_monthly_paise', Number(rupees(40_000))],
    ]);
  });
  it('an unknown SIP total proposes the budget only and says the cap was not checked', () => {
    const r = budgetRaise(X, B, rupees(1), null, 'House');
    expect(r.proposals.map((p) => p.key)).toEqual(['monthly_budget_paise']);
    expect(r.tacticalUnchecked).toBe(true);
  });
});

describe('pendingBlocks (fix round 1): a pending change hides the buttons that would replace it', () => {
  const at = '2026-10-23T04:30:00.000Z'; // 10:00 IST
  it('nothing pending: every action is exposed', () => {
    expect(pendingBlocks([])).toEqual({ budget: null, ceiling: null });
  });
  it('a pending budget change blocks every raise; the ceiling stays signable', () => {
    const b = pendingBlocks([{ key: 'monthly_budget_paise', current: 5_000_000, proposed: 7_000_000, activatesAt: at }]);
    expect(b.budget).toBe('A budget change to ₹70,000 activates 2026-10-23 10:00 IST. Raise again after it activates.');
    expect(b.ceiling).toBeNull();
  });
  it('a pending goal set-aside change blocks the raise, as a budget change does', () => {
    const b = pendingBlocks([{ key: 'goal_setaside_monthly_paise', current: 0, proposed: 2_000_000, activatesAt: at }]);
    expect(b.budget).toBe('A goal set-aside change to ₹20,000 activates 2026-10-23 10:00 IST. Raise again after it activates.');
    expect(b.ceiling).toBeNull();
  });
  it('a pending tactical change alone also blocks the raise', () => {
    expect(pendingBlocks([{ key: 'tactical_monthly_paise', current: 1, proposed: 2_000_000, activatesAt: at }]).budget)
      .toBe('A tactical cap change to ₹20,000 activates 2026-10-23 10:00 IST. Raise again after it activates.');
  });
  it('every BUDGET_RAIL_NAMES key blocks the raise, named — the key set the budget editor and advisor wait share', () => {
    for (const [key, name] of Object.entries(BUDGET_RAIL_NAMES)) {
      expect(pendingBlocks([{ key, current: 0, proposed: 2_000_000, activatesAt: at }]).budget).toMatch(new RegExp(`^A ${name} change `));
    }
    expect(Object.keys(BUDGET_RAIL_NAMES)).toEqual(['monthly_budget_paise', 'tactical_monthly_paise', 'goal_setaside_monthly_paise']);
  });
  it('a pending ceiling change blocks sign and revoke; the budget stays raisable', () => {
    const b = pendingBlocks([{ key: 'goal_equity_ceiling_pct', current: 60, proposed: 68, activatesAt: at }]);
    expect(b.ceiling).toBe('Equity ceiling change to 68% activates 2026-10-23 10:00 IST.');
    expect(b.budget).toBeNull();
  });
});

describe('verdict copy (T7-1, T7-2): grammatical when unreached, never ₹0 for unknown', () => {
  const c = (o: Partial<GoalCard>): GoalCard => ({
    id: 'FI', name: 'FI corpus', targetPaise: 1n, targetLabel: '₹6L by 2026-12', balancePaise: 0n, balanceParts: [],
    projectedPaise: 0n, verdict: 'SHORT', shortMonthlyPaise: rupees(12_345),
    finishYear: { central: null, pessimistic: null, optimistic: null }, assumptions: [], reason: null, ...o,
  });
  it('a short goal not reached by 2100 says so in a sentence', () => {
    expect(verdictLine(c({}))).toBe("₹12,345/month short · not reached by 2100 at today's pace");
    expect(verdictLine(c({ finishYear: { central: 2052, pessimistic: null, optimistic: 2049 } })))
      .toBe("₹12,345/month short · reaches it in 2052 at today's pace");
  });
  it('the emergency fund (no growth) has no finish-year phrase', () => {
    expect(verdictLine(c({ id: 'EMERGENCY', shortMonthlyPaise: rupees(200_000) })))
      .toBe('₹2,00,000/month short to reach ₹6L by 2026-12');
  });
  it('an unknown shortfall renders "unknown", never ₹0', () => {
    expect(verdictLine(c({ shortMonthlyPaise: null }))).toBe("short by an unknown amount a month · not reached by 2100 at today's pace");
    expect(verdictLine(c({ verdict: 'NOT_STARTED', shortMonthlyPaise: null })))
      .toBe(`starts ${ASSUMPTIONS.childArrivalYear}; the monthly amount from then to reach ₹6L by 2026-12 is unknown`);
    for (const v of ['SHORT', 'NOT_STARTED'] as const) expect(verdictLine(c({ verdict: v, shortMonthlyPaise: null }))).not.toContain('₹0');
  });
  it('the finish band reads "after 2100" for an unreached scenario', () => {
    expect(finishBand({ central: 2052, pessimistic: null, optimistic: 2049 })).toBe('2052 (after 2100–2049)');
  });
});

describe('setAsideLine: house and emergency money is set aside and logged, never invested by the normal plan', () => {
  it('names the leg and the fund to log it to', () => {
    const names = new Map([['MF:LIQUID', 'Some liquid fund']]);
    expect(setAsideLine({ goal: 'HOUSE', extraMonthlyPaise: rupees(60_000), startsOn: null, signable: false,
      legs: [{ assetClass: 'DEBT', instrumentId: 'MF:LIQUID', paise: rupees(60_000) }] }, 'House fund', names))
      .toBe('Set aside ₹60,000/month into Some liquid fund and log it to the House fund on /log.');
    expect(setAsideLine({ goal: 'EMERGENCY', extraMonthlyPaise: rupees(200_000), startsOn: null, signable: false,
      legs: [{ assetClass: 'CASH', instrumentId: null, label: 'IDFC First savings account', paise: rupees(200_000) }] }, 'Emergency fund', names))
      .toBe('Set aside ₹2,00,000/month into IDFC First savings account and log it to the Emergency fund on /log.');
  });
});
