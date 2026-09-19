import { db } from '../../../../../web/lib/data.js';
import { NextRequest, NextResponse } from 'next/server';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const d = await db();
  
  const [intent] = await d.query<{
    id: string; status: string; current_revision: number; advisory_path: boolean;
  }>(
    'select id, status, current_revision, advisory_path from order_intents where id = $1',
    [id],
  );
  
  if (!intent) {
    return NextResponse.json({ error: 'Order intent not found' }, { status: 404 });
  }
  
  if (!intent.advisory_path) {
    return NextResponse.json({ error: 'Not an advisory order' }, { status: 400 });
  }
  
  if (intent.status !== 'AWAITING_MANUAL_EXECUTION') {
    return NextResponse.json({ error: `Cannot abandon from status: ${intent.status}` }, { status: 400 });
  }
  
  const newStatus = 'ABANDONED';
  
  await d.query(
    `update order_intents set status = $1, updated_at = now() where id = $2`,
    [newStatus, id],
  );
  
  await d.query(
    `insert into order_transitions (order_intent_id, revision_number, from_status, to_status, actor, at, payload_snapshot, expected_revision)
     values ($1, $2, $3, $4, 'owner', now(), $5, $6)`,
    [id, intent.current_revision, intent.status, newStatus, JSON.stringify({}), intent.current_revision],
  );
  
  await d.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('order_intent', $1, 'ABANDON', 'owner', $2::jsonb)`,
    [id, JSON.stringify({})],
  );
  
  return NextResponse.json({ success: true, newStatus });
}