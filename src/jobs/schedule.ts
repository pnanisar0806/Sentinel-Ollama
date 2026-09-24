import { openDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Purpose } from '../config/env.js';
import { installIps } from '../domain/ips.js';
import { expireOrders, resurfaceDeferredOrder, recordAdvisoryReminder, getPendingApprovals } from '../domain/orders.js';
import { isMainModule } from '../util/main-module.js';
import { draftAnnouncement, draftPendingOrders } from '../domain/order-drafting.js';
import { applyDueRailChanges, evaluateBreaker } from '../domain/controls.js';
import { Telegram } from '../notify/telegram.js';

/** This job processes scheduled tasks; it needs DATABASE_URL only. */
export const ENV_PURPOSES: Purpose[] = [];

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, []);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);
  await installIps(db);

  const now = new Date().toISOString();
  console.log(`Running scheduled tasks at ${now}...`);

  // 1. Expire orders past their expiry (idempotent via idempotency key)
  console.log('\n--- Expiring orders ---');
  const expiredCount = await expireOrders(db, new Date());
  console.log(`Expired ${expiredCount} order(s)`);

  // 2. Resurface deferred orders whose deferUntil has passed (idempotent via idempotency key)
  console.log('\n--- Resurfacing deferred orders ---');
  const pending = await getPendingApprovals(db);
  const deferred = pending.filter((o) => o.status === 'DEFERRED');
  let resurfacedCount = 0;
  let withdrawalCount = 0;
  
  for (const order of deferred) {
    if (order.deferUntil) {
      const deferDate = new Date(order.deferUntil);
      if (deferDate <= new Date()) {
        console.log(`  Resurfacing ${order.id} (deferred until ${order.deferUntil})...`);
        const resurfaced = await resurfaceDeferredOrder(db, order.id);
        if (resurfaced) {
          resurfacedCount++;
          if ((resurfaced.payloadSnapshot as Record<string, unknown>)?.withdrawalRecommended) {
            withdrawalCount++;
          }
        }
      }
    }
  }
  console.log(`Resurfaced ${resurfacedCount} deferred order(s), ${withdrawalCount} withdrawal(s) recommended`);

  // 3. Record T+2/T+7 advisory reminders for advisory orders in AWAITING_MANUAL_EXECUTION
  console.log('\n--- Recording advisory reminders (T+2/T+7) ---');
  const advisoryOrders = pending.filter((o) => 
    o.advisoryPath && o.status === 'AWAITING_MANUAL_EXECUTION'
  );
  let t2Count = 0;
  let t7Count = 0;
  
  for (const order of advisoryOrders) {
    // T+2 reminder: 2 days after AWAITING_MANUAL_EXECUTION transition
    // T+7 reminder: 7 days after AWAITING_MANUAL_EXECUTION transition
    // Find the transition to AWAITING_MANUAL_EXECUTION
    const [transition] = await db.query<{ at: string | Date }>(
      `select at from order_transitions 
       where order_intent_id = $1 and to_status = 'AWAITING_MANUAL_EXECUTION' 
       order by at desc limit 1`,
      [order.id],
    );
    
    if (transition) {
      const awaitingDate = transition.at instanceof Date ? transition.at : new Date(transition.at as string);
      const nowDate = new Date();
      const daysDiff = Math.floor((nowDate.getTime() - awaitingDate.getTime()) / (1000 * 60 * 60 * 24));
      
      // Check if T+2 or T+7 reminder already recorded
      const [t2] = await db.query<{ count: string }>(
        `select count(*) as count from order_simulations 
         where order_intent_id = $1 and sim_type = 'T2_REMINDER'`,
        [order.id],
      );
      const [t7] = await db.query<{ count: string }>(
        `select count(*) as count from order_simulations 
         where order_intent_id = $1 and sim_type = 'T7_REMINDER'`,
        [order.id],
      );
      
      const t2Sent = Number(t2?.count ?? '0') > 0;
      const t7Sent = Number(t7?.count ?? '0') > 0;
      
      if (!t2Sent && daysDiff >= 2) {
        await recordAdvisoryReminder(db, order.id, 'T2_REMINDER');
        console.log(`  T2_REMINDER recorded for ${order.id} (${daysDiff} days since awaiting)`);
        t2Count++;
      }
      
      if (!t7Sent && daysDiff >= 7) {
        await recordAdvisoryReminder(db, order.id, 'T7_REMINDER');
        console.log(`  T7_REMINDER recorded for ${order.id} (${daysDiff} days since awaiting)`);
        t7Count++;
      }
    }
  }
  console.log(`T+2 reminders: ${t2Count}, T+7 reminders: ${t7Count}`);

  // 4a. FR-34: rail edits whose 48 hours are up take effect now; a loosening is checked
  //     again against today's drawdown before it does.
  const rails = await applyDueRailChanges(db, new Date());
  console.log(`Rail changes: ${rails.activated.length} activated, ${rails.refused.length} refused`);
  for (const r of rails.refused) console.log(`  refused ${r.key}: ${r.reason}`);

  // 4b. FR-33: re-derive the falsification streak BEFORE drafting, so a breaker that
  //     trips today stops today's drafts rather than tomorrow's.
  const breaker = await evaluateBreaker(db, new Date());
  console.log(`Breaker: streak ${breaker.streak}${breaker.tripped ? ' — TRIPPED, advisor is report-only' : ''}`);

  // 4c. FR-20: every actionable recommendation becomes an approval request. Nothing did
  //    this until 2026-09-24 — `createOrder` had no production caller — so the owner's
  //    approval queue was always empty and the Phase 2 DoD could not begin. Runs after
  //    expiry so a request drafted today is not expired by the same run.
  console.log('\n--- Drafting approval requests ---');
  const drafts = await draftPendingOrders(db, new Date());
  console.log(`Drafted ${drafts.drafted.length}, refused ${drafts.refused.length}, `
    + `not actionable ${drafts.notActionable.length}, duplicates ${drafts.duplicates.length}`);
  for (const r of drafts.refused) console.log(`  refused #${r.recommendationId}: ${r.reason}`);
  for (const r of drafts.notActionable) console.log(`  skipped #${r.recommendationId}: ${r.reason}`);

  const announcement = draftAnnouncement(drafts);
  const botToken = process.env['TELEGRAM_BOT_TOKEN'];
  const chatId = process.env['TELEGRAM_OWNER_CHAT_ID'];
  if (announcement !== null && botToken && chatId) {
    await new Telegram({ botToken, ownerChatId: chatId, dryRun: process.env['DRY_RUN'] === '1' })
      .send(announcement);
  } else if (announcement !== null) {
    // The requests exist either way and are visible on /approvals; only the push is lost.
    console.error('Telegram not configured: approval requests drafted but not announced');
  }

  // 5. (Future) Cleanup queue monthly refresh - run on first trading day ~10:00 IST
  // This would call generateCleanupRecommendations and persist new paper recommendations
  // Skipped for now - cleanup is a standing queue refreshed on demand via `pnpm cleanup`

  console.log('\n--- Scheduled tasks complete ---');
  await db.close();
}