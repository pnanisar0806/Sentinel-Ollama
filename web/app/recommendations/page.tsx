import { getRecommendations, type RecommendationRow } from '../../lib/data';
import { Badge, Card, Notice, PageHead } from '../../lib/ui';
import type { Tone } from '../../lib/ui';

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

/** A JSON `text` column that failed to parse arrives as its raw string. Render it as
 *  the unreadable value it is rather than pretending the list was empty. */
function List({ items, empty }: { items: string[] | string; empty: string }) {
  if (typeof items === 'string') {
    return <Notice tone="amber">Unparseable value stored: <span className="mono">{items}</span></Notice>;
  }
  if (items.length === 0) return <p className="dim" style={{ margin: '0.2rem 0' }}>{empty}</p>;
  return (
    <ul style={{ margin: '0.2rem 0', paddingLeft: '1.1rem' }}>
      {items.map((it) => <li key={it}>{it}</li>)}
    </ul>
  );
}

function Rec({ r }: { r: RecommendationRow }) {
  return (
    <Card
      title={r.primary}
      aside={<span className="mono dim">#{r.id} · {r.createdOn}</span>}
      tone={r.suppressed ? 'warn' : undefined}
    >
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
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

      <h3 className="page-sub" style={{ margin: '0.7rem 0 0' }}>Alternates</h3>
      <List items={r.alternates} empty="No alternates recorded — FR-11 expects two." />

      <h3 className="page-sub" style={{ margin: '0.7rem 0 0' }}>IPS clauses cited</h3>
      <List items={r.ipsClauses} empty="No clause cited — FR-10 requires at least one." />
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
