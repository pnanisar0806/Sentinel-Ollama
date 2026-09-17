import type { Db } from '../db/client.js';
import { Telegram, escapeMarkdown } from './telegram.js';
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

export interface MockLiveInputs {
  nowPriceCents: bigint;
  usdInr: number;
  asOf: string;
}

/** Handle /approve <order_id> [idempotency_key] */
export async function handleApprove(db: Db, send: (text: string) => Promise<void>, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    await send('Usage: /approve <order_id> [idempotency_key]');
    return;
  }
  const orderId = parts[1];
  const idempotencyKey = parts[2] || `approve:${parts[1]}:${Date.now()}`;
  try {
    const { approveOrder } = await import('../domain/orders.js');
    const order = await approveOrder(db as any, orderId, { idempotencyKey, actor: 'owner' });
    await send(`✅ Order ${orderId} approved. Status: ${order.status}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await send(`⚠️ ${escapeMarkdown(msg)}`);
  }
}

/** Handle /modify <order_id> [quantity] [limit_price] [order_type] [defer_until] [alternate_id] [idempotency_key] */
export async function handleModify(db: Db, send: (text: string) => Promise<void>, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    await send('Usage: /modify <order_id> [quantity] [limit_price] [order_type] [defer_until] [alternate_id] [idempotency_key]');
    return;
  }
  const orderId = parts[1];
  const idempotencyKey = parts[parts.length - 1].startsWith('idem:') ? parts.pop()! : `mod:${parts[1]}:${Date.now()}`;
  
  const input = {
    idempotencyKey,
    actor: 'owner' as const,
    quantity: parts[2] && parts[2] !== parts[parts.length - 1] ? parts[2] : undefined,
    limitPricePaise: parts[3] && parts[3] !== parts[parts.length - 1] ? parts[3] : undefined,
    orderType: parts[4] && parts[4] !== parts[parts.length - 1] ? parts[4] as 'MARKET' | 'LIMIT' : undefined,
    deferUntil: parts[5] && parts[5] !== parts[parts.length - 1] ? parts[5] : undefined,
    alternateInstrumentId: parts[6] && parts[6] !== parts[parts.length - 1] ? parts[6] : undefined,
  };
  
  try {
    const { modifyOrder } = await import('../domain/orders.js');
    const order = await modifyOrder(db as any, orderId, input);
    await send(`✏️ Order ${orderId} modified. Status: ${order.status}, Revision: ${order.currentRevision}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await send(`⚠️ ${escapeMarkdown(msg)}`);
  }
}

/** Handle /defer <order_id> <YYYY-MM-DD> [idempotency_key] */
export async function handleDefer(db: Db, send: (text: string) => Promise<void>, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) {
    await send('Usage: /defer <order_id> <YYYY-MM-DD> [idempotency_key]');
    return;
  }
  const orderId = parts[1];
  const deferUntil = parts[2];
  const idempotencyKey = parts[3] || `defer:${parts[1]}:${Date.now()}`;
  try {
    const { deferOrder } = await import('../domain/orders.js');
    const order = await deferOrder(db as any, orderId, { idempotencyKey: parts[3] || `defer:${parts[1]}:${Date.now()}`, actor: 'owner', deferUntil });
    await send(`⏸️ Order ${parts[1]} deferred until ${deferUntil}. Status: ${order.status}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await send(`⚠️ ${escapeMarkdown(msg)}`);
  }
}

/** Handle /reject <order_id> <reason> [idempotency_key] */
export async function handleRejectOrder(db: Db, send: (text: string) => Promise<void>, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 3) {
    await send('Usage: /reject <order_id> <reason> [idempotency_key]');
    return;
  }
  const orderId = parts[1];
  const idempotencyKey = parts[parts.length - 1].startsWith('idem:') ? parts.pop()! : `rej:${parts[1]}:${Date.now()}`;
  const reason = parts.slice(2, parts.length - (parts[parts.length - 1].startsWith('idem:') ? 1 : 0)).join(' ');
  
  try {
    const { rejectOrder } = await import('../domain/orders.js');
    const order = await rejectOrder(db as any, orderId, { idempotencyKey: parts[parts.length - 1].startsWith('idem:') ? parts[parts.length - 1] : `rej:${parts[1]}:${Date.now()}`, actor: 'owner', reason });
    await send(`❌ Order ${orderId} rejected: ${escapeMarkdown(parts.slice(2, -1).join(' '))}. Status: ${order.status}`);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await send(`⚠️ ${escapeMarkdown(msg)}`);
  }
}

/** Handle /alternates <order_id> - show alternates for a pending order */
export async function handleAlternates(db: Db, send: (text: string) => Promise<void>, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) {
    await send('Usage: /alternates <order_id>');
    return;
  }
  const { getOrder } = await import('../domain/orders.js');
  const order = await getOrder(db as any, parts[1]);
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