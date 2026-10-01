import { getHoldings } from '../../lib/data';
import type { Paise } from '../../../src/money/paise.js';
import { Badge, ClassChip, DataTable, Money, Notice, PageHead, Stat } from '../../lib/ui';

export const dynamic = 'force-dynamic';

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
      <div className="bento">
        <div className="span-3"><Stat label="Total value" value={<Money p={rows.reduce((t, r) => t + r.valuePaise, 0n) as Paise} />} accent="violet" /></div>
        <div className="span-3"><Stat label="Positions" value={rows.length} sub={`${new Set(rows.map((r) => r.account)).size} accounts`} accent="sky" /></div>
        <div className="span-3"><Stat label="Cost basis unknown" value={rows.filter((r) => r.avgCostPaise === null).length} sub="shown as unknown, never ₹0" accent="amber" /></div>
        <div className="span-3"><Stat label="Blocked by stale data" value={rows.filter((r) => r.blocked).length} accent={rows.some((r) => r.blocked) ? 'red' : 'green'} /></div>
      </div>
      {rows.length === 0
        ? <Notice>No positions loaded.</Notice>
        : (
          <div className="card" style={{ padding: '0.3rem 0' }}>
            <DataTable
              rows={rows}
              rowTone={(r) => (r.blocked ? 'red' : undefined)}
              cols={[
                { label: 'Name', value: (r) => <><div>{r.name}</div><div className="mono muted">{r.instrumentId}</div></> },
                { label: 'Account', value: (r) => r.account },
                { label: 'Kind', value: (r) => r.kind },
                { label: 'Class', value: (r) => <ClassChip assetClass={r.assetClass} /> },
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