import { getApprovalData } from '../../lib/data.js';
import { Badge, Card, DataTable, Notice, PageHead, Pct } from '../../lib/ui.js';
import { fmtDateTime, relTime, rupees } from '../../lib/format.js';

export const dynamic = 'force-dynamic';

export default async function ApprovalsPage() {
  const { pending, history } = await getApprovalData();

  const pendingRows = pending.map((i) => ({
    key: i.id,
    id: i.id.slice(0, 8),
    status: i.status,
    intent: i.intent,
    instrument: i.instrumentId,
    qty: i.quantity,
    limitPrice: i.limitPricePaise ? rupees(BigInt(i.limitPricePaise)) : 'MARKET',
    createdAt: fmtDateTime(i.createdAt),
    expiresAt: i.expiresAt ? fmtDateTime(i.expiresAt) : '—',
    advisory: i.advisoryPath ? '⚠' : '—',
  }));

  const historyRows = history.slice(0, 30).map((i) => ({
    key: i.id,
    id: i.id.slice(0, 8),
    status: i.status,
    intent: i.intent,
    instrument: i.instrumentId,
    qty: i.quantity,
    limitPrice: i.limitPricePaise ? rupees(BigInt(i.limitPricePaise)) : 'MARKET',
    createdAt: fmtDateTime(i.createdAt),
    expiresAt: i.expiresAt ? fmtDateTime(i.expiresAt) : '—',
  }));

  const statusBadge = (status: string) => {
    const map: Record<string, { label: string; tone: 'green' | 'amber' | 'indigo' | 'gray' | 'red' }> = {
      PENDING_APPROVAL: { label: 'PENDING', tone: 'indigo' },
      ACKNOWLEDGED: { label: 'ACKNOWLEDGED', tone: 'amber' },
      AWAITING_MANUAL_EXECUTION: { label: 'AWAITING EXEC', tone: 'amber' },
      DEFERRED: { label: 'DEFERRED', tone: 'gray' },
      APPROVED: { label: 'APPROVED', tone: 'green' },
      REJECTED: { label: 'REJECTED', tone: 'gray' },
      EXPIRED: { label: 'EXPIRED', tone: 'red' },
      FILLED: { label: 'FILLED', tone: 'green' },
      PARTIALLY_FILLED: { label: 'PARTIAL', tone: 'amber' },
      BROKER_REJECTED: { label: 'BROKER REJ', tone: 'red' },
      CANCELLED: { label: 'CANCELLED', tone: 'gray' },
      VERIFIED: { label: 'VERIFIED', tone: 'green' },
      ABANDONED: { label: 'ABANDONED', tone: 'gray' },
    };
    const m = map[status] ?? { label: status, tone: 'gray' };
    return <Badge tone={m.tone}>{m.label}</Badge>;
  };

  return (
    <>
      <PageHead
        title="Approvals"
        sub="Paper approval queue — every order intent requires your explicit decision. Advisory path (⚠) goes ACKNOWLEDGED → AWAITING_MANUAL_EXECUTION → VERIFIED/ABANDONED."
      />

      <div className="card">
        <h2 className="page-sub" style={{ marginBottom: 12 }}>Pending your decision ({pending.length})</h2>
        {pending.length === 0 ? (
          <Notice tone="green">Nothing waiting — good.</Notice>
        ) : (
          <DataTable
            rows={pendingRows}
            cols={[
              { label: '', value: (r) => <span className="mono">{r.id}</span> },
              { label: 'Status', value: (r) => statusBadge(r.status) },
              { label: 'Type', value: (r) => <span className="mono">{r.intent}</span> },
              { label: 'Instrument', value: (r) => <span className="mono">{r.instrument}</span> },
              { label: 'Qty', align: 'right', value: (r) => <span className="tnum">{r.qty}</span> },
              { label: 'Limit', align: 'right', value: (r) => <span className="tnum">{r.limitPrice}</span> },
              { label: 'Created', value: (r) => r.createdAt },
              { label: 'Expires', value: (r) => r.expiresAt },
              { label: 'Advisory', align: 'center', value: (r) => r.advisory },
            ]}
          />
        )}

        <h2 className="page-sub" style={{ marginTop: 24, marginBottom: 12 }}>History ({history.length})</h2>
        {history.length === 0 ? (
          <Notice tone="gray">No order history yet.</Notice>
        ) : (
          <DataTable
            rows={historyRows}
            cols={[
              { label: '', value: (r) => <span className="mono">{r.id}</span> },
              { label: 'Status', value: (r) => statusBadge(r.status) },
              { label: 'Type', value: (r) => <span className="mono">{r.intent}</span> },
              { label: 'Instrument', value: (r) => <span className="mono">{r.instrument}</span> },
              { label: 'Qty', align: 'right', value: (r) => <span className="tnum">{r.qty}</span> },
              { label: 'Limit', align: 'right', value: (r) => <span className="tnum">{r.limitPrice}</span> },
              { label: 'Created', value: (r) => r.createdAt },
              { label: 'Expires', value: (r) => r.expiresAt },
            ]}
          />
        )}
      </div>
    </>
  );
}