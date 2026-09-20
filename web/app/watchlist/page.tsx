import { getWatchlist } from '../../lib/data';
import { Badge, Card, DataTable, Notice, PageHead } from '../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function WatchlistPage() {
  const { active, removed } = await getWatchlist();

  return (
    <>
      <PageHead
        title="Watchlist"
        badge={<Badge tone={active.length > 0 ? 'green' : 'gray'}>{active.length} active</Badge>}
        sub="The bounded list of names Sentinel watches for signals. Append-only: a removal is recorded as a removal date, never a deleted row, so the history of what was watched and why stays readable."
      />

      <Card
        title="Currently watched"
        aside={active.length === 0 ? 'empty' : `${active.length} names`}
        tone={active.length === 0 ? 'warn' : 'ok'}
      >
        {active.length === 0 ? (
          <Notice tone="amber">
            No active watchlist rows. The table exists and the seed job is{' '}
            <span className="mono">pnpm seed</span>; until it has run, or every name has been
            removed, the signal engine has nothing to score.
          </Notice>
        ) : (
          <DataTable
            rows={active}
            cols={[
              { label: 'Name', value: (r) => r.name },
              { label: 'Instrument', value: (r) => <span className="mono">{r.instrumentId}</span> },
              { label: 'Added', value: (r) => <span className="dim">{r.addedOn}</span> },
              { label: 'Source', value: (r) => <Badge tone="indigo">{r.source}</Badge> },
              { label: 'Reason', value: (r) => r.reason },
            ]}
          />
        )}
      </Card>

      <Card title="Removed" aside={removed.length === 0 ? 'none' : `${removed.length} names`}>
        {removed.length === 0 ? (
          <p className="dim" style={{ margin: '0.2rem 0' }}>
            Nothing has been removed from the watchlist.
          </p>
        ) : (
          <DataTable
            rows={removed}
            cols={[
              { label: 'Name', value: (r) => <span className="dim">{r.name}</span> },
              { label: 'Instrument', value: (r) => <span className="mono dim">{r.instrumentId}</span> },
              { label: 'Added', value: (r) => <span className="dim">{r.addedOn}</span> },
              { label: 'Removed', value: (r) => <span className="dim">{r.removedOn}</span> },
              { label: 'Reason', value: (r) => <span className="dim">{r.reason}</span> },
            ]}
          />
        )}
      </Card>

      <p className="dim" style={{ marginTop: '0.4rem' }}>
        Read-only. Adds, removes and reprioritisation are owner decisions taken through the
        quarterly proposal flow, not from this page.
      </p>
    </>
  );
}
