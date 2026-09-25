import { getRecommendations, type RecommendationRow } from '../../lib/data';
import { Badge, Card, Money, Notice, PageHead } from '../../lib/ui';
import type { Tone } from '../../lib/ui';
import type { Paise } from '../../../src/money/paise.js';
import type { RecLeg } from '../../../src/domain/recommendations.js';

export const dynamic = 'force-dynamic';

const KIND_TONE: Record<string, Tone> = {
  satellite: 'indigo',
  mf_switch: 'indigo',
  rebalance: 'amber',
  sell: 'red',
  prepay: 'green',
  maturity_routing: 'gray',
  legacy_note: 'gray',
};

const ACTION_TONE: Record<RecLeg['action'], Tone> = {
  BUY: 'green',
  TRIM: 'amber',
  SELL: 'red',
  REDEEM: 'indigo',
  PREPAY: 'green',
  HOLD: 'gray',
  REDIRECT: 'indigo',
};

/** A row whose JSON column could not be parsed arrives as its raw string. Show it as the
 *  unreadable value it is — never render it as a React child, and never claim it empty. */
function Unparseable({ raw }: { raw: string }) {
  return <Notice tone="amber">Unparseable value stored: <span className="mono">{raw}</span></Notice>;
}

/**
 * `primary_rec` and `alternates` store RecLeg objects, not display strings. Rendering a
 * leg directly is React error #31 ("objects are not valid as a React child"), which is
 * exactly how this page first broke.
 */
function Leg({ leg, label }: { leg: RecLeg; label: string }) {
  return (
    <div style={{ borderLeft: '2px solid var(--border-strong)', paddingLeft: '0.7rem', margin: '0.6rem 0' }}>
      <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <span className="dim" style={{ fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {label}
        </span>
        <Badge tone={ACTION_TONE[leg.action] ?? 'gray'}>{leg.action}</Badge>
        {leg.instrumentId ? <span className="mono">{leg.instrumentId}</span> : <span className="dim">portfolio-level</span>}
        {leg.amountPaise != null
          ? <strong><Money p={BigInt(leg.amountPaise) as Paise} /></strong>
          : <span className="dim">amount unsized</span>}
      </div>

      <p style={{ margin: '0.35rem 0 0' }}>{leg.intent}</p>
      {leg.thesis ? <p className="dim" style={{ margin: '0.2rem 0 0' }}>{leg.thesis}</p> : null}

      {(leg.ipsClauseRefs ?? []).length > 0 ? (
        <p style={{ margin: '0.35rem 0 0' }}>
          {(leg.ipsClauseRefs ?? []).map((c) => <Badge key={c} tone="gray">{c}</Badge>)}
        </p>
      ) : (
        <p className="dim" style={{ margin: '0.35rem 0 0' }}>No clause cited — FR-10 requires at least one.</p>
      )}

      {leg.falsification ? (
        <p className="dim" style={{ margin: '0.35rem 0 0' }}>
          Kill condition: <span className="mono">{JSON.stringify(leg.falsification)}</span>
        </p>
      ) : (
        <p className="dim" style={{ margin: '0.35rem 0 0' }}>No falsification condition recorded.</p>
      )}
    </div>
  );
}

function Rec({ r }: { r: RecommendationRow }) {
  const title = typeof r.primary === 'string' ? `Recommendation #${r.id}` : r.primary.intent;

  return (
    <Card
      title={title}
      aside={<span className="mono dim">#{r.id} · {r.createdOn}</span>}
      tone={r.suppressed ? 'warn' : undefined}
    >
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.4rem' }}>
        <Badge tone={KIND_TONE[r.kind] ?? 'gray'}>{r.kind}</Badge>
        <Badge tone="gray">{r.source}</Badge>
        {r.suppressed ? <Badge tone="amber">suppressed</Badge> : null}
      </div>

      <p style={{ margin: '0.2rem 0' }}>{r.intent}</p>

      {r.suppressed ? (
        <Notice tone="amber">
          <strong>Suppressed.</strong>{' '}
          {r.suppressedReason ?? 'No reason was recorded, which is itself worth chasing.'}
        </Notice>
      ) : null}

      {typeof r.primary === 'string'
        ? <Unparseable raw={r.primary} />
        : <Leg leg={r.primary} label="Primary" />}

      {typeof r.alternates === 'string' ? (
        <Unparseable raw={r.alternates} />
      ) : r.alternates.length === 0 ? (
        <p className="dim" style={{ margin: '0.6rem 0 0' }}>
          No alternates recorded — FR-11 expects two.
        </p>
      ) : (
        r.alternates.map((leg, i) => (
          <Leg key={`${r.id}:alt:${i}`} leg={leg} label={`Alternate ${i + 1}`} />
        ))
      )}
    </Card>
  );
}

export default async function RecommendationsPage() {
  const recs = await getRecommendations();
  const live = recs.filter((r) => !r.suppressed);
  const suppressed = recs.filter((r) => r.suppressed);

  return (
    <>
      <PageHead
        title="Recommendations"
        badge={<Badge tone={live.length > 0 ? 'green' : 'gray'}>{live.length} live</Badge>}
        sub="Paper recommendations only. Nothing here places an order, and nothing executes without a fresh approval taken elsewhere — this page reads the record, it does not act on it."
      />

      {recs.length === 0 ? (
        <Notice tone="amber">
          <span className="mono">recommendations</span> is empty. The engine writes rows when the
          recommendation job runs against fresh inputs; FR-31 blocks generation while a required
          input is stale, so an empty table can mean either.
        </Notice>
      ) : (
        <>
          <div className="stack">
            {live.map((r) => <Rec key={r.key} r={r} />)}
          </div>

          {suppressed.length > 0 ? (
            <>
              <h2 className="page-sub" style={{ marginTop: '1rem' }}>
                Suppressed ({suppressed.length})
              </h2>
              <p className="dim" style={{ marginTop: 0 }}>
                FR-12 caps how many actions a month can carry. A capped action is logged, not
                discarded — it stays visible so the cap never silently hides advice.
              </p>
              <div className="stack">
                {suppressed.map((r) => <Rec key={r.key} r={r} />)}
              </div>
            </>
          ) : null}
        </>
      )}
    </>
  );
}
