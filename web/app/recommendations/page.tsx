import Link from 'next/link';
import { getInstrumentKinds, getInstrumentNames, getRecommendations, type RecommendationRow } from '../../lib/data';
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
      <div className="options">
        <Option leg={r.primary} label="What the advisor recommends" names={names} kinds={kinds} primary />
        {alternates.map((leg, i) => <Option key={i} leg={leg} label={`Option ${i + 2}`} names={names} kinds={kinds} />)}
      </div>
      {alternates.length === 0 ? <p className="dim">No alternatives were recorded.</p> : null}
    </Card>
  );
}

export default async function RecommendationsPage() {
  const [recs, names, kinds] = await Promise.all([getRecommendations(), getInstrumentNames(), getInstrumentKinds()]);
  const live = recs.filter((r) => !r.suppressed);
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
    </>
  );
}

