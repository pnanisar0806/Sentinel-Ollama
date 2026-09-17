import type { Db } from '../db/client.js';
import { escapeMarkdown } from './telegram.js';
import { formatInr } from '../money/paise.js';
import {
  getOrder,
  getPendingApprovals,
  approveOrder,
  modifyOrder,
  deferOrder,
  rejectOrder,
  getOrderHistory,
} from '../domain/orders.js';

/** Handle /approve <order_id> [idempotency_key] */
export async function handleApprove(db: Db, send: (text: string) => Promise<void>, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const orderId = parts[1];
  if (orderId === undefined) {
    await send('Usage: /approve <order_id> [idempotency_key]');
    return;
  }
  const idempotencyKey = parts[2] || `approve:${parts[1]}:${Date.now()}`;
  try {
    const order = await approveOrder(db, orderId, { idempotencyKey, actor: 'owner' });
    await send(`✅ Order ${orderId} approved. Status: ${order.status}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await send(`⚠️ ${escapeMarkdown(msg)}`);
  }
}

/** Handle /modify <order_id> [quantity] [limit_price] [order_type] [defer_until] [alternate_id] [idempotency_key] */
export async function handleModify(db: Db, send: (text: string) => Promise<void>, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const orderId = parts[1];
  if (orderId === undefined) {
    await send('Usage: /modify <order_id> [quantity] [limit_price] [order_type] [defer_until] [alternate_id] [idempotency_key]');
    return;
  }
  const lastPart = parts[parts.length - 1];
  const idempotencyKey = lastPart?.startsWith('idem:') ? lastPart : `mod:${parts[1]}:${Date.now()}`;
  if (lastPart?.startsWith('idem:')) parts.pop();
  
  const input = {
    idempotencyKey,
    actor: 'owner' as const,
    ...(parts[2] && parts[2] !== parts[parts.length - 1] ? { quantity: parts[2] } : {}),
    ...(parts[3] && parts[3] !== parts[parts.length - 1] ? { limitPricePaise: parts[3] } : {}),
    ...(parts[4] && parts[4] !== parts[parts.length - 1] ? { orderType: parts[4] as 'MARKET' | 'LIMIT' } : {}),
    ...(parts[5] && parts[5] !== parts[parts.length - 1] ? { deferUntil: parts[5] } : {}),
    ...(parts[6] && parts[6] !== parts[parts.length - 1] ? { alternateInstrumentId: parts[6] } : {}),
  };
  
  try {
    const order = await modifyOrder(db, orderId, input);
    await send(`✏️ Order ${orderId} modified. Status: ${order.status}, Revision: ${order.currentRevision}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await send(`⚠️ ${escapeMarkdown(msg)}`);
  }
}

/** Handle /defer <order_id> <YYYY-MM-DD> [idempotency_key] */
export async function handleDefer(db: Db, send: (text: string) => Promise<void>, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const orderId = parts[1];
  const deferUntil = parts[2];
  if (orderId === undefined || deferUntil === undefined) {
    await send('Usage: /defer <order_id> <YYYY-MM-DD> [idempotency_key]');
    return;
  }
  const idempotencyKey = parts[3] || `defer:${parts[1]}:${Date.now()}`;
  try {
    const order = await deferOrder(db, orderId, { idempotencyKey: parts[3] || `defer:${parts[1]}:${Date.now()}`, actor: 'owner', deferUntil });
    await send(`⏸️ Order ${parts[1]} deferred until ${deferUntil}. Status: ${order.status}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await send(`⚠️ ${escapeMarkdown(msg)}`);
  }
}

/** Handle /reject <order_id> <reason> [idempotency_key] */
export async function handleRejectOrder(db: Db, send: (text: string) => Promise<void>, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const orderId = parts[1];
  if (orderId === undefined || parts[2] === undefined) {
    await send('Usage: /reject <order_id> <reason> [idempotency_key]');
    return;
  }
  const lastPart = parts[parts.length - 1];
  const idempotencyKey = lastPart?.startsWith('idem:') ? lastPart : `rej:${parts[1]}:${Date.now()}`;
  if (lastPart?.startsWith('idem:')) parts.pop();
  const reason = parts.slice(2, parts.length - (parts[parts.length - 1]?.startsWith('idem:') ? 1 : 0)).join(' ');
  
  try {
    const order = await rejectOrder(db, orderId, { idempotencyKey, actor: 'owner', reason });
    await send(`❌ Order ${orderId} rejected: ${escapeMarkdown(parts.slice(2, -1).join(' '))}. Status: ${order.status}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await send(`⚠️ ${escapeMarkdown(msg)}`);
  }
}

/** Handle /alternates <order_id> - show alternates for a pending order */
export async function handleAlternates(db: Db, send: (text: string) => Promise<void>, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const orderId = parts[1];
  if (orderId === undefined) {
    await send('Usage: /alternates <order_id>');
    return;
  }
  const order = await getOrder(db, orderId);
  if (!order) {
    await send(`Order ${parts[1]} not found.`);
    return;
  }
  const rec = order.payloadSnapshot as { alternates?: Array<{ instrumentId: string | null; action: string; thesis: string }> };
  if (!rec.alternates || rec.alternates.length === 0) {
    await send('No alternates found for this order.');
    return;
  }
  const lines = [`*Alternates for ${parts[1]}:*`];
  rec.alternates.forEach((alt, i) => {
    lines.push(`${i + 1}. ${alt.instrumentId || 'Do nothing'} — ${alt.action}: ${alt.thesis}`);
  });
  await send(lines.join('\n'));
}

export const ORDER_COMMANDS = {
  approve: 'Approve a pending order: /approve <order_id> [idempotency_key]',
  modify: 'Modify a pending order: /modify <order_id> [quantity] [limit_price] [order_type] [defer_until] [alternate_id] [idempotency_key]',
  defer: 'Defer a pending order: /defer <order_id> <YYYY-MM-DD> [idempotency_key]',
  reject: 'Reject a pending order: /reject <order_id> <reason> [idempotency_key]',
  alternates: 'Show alternates for a pending order: /alternates <order_id>',
};