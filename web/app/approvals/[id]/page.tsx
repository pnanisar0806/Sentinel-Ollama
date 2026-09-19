import { getOrderIntent, getOrderTransitions, getOrderSimulations, getApprovalData } from '../../../lib/data.js';
import { Badge, Card, DataTable, Notice, PageHead } from '../../../lib/ui.js';
import { fmtDateTime, relTime, rupees } from '../../../lib/format.js';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ApprovalDetailPage({ params }: PageProps) {
  const { id } = await params;
  const intent = await getOrderIntent(id);
  if (!intent) notFound();

  const transitions = await getOrderTransitions(id);
  const simulations = await getOrderSimulations(id);

  const statusMap: Record<string, { label: string; tone: 'green' | 'amber' | 'indigo' | 'gray' | 'red' }> = {
    PENDING_APPROVAL: { label: 'PENDING_APPROVAL', tone: 'indigo' },
    ACKNOWLEDGED: { label: 'ACKNOWLEDGED', tone: 'amber' },
    AWAITING_MANUAL_EXECUTION: { label: 'AWAITING_MANUAL_EXECUTION', tone: 'amber' },
    DEFERRED: { label: 'DEFERRED', tone: 'gray' },
    APPROVED: { label: 'APPROVED', tone: 'green' },
    REJECTED: { label: 'REJECTED', tone: 'gray' },
    EXPIRED: { label: 'EXPIRED', tone: 'red' },
    FILLED: { label: 'FILLED', tone: 'green' },
    PARTIALLY_FILLED: { label: 'PARTIALLY_FILLED', tone: 'amber' },
    BROKER_REJECTED: { label: 'BROKER_REJECTED', tone: 'red' },
    CANCELLED: { label: 'CANCELLED', tone: 'gray' },
    VERIFIED: { label: 'VERIFIED', tone: 'green' },
    ABANDONED: { label: 'ABANDONED', tone: 'gray' },
  };
  const statusInfo = statusMap[intent.status] ?? { label: intent.status, tone: 'gray' };

  const isAdvisory = intent.advisoryPath;
  const isPending = ['PENDING_APPROVAL', 'ACKNOWLEDGED', 'AWAITING_MANUAL_EXECUTION', 'DEFERRED'].includes(intent.status);

  return (
    <>
      <PageHead
        title={`Approval: ${intent.instrumentId}`}
        badge={<Badge tone={statusInfo.tone}>{statusInfo.label}</Badge>}
        sub={
          <>
            <span className="mono">{intent.id.slice(0, 8)}</span> · {' '}
            {intent.intent} · {' '}
            {intent.orderType} · {' '}
            Qty: {intent.quantity} · {' '}
            Limit: {intent.limitPricePaise ? rupees(BigInt(intent.limitPricePaise)) : 'MARKET'}
            {isAdvisory && <span> · <Badge tone="amber">Advisory</Badge></span>}
          </>
        }
      />

      <div className="grid">
        <section className="card span-2">
          <header className="card-head">
            <span className="card-title">Order intent</span>
            <span className="card-aside">{relTime(intent.createdAt)} · rev {intent.currentRevision}</span>
          </header>
          <div className="card-body" style={{ display: 'grid', gap: 8 }}>
            <div><strong>Instrument:</strong> <span className="mono">{intent.instrumentId}</span></div>
            <div><strong>Intent:</strong> {intent.intent}</div>
            <div><strong>Order type:</strong> {intent.orderType}</div>
            <div><strong>Quantity:</strong> <span className="tnum">{intent.quantity}</span></div>
            <div><strong>Limit price:</strong> {intent.limitPricePaise ? rupees(BigInt(intent.limitPricePaise)) : 'Market'}</div>
            <div><strong>Defer until:</strong> {intent.deferUntil ? fmtDateTime(intent.deferUntil) : 'Not deferred'}</div>
            <div><strong>Alternate instrument:</strong> {intent.alternateInstrumentId ?? '—'}</div>
            <div><strong>Created by:</strong> {intent.createdBy}</div>
            <div><strong>Source:</strong> {intent.source}</div>
            <div><strong>As of:</strong> {fmtDateTime(intent.asOf)}</div>
            <div><strong>Expires:</strong> {intent.expiresAt ? fmtDateTime(intent.expiresAt) : 'No expiry'}</div>
            <div><strong>Advisory path:</strong> {isAdvisory ? 'Yes (ACKNOWLEDGED → AWAITING_MANUAL_EXECUTION → VERIFIED/ABANDONED)' : 'No (standard approval)'}</div>
          </div>
        </section>

        <section className="card span-1">
          <header className="card-head">
            <span className="card-title">Current status</span>
            <span className="card-aside">{statusInfo.label}</span>
          </header>
          <div className="card-body">
            <Badge tone={statusInfo.tone}>{statusInfo.label}</Badge>
            {isPending && (
              <div style={{ marginTop: 12 }}>
                <Link href={`/api/approvals/${intent.id}/approve`} className="btn btn-primary btn-sm">
                  Approve
                </Link>{' '}
                <Link href={`/api/approvals/${intent.id}/reject`} className="btn btn-danger btn-sm">
                  Reject
                </Link>{' '}
                <Link href={`/api/approvals/${intent.id}/defer`} className="btn btn-secondary btn-sm">
                  Defer
                </Link>
                {isAdvisory && intent.status === 'ACKNOWLEDGED' && (
                  <Link href={`/api/approvals/${intent.id}/await-exec`} className="btn btn-secondary btn-sm">
                    Await execution
                  </Link>
                )}
                {isAdvisory && intent.status === 'AWAITING_MANUAL_EXECUTION' && (
                  <>
                    <Link href={`/api/approvals/${intent.id}/verify`} className="btn btn-primary btn-sm">
                      Verify
                    </Link>{' '}
                    <Link href={`/api/approvals/${intent.id}/abandon`} className="btn btn-danger btn-sm">
                      Abandon
                    </Link>
                  </>
                )}
              </div>
            )}
            {intent.deferUntil && (
              <p className="dim" style={{ marginTop: 8 }}>
                Resurfaces after {fmtDateTime(intent.deferUntil)} if still valid.
              </p>
            )}
          </div>
        </section>
      </div>

      <div className="grid" style={{ marginTop: 16 }}>
        <section className="card span-2">
          <header className="card-head">
            <span className="card-title">Immutable history</span>
            <span className="card-aside">{transitions.length} transition(s)</span>
          </header>
          <div className="card-body">
            {transitions.length === 0 ? (
              <Notice tone="gray">No transitions recorded.</Notice>
            ) : (
              <DataTable
                rows={transitions.map((t) => ({
                  key: t.id,
                  from: t.fromStatus,
                  to: t.toStatus,
                  actor: t.actor,
                  at: fmtDateTime(t.at),
                  revision: t.revisionNumber,
                  expectedRev: t.expectedRevision,
                  idempotencyKey: t.idempotencyKey ?? '—',
                }))}
                cols={[
                  { label: 'From', value: (r) => <span className="mono">{r.from}</span> },
                  { label: 'To', value: (r) => <span className="mono">{r.to}</span> },
                  { label: 'Actor', value: (r) => r.actor },
                  { label: 'At', value: (r) => r.at },
                  { label: 'Rev', align: 'center', value: (r) => r.revision },
                  { label: 'Expected rev', align: 'center', value: (r) => r.expectedRev },
                  { label: 'Idempotency', value: (r) => <span className="mono dim">{r.idempotencyKey}</span> },
                ]}
              />
            )}
          </div>
        </section>

        <section className="card span-2">
          <header className="card-head">
            <span className="card-title">Paper simulations</span>
            <span className="card-aside">{simulations.length} simulation(s)</span>
          </header>
          <div className="card-body">
            {simulations.length === 0 ? (
              <Notice tone="gray">No paper simulations recorded.</Notice>
            ) : (
              <DataTable
                rows={simulations.map((s) => ({
                  key: s.id,
                  type: s.simType,
                  at: fmtDateTime(s.simulatedAt),
                  note: s.note,
                }))}
                cols={[
                  { label: 'Type', value: (r) => <Badge tone="indigo">{r.type}</Badge> },
                  { label: 'At', value: (r) => r.at },
                  { label: 'Note', value: (r) => r.note },
                ]}
              />
            )}
          </div>
        </section>

        <section className="card span-2">
          <header className="card-head">
            <span className="card-title">Payload snapshot</span>
            <span className="card-aside">revision {intent.currentRevision}</span>
          </header>
          <div className="card-body">
            <pre className="payload-pre">{JSON.stringify(intent.payloadSnapshot, null, 2)}</pre>
          </div>
        </section>
      </div>
    </>
  );
}