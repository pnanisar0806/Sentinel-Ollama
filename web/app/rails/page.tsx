import { getRails } from '../../lib/data';
import { Badge, Card, DataTable, Notice, PageHead } from '../../lib/ui';
import { rupees } from '../../lib/format';

export const dynamic = 'force-dynamic';

export default async function RailsPage() {
  const { rails, breaches } = await getRails();

  // settings_rails keys carry their unit in the name: `_pct` is already a percent,
  // `_paise` is money. Rendering every rail through <Pct> printed cash_ceiling_pct = 10
  // as 1000.0%, because the legacy `cash.ceiling` it replaced held a fraction (0.2).
  const limit = (key: string, value: number): string =>
    key.endsWith('_pct') ? `${value}%`
    : key.endsWith('_paise') ? rupees(String(value))
    : String(value);

  const DESCRIPTIONS: Record<string, string> = {
    cash_ceiling_pct: 'Idle cash as a share of total assets, less the funded B3 emergency fund — PRD §3.3',
  };

  const rows = rails.map((r) => ({
    key: r.key,
    keyText: r.key,
    limitText: limit(r.key, r.value),
    description: DESCRIPTIONS[r.key] ?? '—',
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
            { label: 'Limit', align: 'right', value: (r) => <span className="tnum">{r.limitText}</span> },
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