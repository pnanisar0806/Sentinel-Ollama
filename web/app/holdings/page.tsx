import { getHoldings } from '../../lib/data';
import { Badge, DataTable, Money, Notice, PageHead } from '../../lib/ui';

export default async function HoldingsPage() {
  const { positions, blocked, businessDate } = await getHoldings();

  const rows = positions.map((p) => ({
    key: p.instrumentId,
    instrumentId: p.instrumentId,
    name: p.name,
    account: p.account,
    kind: p.kind,
    assetClass: p.assetClass,
    currency: p.currency,
    isEmployer: p.isEmployer,
    avgCostPaise: p.avgCostPaise,
    valuePaise: p.valuePaise,
    asOf: p.asOf.slice(0, 10),
    source: p.source,
    blocked: blocked.has(p.instrumentId),
  }));

  return (
    <>
      <PageHead
        title="Holdings"
        badge={<Badge tone="gray">as of {businessDate}</Badge>}
        sub="Every position with cost basis, value and source. Red rows are blocked by FR-31. An unknown cost basis is rendered as unknown, never as ₹0."
      />
      {rows.length === 0
        ? <Notice>No positions loaded.</Notice>
        : (
          <div className="card" style={{ padding: '0.3rem 0' }}>
            <DataTable
              rows={rows}
              rowTone={(r) => (r.blocked ? 'red' : undefined)}
              cols={[
                { label: 'Instrument', value: (r) => <span className="mono dim">{r.instrumentId}</span> },
                { label: 'Name', value: (r) => r.name },
                { label: 'Account', value: (r) => r.account },
                { label: 'Kind', value: (r) => r.kind },
                { label: 'Class', value: (r) => <Badge tone="gray">{r.assetClass}</Badge> },
                { label: 'Cur', value: (r) => r.currency },
                { label: 'Avg cost', value: (r) => (r.avgCostPaise === null ? <span className="dim">unknown</span> : <Money p={r.avgCostPaise} />) },
                { label: 'Value', align: 'right', value: (r) => <Money p={r.valuePaise} /> },
                { label: 'As of', value: (r) => <span className="dim">{r.asOf}</span> },
                { label: 'Source', value: (r) => <span className="dim">{r.source}</span> },
              ]}
            />
          </div>
        )}
    </>
  );
}