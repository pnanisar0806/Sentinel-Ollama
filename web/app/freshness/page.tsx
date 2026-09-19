import { getFreshness } from '../../lib/data';
import { Badge, Card, DataTable, Notice, PageHead } from '../../lib/ui';

export const dynamic = 'force-dynamic';

const fmtAge = (ageHours: number): string =>
  ageHours === Infinity ? 'never' : `${Math.round(ageHours * 10) / 10}h`;

export default async function FreshnessPage() {
  const { rows, blocked, businessDate } = await getFreshness();

  const tableRows = rows.map((r) => ({
    key: r.source,
    source: r.source,
    asOf: r.asOf.slice(0, 10),
    ageHours: r.ageHours,
    limitHours: r.limitHours,
    state: r.state,
  }));

  return (
    <>
      <PageHead
        title="Data freshness"
        badge={<Badge tone="gray">checked on {businessDate}</Badge>}
        sub="Every source's age against its freshness limit. 'Unimplemented' is a missing feature, not rotten data — the two must read differently."
      />
      <div className="card" style={{ padding: '0.3rem 0' }}>
        <DataTable
          rows={tableRows}
          cols={[
            { label: 'Source', value: (r) => <span className="mono">{r.source}</span> },
            { label: 'As of', value: (r) => <span className="dim">{r.asOf}</span> },
            { label: 'Age', align: 'right', value: (r) => fmtAge(r.ageHours) },
            { label: 'Limit', align: 'right', value: (r) => `${r.limitHours}h` },
            {
              label: 'State',
              value: (r) =>
                r.state === 'stale' ? <Badge tone="red">stale</Badge>
                  : r.state === 'unimplemented' ? <Badge tone="gray">unimplemented</Badge>
                    : <Badge tone="green">fresh</Badge>,
            },
          ]}
        />
      </div>
      <Card
        title="Blocked instruments — FR-31"
        aside={blocked.length === 0 ? 'nothing blocked' : `${blocked.length} blocked`}
        tone={blocked.length === 0 ? 'ok' : 'bad'}
      >
        {blocked.length === 0
          ? <Notice tone="green">Nothing is blocked: every input needed to value the holdings is fresh.</Notice>
          : <p style={{ margin: '0.2rem 0' }}><span className="mono">{blocked.join(', ')}</span></p>}
        <p className="dim" style={{ marginBottom: 0 }}>
          FR-31 gates recommendation inputs, not just display. Two inputs are checked today: the portfolio source and FX for non-INR positions. NAV and price ingestion (amfi, bhavcopy, screener) are unimplemented in Phase 0, so they do not block — that changes when their ingestion paths land.
        </p>
      </Card>
    </>
  );
}