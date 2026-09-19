import { getRails } from '../../lib/data';
import { Badge, Card, DataTable, Notice, PageHead, Pct } from '../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function RailsPage() {
  const { rails, breaches } = await getRails();

  const rows = rails.map((r) => ({
    key: r.key,
    keyText: r.key,
    value: r.value,
    description:
      r.key === 'cash.ceiling' ? 'Idle cash as a share of total portfolio — the ceiling that flags uninvested bond maturities' : '—',
  }));

  return (
    <>
      <PageHead
        title="Owner rails"
        sub="Rules you define for yourself. Deliberately reported apart from IPS breaches — the IPS you are held to at a −20% drawdown is not something you can quietly change."
      />
      <div className="card" style={{ padding: '0.3rem 0', maxWidth: 640 }}>
        <DataTable
          rows={rows}
          cols={[
            { label: 'Rail', value: (r) => <span className="mono">{r.keyText}</span> },
            { label: 'Limit', align: 'right', value: (r) => <Pct v={r.value} /> },
            { label: 'What it measures', value: (r) => <span className="dim">{r.description}</span> },
          ]}
        />
      </div>
      <div style={{ maxWidth: 640 }}>
        <Card
          title="Current state"
          aside={breaches.length === 0 ? 'within rails' : `${breaches.length} breach${breaches.length === 1 ? '' : 'es'}`}
          tone={breaches.length === 0 ? 'ok' : 'warn'}
        >
          {breaches.length === 0
            ? <Notice tone="green">All owner rails satisfied.</Notice>
            : <ul>{breaches.map((b) => <li key={b.code}>{b.detail}</li>)}</ul>}
          <p className="dim" style={{ marginBottom: 0 }}>Rails feed the daily digest, which stays the primary surface.</p>
        </Card>
      </div>
    </>
  );
}