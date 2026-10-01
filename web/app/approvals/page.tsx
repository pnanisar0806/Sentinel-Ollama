import Link from 'next/link';
import { getApprovalData, type OrderIntentRow } from '../../lib/data';
import { Badge, Card, DataTable, Notice, PageHead } from '../../lib/ui';
import type { Tone } from '../../lib/ui';
import { fmtDateTime, relTime, rupees } from '../../lib/format';
import Decide from './decide';
import { STATUS } from './status';

export const dynamic = 'force-dynamic';


const ACTION_TONE: Record<string, Tone> = { BUY: 'green', TRIM: 'amber', SELL: 'red', REDEEM: 'indigo' };

function Request({ o, today }: { o: OrderIntentRow; today: string }) {
  const s = STATUS[o.status] ?? { label: o.status, tone: 'gray' as Tone };
  const soon = o.expiresAt !== null && new Date(o.expiresAt).getTime() - Date.now() < 36 * 3_600_000;
  return (
    <Card
      title={<><Badge tone={ACTION_TONE[o.intent] ?? 'gray'}>{o.intent}</Badge>{' '}{o.instrumentName}</>}
      aside={<Badge tone={s.tone}>{s.label}</Badge>}
      tone={soon && o.status === 'PENDING_APPROVAL' ? 'warn' : undefined}
    >
      <div className="bento" style={{ marginBottom: 0 }}>
        <div className="span-3"><div className="stat-label">Amount</div><div className="stat-value" style={{ fontSize: 22 }}>{rupees(o.amountPaise)}</div><div className="muted">{o.instrumentKind === 'MF' ? (o.intent === 'BUY' ? "invested at the day's NAV" : "redeemed at the day's NAV") : o.orderType === 'MARKET' ? 'market order, by amount' : 'limit order'}</div></div>
        <div className="span-3"><div className="stat-label">Instrument</div><div className="mono">{o.instrumentId}</div><div className="muted">recommendation #{o.recommendationId}</div></div>
        <div className="span-3"><div className="stat-label">Decide by</div><div>{o.expiresAt ? fmtDateTime(o.expiresAt) : '—'}</div><div className={soon ? 'tone-amber' : 'muted'}>{o.expiresAt ? relTime(o.expiresAt) : ''}</div></div>
        <div className="span-3"><div className="stat-label">Raised</div><div>{fmtDateTime(o.createdAt)}</div><div className="muted"><Link href={`/approvals/${o.id}`}>full details</Link></div></div>
      </div>
      {o.why ? <p style={{ margin: '14px 0 4px', fontWeight: 600 }}>{o.why}</p> : null}
      {o.thesis ? <p className="dim" style={{ margin: 0 }}>{o.thesis}</p> : null}
      {o.alternates.length > 0 && (
        <p className="muted" style={{ margin: '8px 0 0' }}>
          Alternatives considered: {o.alternates.join(' · ')}
        </p>
      )}
      <div style={{ marginTop: 14 }}><Decide id={o.id} status={o.status} today={today} /></div>
    </Card>
  );
}

export default async function ApprovalsPage() {
  const { pending, history } = await getApprovalData();
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

  return (
    <>
      <PageHead
        title="Approvals"
        badge={<Badge tone="amber">paper · you place every order yourself</Badge>}
        sub="Each request is one thing the advisor wants done. Approve it, place the order in your broker app, then tell Sentinel it went through. Nothing is executed for you."
      />

      {pending.length === 0
        ? <Notice tone="green">Nothing waiting for you.</Notice>
        : <div className="bento">{pending.map((o) => <div className="span-6" key={o.id}><Request o={o} today={today} /></div>)}</div>}

      <Card title="History" aside={`${history.length} decided or expired`}>
        {history.length === 0
          ? <Notice>No decisions yet.</Notice>
          : (
            <DataTable
              rows={history.slice(0, 50).map((o) => ({ key: o.id, o }))}
              cols={[
                { label: 'Action', value: ({ o }) => <Badge tone={ACTION_TONE[o.intent] ?? 'gray'}>{o.intent}</Badge> },
                { label: 'Instrument', value: ({ o }) => <Link href={`/approvals/${o.id}`}>{o.instrumentName}</Link> },
                { label: 'Amount', align: 'right', value: ({ o }) => <span className="tnum">{rupees(o.amountPaise)}</span> },
                { label: 'Outcome', value: ({ o }) => { const s = STATUS[o.status] ?? { label: o.status, tone: 'gray' as Tone }; return <Badge tone={s.tone}>{s.label}</Badge>; } },
                { label: 'Raised', value: ({ o }) => fmtDateTime(o.createdAt) },
              ]}
            />
          )}
      </Card>
    </>
  );
}
