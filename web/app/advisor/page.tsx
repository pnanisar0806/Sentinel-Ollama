import Link from 'next/link';
import { getAdvisor, getDigest, getInvestmentControls, getSips } from '../../lib/data';
import { Badge, Card, ClassChip, DataTable, Notice, PageHead } from '../../lib/ui';
import type { Tone } from '../../lib/ui';
import { rupees } from '../../lib/format';
import { humanize } from '../../lib/plain';
import { budgetRaise, disclosureLines, inr, pendingBlocks, setAsideLine } from '../../lib/goals';
import type { GoalPlan, GoalTracker } from '../../../src/domain/goal-plan.js';
import { AdviceActions, LineActions, ProposeRails } from './actions';

export const dynamic = 'force-dynamic';

const DECISION: Record<string, { tone: Tone; label: string }> = {
  BUY: { tone: 'green', label: 'Buy' }, SELL: { tone: 'red', label: 'Sell' }, HOLD: { tone: 'gray', label: 'Hold' },
  WAIT: { tone: 'amber', label: 'Wait' }, NO_ACTION: { tone: 'gray', label: 'Nothing eligible' }, UNAVAILABLE: { tone: 'red', label: 'Advisor unavailable' },
};
const POLARITY: Record<string, Tone> = { POSITIVE: 'green', NEGATIVE: 'red', NEUTRAL: 'gray', UNKNOWN: 'gray' };

const IPS_EQUITY_CEILING_PCT = 60;
const WAIT = 'waits 48 hours';

/** The goal plan (spec §5, §6, §9): it only proposes rail changes; the owner signs, the 48-hour wait applies. */
function GoalPlanCard({ tracker, plan, names, sips, equityShare, blocks }: {
  tracker: GoalTracker; plan: GoalPlan; names: Map<string, string>;
  sips: { budgetPaise: bigint; tacticalPaise: bigint; sipTotalPaise: bigint | null }; equityShare: number | null;
  blocks: ReturnType<typeof pendingBlocks>;
}) {
  const goalName = (id: string) => tracker.cards.find((c) => c.id === id)?.name ?? id;
  const current = tracker.goalSetAsidePaise;
  const raise = (extra: bigint, goal: string, setAsideExtra = 0n) =>
    budgetRaise(extra, sips.budgetPaise, sips.tacticalPaise, sips.sipTotalPaise, goal, { current, extra: setAsideExtra });
  const caveat = (r: ReturnType<typeof raise>) => {
    const setAside = r.proposals.find((p) => p.key === 'goal_setaside_monthly_paise');
    const tactical = r.proposals.find((p) => p.key === 'tactical_monthly_paise');
    return <>
      {setAside ? <p className="muted" style={{ margin: '4px 0 0' }}>Also raises the goal set-aside to {inr(BigInt(setAside.value))}, so the normal plan does not invest this money.</p> : null}
      {r.tacticalUnchecked
        ? <p className="muted" style={{ margin: '4px 0 0' }}>SIP total unknown: the tactical cap could not be checked.</p>
        : tactical ? <p className="muted" style={{ margin: '4px 0 0' }}>Also raises the tactical cap to {inr(BigInt(tactical.value))}, which would otherwise bind.</p> : null}
    </>;
  };
  const isSetAside = (goal: string) => goal === 'HOUSE' || goal === 'EMERGENCY';
  // Every route that starts now is signable; house and emergency also raise the goal set-aside.
  const now = plan.money.filter((m) => m.signable);
  const setAsideExtra = plan.proposedSetAsidePaise - current;
  const total = raise(plan.totalExtraMonthlyPaise, now.map((m) => goalName(m.goal)).join(', '), setAsideExtra);
  const disclosure = plan.risk ? disclosureLines(plan.risk) : [];
  return (
    <Card title="Goal plan" aside="proposes only · you sign">
      <p style={{ margin: 0 }}>
        {plan.totalExtraMonthlyPaise > 0n
          ? <>Against the normal plan: budget {inr(sips.budgetPaise)} → <strong className="tnum">{inr(plan.proposedBudgetPaise)}</strong> (+{inr(plan.totalExtraMonthlyPaise)}/month
            {setAsideExtra > 0n ? <>, of which {inr(setAsideExtra)} is set aside for house and emergency; the normal plan never invests it</> : null}).</>
          : plan.money.length > 0
            ? <>No budget raise this month: the routes below start later.</>
            : <>No goal needs extra money this month: the goal plan adds nothing to the normal plan.</>}
        {' '}Goal equity ceiling {plan.signedCeilingPct}%{plan.signedCeilingPct > IPS_EQUITY_CEILING_PCT ? ` (owner-signed; IPS §3.3 is ${IPS_EQUITY_CEILING_PCT}%)` : ' (IPS §3.3)'}.
      </p>
      {plan.money.map((m) => {
        const r = raise(m.extraMonthlyPaise, goalName(m.goal), isSetAside(m.goal) ? m.extraMonthlyPaise : 0n);
        return (
          <div key={m.goal} style={{ marginTop: 14 }}>
            <div className="option-label">{goalName(m.goal)} · +{inr(m.extraMonthlyPaise)}/month{m.startsOn ? ` from ${m.startsOn.slice(0, 4)}` : ''}</div>
            <DataTable
              rows={m.legs.map((l, i) => ({ key: String(i), l }))}
              cols={[
                { label: 'Class', value: ({ l }) => <ClassChip assetClass={l.assetClass} /> },
                { label: 'Where', value: ({ l }) => l.label ?? (l.instrumentId ? names.get(l.instrumentId) ?? l.instrumentId : <span className="dim">no fund chosen</span>) },
                { label: 'Per month', align: 'right', value: ({ l }) => <span className="tnum">{inr(l.paise)}</span> },
              ]}
            />
            {m.startsOn
              ? <p className="muted" style={{ margin: '4px 0 0' }}>Starts {m.startsOn}: not counted in the total, nothing to sign yet.</p>
              : <>
                {isSetAside(m.goal) ? <p className="muted" style={{ margin: '4px 0 6px' }}>{setAsideLine(m, goalName(m.goal), names)}</p> : null}
                {blocks.budget
                  ? <Notice>{blocks.budget}</Notice>
                  : <><ProposeRails label={`Raise budget by ${inr(m.extraMonthlyPaise)} for ${goalName(m.goal)} (${WAIT})`} proposals={r.proposals} />{caveat(r)}</>}
              </>}
          </div>
        );
      })}
      {now.length > 1 && blocks.budget === null ? (
        <div style={{ marginTop: 14 }}>
          <ProposeRails label={`Raise budget by total ${inr(plan.totalExtraMonthlyPaise)} (${WAIT})`} proposals={total.proposals} />
          {caveat(total)}
        </div>
      ) : null}
      {plan.risk ? (
        <div style={{ marginTop: 14 }}>
          <div className="option-label">More risk: FI only</div>
          <Notice tone="amber"><ul style={{ margin: 0, paddingLeft: 18 }}>{disclosure.map((l) => <li key={l}>{l}</li>)}</ul></Notice>
          {blocks.ceiling ? <Notice>{blocks.ceiling}</Notice> : <ProposeRails
            label={`Sign goal equity ceiling ${plan.risk.equityPct}% (the rebalance dilutes equity only above it; never triggers a sale${plan.risk.closes ? '' : '; does not fully close the gap'}) (${WAIT})`}
            proposals={[{ key: 'goal_equity_ceiling_pct', value: plan.risk.equityPct, note: disclosure.join(' ') }]}
          />}
        </div>
      ) : null}
      {plan.signedCeilingPct > IPS_EQUITY_CEILING_PCT ? (
        <div style={{ marginTop: 14 }}>
          <div className="option-label">Revoke the signed ceiling</div>
          <p className="dim" style={{ margin: '0 0 6px' }}>
            Equity is {equityShare === null ? 'unknown' : `${(equityShare * 100).toFixed(1)}%`} of the portfolio now.
            {' '}Back at 60%, new money dilutes first; if it cannot close the gap within 12 months, the normal plan may propose a trim. Every sale still needs your approval.
          </p>
          {blocks.ceiling ? <Notice>{blocks.ceiling}</Notice> : <ProposeRails label={`Revoke (back to 60%) (${WAIT})`}
            proposals={[{ key: 'goal_equity_ceiling_pct', value: IPS_EQUITY_CEILING_PCT, note: 'Revoke the goal-plan equity ceiling' }]} />}
        </div>
      ) : null}
    </Card>
  );
}

export default async function AdvisorPage() {
  const { advice, revision, commentary, news, calibration, names, goalPlan, goalPlanReason } = await getAdvisor();
  const sips = await getSips();
  const blocks = pendingBlocks((await getInvestmentControls()).pending);
  const equityShare = (await getDigest()).drift.find((d) => d.assetClass === 'EQUITY')?.actual ?? null;
  const latest = advice[0] ?? null;
  const older = advice.slice(1);
  const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

  return (
    <>
      <PageHead
        title="Advisor"
        badge={<Badge tone="indigo">monthly · you sign, then approve</Badge>}
        sub="Once a month the advisor reads each candidate's news, trend and scores and decides for a five-year holder: buy, sell, hold or wait. Amounts are fixed by the system, not the model. Signing sends a buy or sell to Approvals; it is not an order."
      />

      <div className="bento">
        <div className="span-6">
          {latest === null ? (
            <Card title="This month's advice"><Notice>No advice yet. It runs in the first weekly report of each month.</Notice></Card>
          ) : (() => {
            const p = latest.payload;
            const d = DECISION[str(p['decision'])] ?? { tone: 'gray' as Tone, label: str(p['decision']) };
            const excluded = (p['excluded'] as string[] | undefined) ?? [];
            return (
              <Card
                title={<><Badge tone={d.tone}>{d.label}</Badge>{' '}{str(p['name']) || (p['decision'] === 'NO_ACTION' || p['decision'] === 'UNAVAILABLE' ? '' : 'the portfolio')}</>}
                aside={`${latest.asOf.slice(0, 10)} · ${latest.status.toLowerCase()}`}
                tone={p['decision'] === 'UNAVAILABLE' ? 'bad' : undefined}
              >
                {p['amountPaise'] ? <p style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{rupees(str(p['amountPaise']))}{p['units'] ? <span className="dim" style={{ fontSize: 14 }}> · {str(p['units'])} shares</span> : null}</p> : null}
                {p['deferredByNews'] ? <Notice tone="amber">The model said buy, but recent material negative news turned it into WAIT — the owner's rule that news may delay a buy.</Notice> : null}
                {p['reason'] ? <p className="dim">{str(p['reason'])}</p> : null}
                {p['rationale'] ? <><div className="option-label" style={{ marginTop: 12 }}>Why</div><p style={{ margin: 0 }}>{humanize(str(p['rationale']), names)}</p></> : null}
                {p['keyRisk'] ? <><div className="option-label" style={{ marginTop: 12 }}>Key risk</div><p style={{ margin: 0 }}>{str(p['keyRisk'])}</p></> : null}
                {p['falsification'] ? <><div className="option-label" style={{ marginTop: 12 }}>What would prove it wrong</div><p className="option-kill" style={{ margin: 0 }}>{str(p['falsification'])}</p></> : null}
                {p['counterargument'] ? <><div className="option-label" style={{ marginTop: 12 }}>The best case against</div><p className="dim" style={{ margin: 0 }}>{str(p['counterargument'])}</p></> : null}
                {p['horizonYears'] ? <p className="muted">Horizon: {str(p['horizonYears'])} years.</p> : null}
                {excluded.length > 0 && (
                  <details style={{ marginTop: 10 }}><summary className="muted">{excluded.length} candidate(s) not considered, and why</summary>
                    <ul className="muted" style={{ paddingLeft: 18 }}>{excluded.map((e) => <li key={e}>{e}</li>)}</ul>
                  </details>
                )}
                {latest.status === 'OPEN' && p['decision'] !== 'NO_ACTION' && p['decision'] !== 'UNAVAILABLE'
                  ? <div style={{ marginTop: 14 }}><AdviceActions id={latest.id} decision={str(p['decision'])} /></div>
                  : latest.note ? <p className="muted">{latest.status.toLowerCase()}: {latest.note}</p> : null}
              </Card>
            );
          })()}
        </div>

        <div className="span-6">
          {goalPlan === null
            ? <Card title="Goal plan" tone="bad"><Notice tone="red">Goal plan unavailable: {goalPlanReason}</Notice></Card>
            : <GoalPlanCard tracker={goalPlan.tracker} plan={goalPlan.plan} names={names} sips={sips} equityShare={equityShare} blocks={blocks} />}
        </div>

        <div className="span-12">
          <Card title="Do nothing this month" tone="ok">
            <p style={{ margin: 0 }}>Signing neither plan is a correct answer. The budget and the equity ceiling stay as they are, and nothing is bought or sold without your approval.</p>
          </Card>
        </div>

        <div className="span-12">
          <Card title="Material company news, last 30 days" aside={`${news.length} shown · the model reads headlines only`}>
            {news.length === 0 ? <Notice>No material filings in the last 30 days for held or watched companies.</Notice> : (
              <DataTable
                rows={news.map((n) => ({ key: String(n.id), n }))}
                cols={[
                  { label: 'Date', value: ({ n }) => <span className="tnum dim">{n.on}</span> },
                  { label: 'Company', value: ({ n }) => n.name },
                  { label: 'Reading', value: ({ n }) => n.polarity === null ? <Badge tone="amber">not read yet</Badge> : <Badge tone={POLARITY[n.polarity] ?? 'gray'}>{n.polarity.toLowerCase()} · {n.materiality?.toLowerCase()}</Badge> },
                  { label: 'What it says', value: ({ n }) => <>{n.summary ?? n.headline}{n.url ? <> · <a href={n.url} target="_blank" rel="noreferrer">filing</a></> : null}</> },
                ]}
              />
            )}
          </Card>
        </div>

        <div className="span-7">
          <Card title="Quarterly watchlist revision" aside={revision ? `${str(revision.payload['quarter'])} · ${revision.status.toLowerCase()}` : undefined}>
            {revision === null ? <Notice>None yet. The next one is drafted on the first weekday on or after 20 November.</Notice> : (
              <DataTable
                rows={((revision.payload['lines'] as { op: string; instrumentId: string; name: string; reason: string }[]) ?? []).map((l, i) => ({ key: String(i), l, i }))}
                cols={[
                  { label: 'Change', value: ({ l }) => <Badge tone={l.op === 'ADD' ? 'green' : 'red'}>{l.op === 'ADD' ? 'watch' : 'stop watching'}</Badge> },
                  { label: 'Company', value: ({ l }) => l.name },
                  { label: 'Why', value: ({ l }) => <span className="dim">{l.reason}</span> },
                  { label: 'Decision', value: ({ i }) => revision.decided[i] ? <Badge tone={revision.decided[i] === 'ACCEPTED' ? 'green' : 'gray'}>{revision.decided[i]!.toLowerCase()}</Badge> : <LineActions id={revision.id} line={i} /> },
                ]}
              />
            )}
          </Card>
        </div>

        <div className="span-5">
          <Card title="Track record" aside={`shown once a group has ${calibration.minimum} results`}>
            {calibration.rows.length === 0
              ? <Notice>No results yet. A recommendation is first scored 3 months after it is made.</Notice>
              : <DataTable
                rows={calibration.rows.map((r) => ({ key: `${r.origin}${r.conviction}${r.horizon}`, r }))}
                cols={[
                  { label: 'From', value: ({ r }) => r.origin },
                  { label: 'Confidence', value: ({ r }) => r.conviction.toLowerCase() },
                  { label: 'After', value: ({ r }) => `${r.horizon} months` },
                  { label: 'Scored', align: 'right', value: ({ r }) => r.evaluated },
                  { label: 'Beat the index', align: 'right', value: ({ r }) => r.hitRate === null ? <span className="dim">withheld</span> : `${Math.round(r.hitRate * 100)}%` },
                ]}
              />}
          </Card>
        </div>

        <div className="span-12">
          <Card title="Weekly commentary" aside={commentary ? commentary.asOf.slice(0, 10) : undefined}>
            {commentary === null
              ? <Notice>No validated commentary yet. Every number in it must match the data, or the section is dropped.</Notice>
              : ((commentary.payload['sections'] as { title: string; text: string }[]) ?? []).map((s) => (
                <div key={s.title} style={{ marginBottom: 12 }}><strong>{s.title}</strong><p className="dim" style={{ margin: '4px 0 0' }}>{s.text}</p></div>
              ))}
          </Card>
        </div>

        {older.length > 0 && (
          <div className="span-12">
            <Card title="Earlier advice">
              <DataTable
                rows={older.map((p) => ({ key: String(p.id), p }))}
                cols={[
                  { label: 'Date', value: ({ p }) => p.asOf.slice(0, 10) },
                  { label: 'Decision', value: ({ p }) => { const d = DECISION[str(p.payload['decision'])]; return <Badge tone={d?.tone ?? 'gray'}>{d?.label ?? str(p.payload['decision'])}</Badge>; } },
                  { label: 'Company', value: ({ p }) => str(p.payload['name']) || '—' },
                  { label: 'Outcome', value: ({ p }) => `${p.status.toLowerCase()}${p.note ? ` — ${p.note}` : ''}` },
                ]}
              />
            </Card>
          </div>
        )}
      </div>
      <p className="muted">Signed buys and sells appear on <Link href="/approvals">Approvals</Link>, where you approve them and record the order you placed.</p>
    </>
  );
}
