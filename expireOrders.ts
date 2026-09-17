export async function expireOrders(db: Db, now: Date = new Date()): Promise<number> {
  const allOrders = await db.exec(
    `select id, current_revision, payload_snapshot, expires_at
     from order_intents
     where expires_at is not null`,
  ) as unknown as Record<string, unknown>[];
  
  let expiredCount = 0;
  
  for (const order of allOrders) {
    const expiresAt = order.expires_at ? new Date(order.expires_at as string) : null;
    if (!expiresAt || expiresAt > now) continue;
    
    const transitions = await db.exec(
      `select to_status from order_transitions where order_intent_id = '${order.id}' order by at desc limit 1`,
    ) as unknown as Record<string, unknown>[];
    
    if (!transitions || transitions.length === 0) continue;
    const status = transitions[0].to_status as string;
    if (!['PENDING_APPROVAL','MODIFIED','DEFERRED','APPROVED','ACKNOWLEDGED','AWAITING_SESSION'].includes(status)) continue;
    
    // Use exec with string interpolation for the insert to avoid parameter binding issues
    const idempotencyKey = `expire:${order.id}:${new Date().toISOString()}`;
    const newPayload = JSON.stringify({ ...(order.payload_snapshot as Record<string, unknown>), expireReason: 'Market session expired' }).replace(/'/g, "''");
    
    await db.exec(
      `insert into order_transitions
         (order_intent_id, revision_number, from_status, to_status, actor, payload_snapshot, expected_revision, idempotency_key)
       values ('${order.id}', ${order.current_revision}, '${status}', 'EXPIRED', 'system', '${newPayload}', ${order.current_revision}, '${`expire:${order.id}:${new Date().toISOString()}`}')`,
    );
    
    expiredCount++;
  }
  
  return expiredCount;
}