import { db } from '@/lib/data';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const deferUntil = body.deferUntil;
  
  if (!deferUntil) {
    return NextResponse.json({ error: 'deferUntil is required (ISO date)' }, { status: 400 });
  }
  
  const d = await db();
  
  const [intent] = await d.query<{
    id: string; status: string; current_revision: number;
  }>(
    'select id, status, current_revision from order_intents where id = $1',
    [id],
  );
  
  if (!intent) {
    return NextResponse.json({ error: 'Order intent not found' }, { status: 404 });
  }
  
  if (!['PENDING_APPROVAL', 'ACKNOWLEDGED'].includes(intent.status)) {
    return NextResponse.json({ 
      error: `Cannot defer from status: ${intent.status}` 
    }, { status: 400 });
  }
  
  const newStatus = 'DEFERRED';
  
  await d.query(
    `update order_intents set status = $1, defer_until = $2, updated_at = now() where id = $3`,
    [newStatus, deferUntil, id],
  );
  
  await d.query(
    `insert into order_transitions (order_intent_id, revision_number, from_status, to_status, actor, at, payload_snapshot, expected_revision)
     values ($1, $2, $3, $4, 'owner', now(), $5, $6)`,
    [id, intent.current_revision, intent.status, newStatus, JSON.stringify({ deferUntil }), intent.current_revision],
  );
  
  await d.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('order_intent', $1, 'DEFER', 'owner', $2::jsonb)`,
    [id, JSON.stringify({ deferUntil })],
  );
  
  return NextResponse.json({ success: true, newStatus, deferUntil });
}