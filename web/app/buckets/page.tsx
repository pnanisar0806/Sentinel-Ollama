import { getBuckets } from '../../lib/data';
import { Badge, Card, DataTable, Money, Notice, PageHead, Pct } from '../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function BucketsPage() {
  const { input, buckets, milestones } = await getBuckets();

  const milestoneRows = milestones.map((m) => ({
    key: m.id,
    id: m.id,
    name: m.name,
    spec: m.spec,
    completedOn: m.completedOn,
    daysOutstanding: m.daysOutstanding,
  }));

  return (
    <>
      <PageHead
        title="Buckets & goals"
        badge={<Badge tone="gray">as of {input.businessDate}</Badge>}
        sub="Goal buckets (B1–B4) and protection milestones (M1, M2). A bucket with no flows is 'not allocated', never ₹0."
      />
      <div className="grid">
        <Card title="Buckets">
          <ul>
            {buckets.map((b) => (
              <li key={b.id}>
                <strong>{b.name}</strong> <span className="dim">({b.id})</span> —{' '}
                {b.balancePaise === null
                  ? <span className="dim">not allocated yet (no bucket_flows)</span>
                  : <><Money p={b.balancePaise} />{b.fundedRatio === null ? ' · target not set' : <> · <Pct v={b.fundedRatio} /> funded</>}</>}
                {b.targetNote ? <span className="dim"> — {b.targetNote}</span> : null}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Milestones">
          {milestoneRows.length === 0
            ? <Notice>No protection milestones.</Notice>
            : (
              <DataTable
                rows={milestoneRows}
                cols={[
                  { label: 'Id', value: (r) => <span className="mono dim">{r.id}</span> },
                  { label: 'Milestone', value: (r) => r.name },
                  {
                    label: 'State',
                    value: (r) =>
                      r.completedOn
                        ? <Badge tone="green">done {r.completedOn.slice(0, 10)}</Badge>
                        : r.daysOutstanding === null
                          ? <Badge tone="gray">open — raised_on not recorded</Badge>
                          : <Badge tone="amber">{r.daysOutstanding}d outstanding</Badge>,
                  },
                  { label: 'Spec', value: (r) => <span className="dim">{r.spec}</span> },
                ]}
              />
            )}
        </Card>
      </div>
    </>
  );
}