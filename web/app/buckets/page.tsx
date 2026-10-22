import { getBuckets, getGoals } from '../../lib/data';
import { Badge, Card, DataTable, Notice, PageHead, Stat } from '../../lib/ui';
import { EDUCATION_START, VERDICT, balanceText, finishBand, inr, verdictLine } from '../../lib/goals';
import type { GoalCard } from '../../../src/domain/goal-plan.js';

export const dynamic = 'force-dynamic';

const unknown = (p: bigint | null) => (p === null ? 'unknown' : inr(p));

function GoalTrackerCard({ c }: { c: GoalCard }) {
  const v = VERDICT[c.verdict];
  const ratio = c.balancePaise === null || c.targetPaise === 0n ? null
    : Math.min(1, Number((c.balancePaise * 10_000n) / c.targetPaise) / 10_000);
  return (
    <Card
      title={<>{c.name} <Badge tone={v.tone}>{v.label}</Badge></>}
      aside={c.targetLabel}
      tone={c.verdict === 'UNKNOWN' ? 'warn' : undefined}
    >
      <p style={{ margin: '0 0 10px', fontWeight: 600 }}>{verdictLine(c)}</p>
      {ratio !== null
        ? <div className="progress" aria-hidden="true"><div className={`fill ${ratio >= 1 ? 'f-green' : 'f-violet'}`} style={{ width: `${ratio * 100}%` }} /></div>
        : null}
      <div className="stat-grid">
        <Stat label="Attributed today" value={balanceText(c)} sub={ratio === null ? undefined : `${(ratio * 100).toFixed(1)}% of target`} accent="sky" />
        <Stat label="Projected at the date" value={c.verdict === 'NOT_STARTED' ? '—' : unknown(c.projectedPaise)} sub="central case, today's money" accent="violet" />
        <Stat label="₹/month short" value={c.verdict === 'NOT_STARTED' ? `${unknown(c.shortMonthlyPaise)} from ${EDUCATION_START}` : unknown(c.shortMonthlyPaise)} sub={c.id === 'HOUSE' || c.id === 'EMERGENCY' ? 'set aside; the normal plan never invests it' : 'added on top of the current budget'} accent="amber" />
        {/* The emergency fund does not grow: on track says so; short reaches it only through the set-aside. */}
        <Stat label="Finish year"
          value={c.id === 'EMERGENCY' ? (c.verdict === 'ON_TRACK' ? 'on track' : 'only with the set-aside')
            : c.verdict === 'NOT_STARTED' || c.verdict === 'UNKNOWN' ? '—' : finishBand(c.finishYear)}
          sub={c.id === 'EMERGENCY' ? 'no growth: a savings account' : 'central (pessimistic–optimistic)'} accent="teal" />
      </div>
      {c.reason ? <Notice tone="amber">{c.reason}</Notice> : null}
      <div className="option-label" style={{ marginTop: 12 }}>Balance</div>
      <ul className="dim" style={{ margin: 0, paddingLeft: 18 }}>
        {c.balanceParts.map((p) => <li key={p.label}>{p.label}: <span className="tnum">{unknown(p.paise)}</span></li>)}
      </ul>
      <div className="option-label" style={{ marginTop: 12 }}>Assumptions</div>
      <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>{c.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
    </Card>
  );
}

export default async function BucketsPage() {
  const { input, milestones } = await getBuckets();
  const { tracker, reason } = await getGoals();

  const milestoneRows = milestones.map((m) => ({
    key: m.id,
    id: m.id,
    name: m.name,
    spec: m.spec,
    completedOn: m.completedOn,
    daysOutstanding: m.daysOutstanding,
  }));

  return (
    <>
      <PageHead
        title="Goals"
        badge={<Badge tone="gray">as of {input.businessDate}</Badge>}
        sub="Am I on track? One card per goal, in today's money, at the current budget. Assumptions change only in the assumptions file. Unknown stays unknown, never ₹0."
      />
      <div className="bento">
        {tracker === null
          ? <div className="span-12"><Card title="Goal tracker" tone="bad"><Notice tone="red">Goal tracker unavailable: {reason}</Notice></Card></div>
          : tracker.cards.map((c) => <div className="span-6" key={c.id}><GoalTrackerCard c={c} /></div>)}
        <div className="span-12">
          <Card title="Milestones">
            {milestoneRows.length === 0
              ? <Notice>No protection milestones.</Notice>
              : (
                <DataTable
                  rows={milestoneRows}
                  cols={[
                    { label: 'Id', value: (r) => <span className="mono dim">{r.id}</span> },
                    { label: 'Milestone', value: (r) => r.name },
                    {
                      label: 'State',
                      value: (r) =>
                        r.completedOn
                          ? <Badge tone="green">done {r.completedOn.slice(0, 10)}</Badge>
                          : r.daysOutstanding === null
                            ? <Badge tone="gray">open — raised_on not recorded</Badge>
                            : <Badge tone="amber">{r.daysOutstanding}d outstanding</Badge>,
                    },
                    { label: 'Spec', value: (r) => <span className="dim">{r.spec}</span> },
                  ]}
                />
              )}
          </Card>
        </div>
      </div>
    </>
  );
}
