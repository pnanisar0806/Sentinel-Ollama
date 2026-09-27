import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getOrderIntent, getOrderTransitions } from '../../../lib/data';
import { Badge, Card, DataTable, PageHead } from '../../../lib/ui';
import type { Tone } from '../../../lib/ui';
import { fmtDateTime, rupees } from '../../../lib/format';
import Decide from '../decide';
import { STATUS } from '../status';

export const dynamic = 'force-dynamic';

export default async function ApprovalDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const o = await getOrderIntent(id);
  if (!o) notFound();
  const transitions = await getOrderTransitions(id);
  const s = STATUS[o.status] ?? { label: o.status, tone: 'gray' as Tone };
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

  return (
    <>
      <PageHead
        title={`${o.intent} ${o.instrumentName}`}
        badge={<Badge tone={s.tone}>{s.label}</Badge>}
        sub={<><Link href="/approvals">← Approvals</Link> · <span className="mono">{o.instrumentId}</span> · {rupees(o.amountPaise)} · {o.orderType.toLowerCase()} order</>}
      />
      <div className="bento">
        <div className="span-7">
          <Card title="Why the advisor wants this">
            {o.why ? <p style={{ margin: 0, fontWeight: 600 }}>{o.why}</p> : null}
            {o.thesis ? <p className="dim">{o.thesis}</p> : <p className="dim">No thesis recorded.</p>}
            {o.alternates.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {o.alternates.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            )}
          </Card>
        </div>
        <div className="span-5">
          <Card title="Your decision" aside={o.expiresAt ? `decide by ${fmtDateTime(o.expiresAt)}` : undefined}>
            <Decide id={o.id} status={o.status} today={today} />
            {o.deferUntil ? <p className="dim">Deferred until {o.deferUntil}.</p> : null}
          </Card>
        </div>
        <div className="span-12">
          <Card title="History of this request">
            <DataTable
              rows={transitions}
              cols={[
                { label: 'When', value: (t) => fmtDateTime(t.at) },
                { label: 'From', value: (t) => (STATUS[t.fromStatus]?.label ?? t.fromStatus.toLowerCase()) },
                { label: 'To', value: (t) => (STATUS[t.toStatus]?.label ?? t.toStatus.toLowerCase()) },
                { label: 'By', value: (t) => t.actor },
              ]}
            />
          </Card>
        </div>
      </div>
    </>
  );
}
