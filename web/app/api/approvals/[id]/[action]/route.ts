import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/data';
import {
  abandonAdvisory, acknowledgeAdvisory, approveOrder, awaitManualExecution, deferOrder,
  getOrder, rejectOrder, verifyAdvisory,
} from '../../../../../../src/domain/orders';

export const dynamic = 'force-dynamic';

/**
 * The owner's decision on an approval request. Every action goes through the domain,
 * which appends an `order_transitions` row. The six routes this replaces updated
 * `order_intents` directly, which the append-only trigger refused, and the page linked
 * them with GET, so no decision could ever be recorded from the web.
 *
 * The idempotency key names the action and the state it acts on, so a double-click is
 * one decision while a request that is deferred and later resurfaces can be decided again.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; action: string }> },
): Promise<NextResponse> {
  const { id, action } = await params;
  const body = await request.json().catch(() => ({})) as { reason?: string; deferUntil?: string };
  const d = await db();
  try {
    const order = await getOrder(d, id);
    if (!order) return NextResponse.json({ error: 'no such approval request' }, { status: 404 });
    const input = { actor: 'owner' as const, idempotencyKey: `${action}:${id}:${order.currentRevision}:${order.status}` };
    let result;
    switch (action) {
      // Advisory orders (every order in Phase 2) are acknowledged, then the owner places
      // them and says so; a broker order is simply approved.
      case 'approve':
        result = order.advisoryPath ? await acknowledgeAdvisory(d, id, input) : await approveOrder(d, id, input);
        break;
      case 'placing': result = await awaitManualExecution(d, id, input); break;
      case 'done': result = await verifyAdvisory(d, id, input); break;
      case 'abandon': result = await abandonAdvisory(d, id, input); break;
      case 'reject': {
        const reason = (body.reason ?? '').trim();
        if (reason === '') throw new Error('say why you are rejecting it — it is kept with the decision');
        result = await rejectOrder(d, id, { ...input, reason });
        break;
      }
      case 'defer': {
        if (!body.deferUntil || !/^\d{4}-\d{2}-\d{2}$/.test(body.deferUntil)) throw new Error('pick a date to be reminded on');
        result = await deferOrder(d, id, { ...input, deferUntil: body.deferUntil });
        break;
      }
      default:
        return NextResponse.json({ error: `unknown action ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, status: result.status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
