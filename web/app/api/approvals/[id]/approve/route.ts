import { db } from '@/lib/data';
import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  
  const d = await db();
  
  // Get current order intent
  const [intent] = await d.query<{
    id: string; status: string; current_revision: number; advisory_path: boolean;
  }>(
    'select id, status, current_revision, advisory_path from order_intents where id = $1',
    [id],
  );
  
  if (!intent) {
    return NextResponse.json({ error: 'Order intent not found' }, { status: 404 });
  }
  
  if (!['PENDING_APPROVAL', 'ACKNOWLEDGED'].includes(intent.status)) {
    return NextResponse.json({ 
      error: `Cannot approve from status: ${intent.status}` 
    }, { status: 400 });
  }
  
  // Check if advisory path
  const newStatus = intent.advisory_path ? 'ACKNOWLEDGED' : 'APPROVED';
  
  // Update status
  await d.query(
    `update order_intents set status = $1, updated_at = now() where id = $2`,
    [newStatus, id],
  );
  
  // Add transition
  await d.query(
    `insert into order_transitions (order_intent_id, revision_number, from_status, to_status, actor, at, payload_snapshot, expected_revision)
     values ($1, $2, $3, $4, 'owner', now(), $5, $6)`,
    [id, intent.current_revision, intent.status, newStatus, JSON.stringify({}), intent.current_revision],
  );
  
  // Audit log
  await d.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('order_intent', $1, 'APPROVE', 'owner', $2::jsonb)`,
    [id, JSON.stringify({ newStatus })],
  );
  
  return NextResponse.json({ success: true, newStatus });
}