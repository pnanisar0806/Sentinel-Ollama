import { concentration } from '../../../src/domain/allocation.js';
import { getAllocation } from '../../lib/data';
import { Badge, Card, DataTable, Money, Notice, PageHead, Pct } from '../../lib/ui';

export default async function AllocationPage() {
  const { input, positions } = await getAllocation();
  const c = concentration(positions);

  const rows = input.drift.map((d) => ({
    key: d.assetClass,
    assetClass: d.assetClass,
    actual: d.actual,
    min: d.min,
    max: d.max,
    breach: d.breach,
    driftPaise: d.driftPaise,
  }));

  return (
    <>
      <PageHead
        title="Allocation vs IPS"
        sub="Where each asset class sits against its IPS band, and how much money would restore it."
      />
      <div className="card" style={{ padding: '0.3rem 0' }}>
        <DataTable
          rows={rows}
          cols={[
            { label: 'Asset class', value: (r) => r.assetClass },
            { label: 'Actual', align: 'right', value: (r) => <Pct v={r.actual} /> },
            { label: 'IPS band', align: 'right', value: (r) => <span className="dim">{(r.min * 100).toFixed(0)}–{(r.max * 100).toFixed(0)}%</span> },
            {
              label: 'State',
              value: (r) =>
                r.breach === null ? <Badge tone="green">in band</Badge>
                  : r.breach === 'OVER' ? <Badge tone="amber">over</Badge>
                    : <Badge tone="red">under</Badge>,
            },
            { label: 'To restore', align: 'right', value: (r) => (r.breach === null ? <span className="dim">—</span> : <Money p={r.driftPaise} />) },
          ]}
        />
      </div>

      <div className="grid">
        <Card title="Concentration">
          <ul>
            <li>Largest single stock: <Pct v={c.topStockPct} /></li>
            <li>Employer stock: <Pct v={c.employerPct} /></li>
            <li>Sector coverage: <Pct v={c.sectorCoveragePct} /> of value carries a sector</li>
          </ul>
          {c.breaches.length === 0
            ? <Notice tone="green">No concentration breaches.</Notice>
            : <ul>{c.breaches.map((b) => <li key={b}>{b}</li>)}</ul>}
          {c.caveats.map((cav) => <Notice key={cav}>{cav}</Notice>)}
        </Card>
        <Card title="Drift breaches">
          {input.breaches.length === 0
            ? <Notice tone="green">All classes within their IPS bands.</Notice>
            : <ul>{input.breaches.map((b) => <li key={b}>{b}</li>)}</ul>}
        </Card>
      </div>
    </>
  );
}