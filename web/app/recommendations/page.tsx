import Link from 'next/link';
import { getInstrumentKinds, getInstrumentNames, getRecommendations, getRuleSuppressions, type RecommendationRow } from '../../lib/data';
import { Badge, Card, Notice, PageHead } from '../../lib/ui';
import type { Tone } from '../../lib/ui';
import { humanize, killCondition, kindLabel, sentence, type Names } from '../../lib/plain';
import type { RecLeg } from '../../../src/domain/recommendations.js';

export const dynamic = 'force-dynamic';

const KIND_TONE: Record<string, Tone> = {
  satellite: 'indigo', mf_switch: 'indigo', rebalance: 'amber', sell: 'red',
  prepay: 'green', maturity_routing: 'gray', legacy_note: 'gray',
};
const ACTION_TONE: Record<string, Tone> = {
  BUY: 'green', TRIM: 'amber', SELL: 'red', REDEEM: 'indigo', PREPAY: 'green', HOLD: 'gray', REDIRECT: 'indigo',
};

/** One option, in plain English: what to do, why, and what would change the advisor's mind. */
function Option({ leg, label, names, kinds, primary }: { leg: RecLeg; label: string; names: Names; kinds: Map<string, string>; primary?: boolean }) {
  const kill = killCondition(leg.falsification, names, leg.instrumentId);
  return (
    <div className={primary ? 'option option-primary' : 'option'}>
      <div className="option-label">{label}</div>
      <div className="option-what">
        <Badge tone={ACTION_TONE[leg.action] ?? 'gray'}>{leg.action === 'TRIM' ? 'SELL PART' : leg.action}</Badge>
        <strong>{sentence(leg, names, kinds)}</strong>
      </div>
      {leg.thesis ? <p className="option-why">{humanize(leg.thesis, names)}</p> : null}
      {kill ? <p className="option-kill">{kill}</p> : null}
      {leg.ipsClauseRefs.length > 0
        ? <p className="muted" style={{ margin: '6px 0 0' }}>Investment policy: <Link href="/ips">§{leg.ipsClauseRefs.join(', §')}</Link></p>
        : null}
    </div>
  );
}

/** Batch C: how many owner exceptions (`engine_evidence.waivedRules`) a stored recommendation relied on. */
function waivedRules(evidence: unknown): number {
  const w = evidence !== null && typeof evidence === 'object' ? (evidence as { waivedRules?: unknown }).waivedRules : undefined;
  return Array.isArray(w) ? w.length : 0;
}

function Rec({ r, names, kinds }: { r: RecommendationRow; names: Names; kinds: Map<string, string> }) {
  if (typeof r.primary === 'string') {
    return <Card title={`Recommendation #${r.id}`}><Notice tone="amber">This recommendation could not be read: {r.primary}</Notice></Card>;
  }
  const alternates = typeof r.alternates === 'string' ? [] : r.alternates;
  return (
    <Card
      title={<><Badge tone={KIND_TONE[r.kind] ?? 'gray'}>{kindLabel(r.kind)}</Badge>{' '}{sentence(r.primary, names, kinds)}</>}
      aside={<span className="dim">{r.createdOn} · #{r.id}</span>}
      tone={r.suppressed ? 'warn' : undefined}
    >
      {r.suppressed
        ? <Notice tone="amber"><strong>Not acted on.</strong> {r.suppressedReason ?? 'No reason was recorded.'}</Notice>
        : null}
      {r.done ? <Notice tone="green"><strong>Done.</strong> {r.done}</Notice> : null}
      {waivedRules(r.evidence) > 0
        ? <p style={{ margin: '0 0 8px' }}><Badge tone="indigo">your rule waived by you</Badge> <span className="dim">This relies on {waivedRules(r.evidence) === 1 ? 'an Allow once' : `${waivedRules(r.evidence)} Allow onces`} you gave a holding rule; the rule itself stays on.</span></p>
        : null}
      <div className="options">
        <Option leg={r.primary} label="What the advisor recommends" names={names} kinds={kinds} primary />
        {alternates.map((leg, i) => <Option key={i} leg={leg} label={`Option ${i + 2}`} names={names} kinds={kinds} />)}
      </div>
      {alternates.length === 0 ? <p className="dim">No alternatives were recorded.</p> : null}
    </Card>
  );
}

export default async function RecommendationsPage() {
  // One after another: concurrent queries over the pooled connection returned a mismatched
  // row in production (2026-10-01), so this page no longer issues them in parallel.
  const recs = await getRecommendations();
  const names = await getInstrumentNames();
  const kinds = await getInstrumentKinds();
  const ruleWithheld = await getRuleSuppressions();
  const live = recs.filter((r) => !r.suppressed && r.done === null);
  const done = recs.filter((r) => !r.suppressed && r.done !== null);
  const suppressed = recs.filter((r) => r.suppressed);

  return (
    <>
      <PageHead
        title="Recommendations"
        badge={<Badge tone={live.length > 0 ? 'green' : 'gray'}>{live.length} active</Badge>}
        sub={<>What the advisor suggests, in plain words: the recommended action first, then two alternatives. Nothing here places an order. Anything actionable also appears on <Link href="/approvals">Approvals</Link>, where you decide.</>}
      />

      {recs.length === 0
        ? <Notice>No recommendations yet. The advisor proposes once a month, in the first weekly run of the month.</Notice>
        : (
          <>
            <div className="bento">
              {live.map((r) => <div className="span-6" key={r.key}><Rec r={r} names={names} kinds={kinds} /></div>)}
            </div>
            {done.length > 0 && (
              <>
                <h2 className="section-title">Already done ({done.length})</h2>
                <div className="bento">
                  {done.map((r) => <div className="span-6" key={r.key}><Rec r={r} names={names} kinds={kinds} /></div>)}
                </div>
              </>
            )}
            {suppressed.length > 0 && (
              <>
                <h2 className="section-title">Not acted on ({suppressed.length})</h2>
                <p className="dim" style={{ marginTop: 0 }}>Kept for the record: each shows why it was set aside.</p>
                <div className="bento">
                  {suppressed.map((r) => <div className="span-6" key={r.key}><Rec r={r} names={names} kinds={kinds} /></div>)}
                </div>
              </>
            )}
          </>
        )}

      <h2 className="section-title">Withheld by your rules ({ruleWithheld.length})</h2>
      <p className="dim" style={{ marginTop: 0 }}>
        What the advisor wanted and one of your holding rules refused, last 60 days. A rule-breaking alternative withholds the whole
        recommendation; nothing is swapped in. Rules are added on <Link href="/holdings">Holdings</Link> and <Link href="/funds">Mutual funds</Link>, and ended on <Link href="/log">Log what I did</Link> → Holding rules.
      </p>
      {ruleWithheld.length === 0
        ? <Notice>Nothing withheld by a rule in the last 60 days — either no rule is on, or none refused the monthly advice. The weekly report&apos;s monthly advice is what fills this list.</Notice>
        : (
          <Card title="Refused by a rule">
            <ul className="timeline">
              {ruleWithheld.map((s) => (
                <li key={`${s.on}:${s.action}`}>
                  <span className="tnum dim">{s.on}</span>
                  <span><Badge tone="amber">withheld</Badge></span>
                  <span>{s.reason}<br /><span className="mono dim" style={{ overflowWrap: 'anywhere' }}>{s.action}</span></span>
                </li>
              ))}
            </ul>
          </Card>
        )}
    </>
  );
}

