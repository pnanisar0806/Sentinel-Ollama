import { getRsu } from '../../lib/data';
import { Badge, Card, DataTable, Money, Notice, PageHead, Stat } from '../../lib/ui';

export default async function RsuPage() {
  const r = await getRsu();

  return (
    <>
      <PageHead
        title="RSU pipeline"
        badge={<Badge tone="gray">as of {r.businessDate}</Badge>}
        sub="Projected vest tranches at the live NOW price and USD/INR. Confirming a vest happens on Telegram; the web UI is read-only."
      />
      <div className="stats">
        <Stat
          label="Next vest"
          value={r.nextVestDate ? (
            <>
              {r.nextVestDate}
              {r.nextVestCount > 1 && <span className="dim"> — {r.nextVestCount} grants</span>}
            </>
          ) : '—'}
          sub={r.nextVestTotalNetPaise !== null ? (
            <>
              <Money p={r.nextVestTotalNetPaise} />
              {r.nextVestCount > 1 && <span className="dim"> total net</span>}
            </>
          ) : 'none projected'}
        />
        <Stat label="Projected future value" value={<Money p={r.projectedRemainingPaise} />} sub="next 12 tranches, net" />
        <Stat label="NOW price" value={`$${r.priceUsd.toFixed(2)}`} sub={`USD/INR ${r.usdInr.toFixed(2)}`} />
      </div>

      <div className="grid">
        <Card title="Projected tranches" aside={`${r.upcoming.length} upcoming`}>
          {r.upcoming.length === 0
            ? <Notice>No projected tranches in this window.</Notice>
            : (
              <DataTable
                rows={r.upcoming.map((v) => ({ key: `${v.grantId}:${v.vestOn}`, ...v }))}
                cols={[
                  { label: 'Vests on', value: (v) => v.vestOn },
                  { label: 'Grant', value: (v) => <span className="mono dim">{v.grantId}</span> },
                  { label: 'Units', align: 'right', value: (v) => v.units },
                  { label: 'Gross', align: 'right', value: (v) => <Money p={v.grossPaise} /> },
                  { label: 'Net', align: 'right', value: (v) => <Money p={v.netPaise} /> },
                ]}
              />
            )}
        </Card>
        <Card title="Confirmed vests" aside={`${r.confirmed.length} ACTUAL`}>
          {r.confirmed.length === 0
            ? <Notice>No confirmed (ACTUAL) vests yet.</Notice>
            : (
              <DataTable
                rows={r.confirmed.map((c) => ({ key: c.vestOn, ...c }))}
                cols={[
                  { label: 'Vested on', value: (c) => c.vestOn },
                  { label: 'Units', align: 'right', value: (c) => c.units },
                  { label: 'Net', align: 'right', value: (c) => <Money p={c.netPaise} /> },
                ]}
              />
            )}
        </Card>
      </div>
    </>
  );
}