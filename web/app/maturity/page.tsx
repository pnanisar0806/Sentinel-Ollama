import { getMaturity } from '../../lib/data';
import { Badge, Card, DataTable, Money, Notice, PageHead } from '../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function MaturityPage() {
  const { redemptions, dated, horizonDays } = await getMaturity();

  const soon = redemptions.map((r) => ({
    key: r.instrumentId,
    symbol: r.symbol,
    instrumentId: r.instrumentId,
    maturityDate: r.maturityDate,
    daysUntil: r.daysUntil,
    facePaise: r.facePaise,
    couponDuePaise: r.couponDuePaise,
  }));

  return (
    <>
      <PageHead
        title="Maturity calendar"
        badge={
          soon.length > 0
            ? <Badge tone="amber">{soon.length} within {horizonDays}d</Badge>
            : <Badge tone="gray">nothing due</Badge>
        }
        sub="Dated instruments and the cash they return. A maturity is a routing decision with a deadline: the proceeds have to land somewhere the IPS allows, and the decision is yours."
      />

      <Card
        title={`Due within ${horizonDays} days`}
        aside={soon.length === 0 ? 'none' : `${soon.length} redemption${soon.length === 1 ? '' : 's'}`}
        tone={soon.length === 0 ? undefined : 'warn'}
      >
        {soon.length === 0 ? (
          <p className="dim" style={{ margin: '0.2rem 0' }}>
            No instrument matures inside the horizon.
          </p>
        ) : (
          <DataTable
            rows={soon}
            rowTone={(r) => (r.daysUntil <= 30 ? 'amber' : undefined)}
            cols={[
              { label: 'Instrument', value: (r) => <span className="mono">{r.symbol}</span> },
              { label: 'Matures', value: (r) => r.maturityDate },
              {
                label: 'In',
                align: 'right',
                value: (r) => (r.daysUntil <= 30 ? <strong>{r.daysUntil}d</strong> : `${r.daysUntil}d`),
              },
              { label: 'Face value', align: 'right', value: (r) => <Money p={r.facePaise} /> },
              {
                label: 'Coupon due',
                align: 'right',
                value: (r) =>
                  r.couponDuePaise === null
                    ? <span className="dim">unknown</span>
                    : <Money p={r.couponDuePaise} />,
              },
            ]}
          />
        )}
      </Card>

      <Card title="All dated instruments" aside={dated.length === 0 ? 'none' : `${dated.length}`}>
        {dated.length === 0 ? (
          <Notice tone="gray">
            No instrument carries a <span className="mono">maturity_date</span>. Only bonds and
            other dated holdings do; equities and funds never appear here.
          </Notice>
        ) : (
          <DataTable
            rows={dated}
            cols={[
              { label: 'Name', value: (r) => r.name },
              { label: 'Instrument', value: (r) => <span className="mono">{r.instrumentId}</span> },
              { label: 'Matures', value: (r) => r.maturityDate },
              {
                label: 'Face value',
                align: 'right',
                value: (r) =>
                  r.facePaise === null ? <span className="dim">unknown</span> : <Money p={r.facePaise} />,
              },
              {
                label: 'Coupon',
                align: 'right',
                value: (r) =>
                  r.couponRateBps === null
                    ? <span className="dim">—</span>
                    : `${(r.couponRateBps / 100).toFixed(2)}%`,
              },
            ]}
          />
        )}
      </Card>

      <p className="dim" style={{ marginTop: '0.4rem' }}>
        Face value is the redemption amount, not what the holding is worth today and not what
        was paid for it. An unrecorded face value reads as unknown, never as ₹0.
      </p>
    </>
  );
}
