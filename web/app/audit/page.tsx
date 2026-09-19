import { getAudit } from '../../lib/data';
import { Badge, Card, DataTable, Notice, PageHead } from '../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  const rows = await getAudit();

  const tableRows = rows.map((r) => ({
    key: r.id,
    at: new Date(r.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    actor: r.actor,
    action: r.action,
    entity: r.entity,
    entityId: r.entityId,
    payloadText: r.payloadText.length > 120 ? `${r.payloadText.slice(0, 120)}…` : r.payloadText,
  }));

  return (
    <>
      <PageHead
        title="Audit log"
        badge={<Badge tone="gray">last {rows.length} entries</Badge>}
        sub="Append-only by construction: UPDATE, DELETE and TRUNCATE raise exceptions, and RLS reinforces it at Supabase."
      />
      {rows.length === 0
        ? <Notice>Audit log is empty — nothing has been recorded yet.</Notice>
        : (
          <div className="card" style={{ padding: '0.3rem 0' }}>
            <DataTable
              rows={tableRows}
              cols={[
                { label: 'At', value: (r) => <span className="dim">{r.at}</span> },
                {
                  label: 'Actor',
                  value: (r) =>
                    r.actor === 'owner' ? <Badge tone="green">owner</Badge>
                      : r.actor === 'agent' ? <Badge tone="indigo">agent</Badge>
                        : r.actor === 'broker' ? <Badge tone="amber">broker</Badge>
                          : <Badge tone="gray">system</Badge>,
                },
                { label: 'Action', value: (r) => <span className="mono">{r.action}</span> },
                { label: 'Entity', value: (r) => <span className="dim">{r.entity}</span> },
                { label: 'Entity id', value: (r) => <span className="mono dim">{r.entityId}</span> },
                { label: 'Payload', value: (r) => <span className="mono dim">{r.payloadText}</span> },
              ]}
            />
          </div>
        )}
    </>
  );
}