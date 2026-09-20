import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Purpose } from '../config/env.js';
import { installIps } from '../domain/ips.js';
import { loadPositions, type Position } from '../domain/networth.js';
import { generateCleanupRecommendations, toPaperRecommendations, type CleanupRec } from '../domain/cleanup.js';
import { persistRecommendation, isPaperMode, type OverrideEvent, buildRecommendation } from '../domain/recommendations.js';
import { isMainModule } from '../util/main-module.js';
import { seedSmallcases } from '../seed/seed-smallcases.js';

/**
 * Has cleanup already run for this business date?
 *
 * `persistRecommendation` is a bare INSERT into an append-only table, so a second run on
 * one day writes duplicate advisory rows that nothing can delete. Same guard, same
 * audit_log mechanism and same reason as the weekly report's.
 */
export async function alreadyCleanedUpFor(db: Db, asOf: string): Promise<boolean> {
  const rows = await db.query<{ one: number }>(
    `select 1 as one from audit_log
      where entity = 'cleanup' and entity_id = $1 and action = 'CLEANUP_RUN' limit 1`,
    [asOf],
  );
  return rows.length > 0;
}

export async function recordCleanupRun(db: Db, asOf: string, persisted: number): Promise<void> {
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('cleanup', $1, 'CLEANUP_RUN', 'agent', $2::jsonb)`,
    [asOf, JSON.stringify({ asOf, persisted })],
  );
}

/** This job generates cleanup recommendations; it needs DATABASE_URL only. */
export const ENV_PURPOSES: Purpose[] = [];

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, []);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);
  await installIps(db);

  const now = new Date().toISOString();
  const businessDate = now.slice(0, 10);
  const createdOn = businessDate;

  if (await alreadyCleanedUpFor(db, businessDate)) {
    console.log(`cleanup already ran for ${businessDate} — nothing to do`);
    await db.close();
    process.exit(0);
  }

  // The decomposition references IND:* instruments that the live sync creates, so this
  // is a no-op until a sync has run. Idempotent; reports anything it had to skip rather
  // than leaving a smallcase silently undecomposed.
  const seeded = await seedSmallcases(db);
  if (seeded.inserted > 0) console.log(`smallcase positions recorded: ${seeded.inserted}`);
  if (seeded.skipped.length > 0) {
    console.error(`smallcase constituents skipped (instrument unknown — run sync first): ${seeded.skipped.join(', ')}`);
  }

  // Build cleanup input from current positions
  const positions = await loadPositions(db);
  const cleanupInput = {
    asOf: businessDate,
    positions: positions.map((p: Position) => ({
      instrumentId: p.instrumentId,
      name: p.name,
      account: p.account,
      valuePaise: p.valuePaise,
      sector: p.sector ?? undefined,
      issuer: p.issuer ?? undefined,
    })),
  };

  console.log(`Generating cleanup recommendations as of ${businessDate}...`);

  const cleanup = await generateCleanupRecommendations(db, cleanupInput);

  const paperRecs = toPaperRecommendations(cleanup.cleanupRecs, createdOn);

  const paperMode = await isPaperMode(db);
  console.log(`Paper mode: ${paperMode ? 'ON' : 'OFF'}`);

  const results: Array<{ rec: CleanupRec; result: Awaited<ReturnType<typeof persistRecommendation>> }> = [];

  for (let i = 0; i < paperRecs.length; i++) {
    const input = paperRecs[i];
    if (!input) continue;
    const cleanupRec = cleanup.cleanupRecs[i];
    if (!cleanupRec) continue;
    console.log(`\n  [${i + 1}/${paperRecs.length}] ${cleanupRec.instrumentId} — ${cleanupRec.recommendation}:${cleanupRec.action} — ${cleanupRec.reason}`);
    console.log(`    Thesis: ${cleanupRec.thesis.slice(0, 80)}...`);
    console.log(`    IPS: ${cleanupRec.ipsClauseRefs.join(', ')}`);
    if (cleanupRec.fyPlan) {
      console.log(`    LTCG Harvest FY ${cleanupRec.fyPlan.fiscalYear}: ${cleanupRec.fyPlan.lots.length} lots, LTCG est ${cleanupRec.fyPlan.estimatedLtcgPaise} paise, STCG est ${cleanupRec.fyPlan.estimatedStcgPaise} paise`);
      console.log(`    Budget: ${cleanupRec.fyPlan.budgetPaise} paise, Used: ${cleanupRec.fyPlan.usedPaise}, Remaining: ${cleanupRec.fyPlan.remainingPaise}`);
    }
    if (cleanupRec.unknownPrerequisites?.length) {
      console.log(`    ⚠ Unknown prerequisites: ${cleanupRec.unknownPrerequisites.join('; ')}`);
    }

    const recInput: Parameters<typeof buildRecommendation>[0] = {
      kind: input.kind,
      createdOn: input.createdOn,
      primary: input.primary,
      sameIntentAlternates: input.sameIntentAlternates ?? [],
      engineEvidence: input.engineEvidence ?? {},
      paperMode: true,
    };
    if (input.differentIntent) {
      recInput.differentIntent = input.differentIntent;
    }
    const result = await persistRecommendation(db, buildRecommendation(recInput));

    results.push({ rec: cleanupRec, result });

    if (result.suppressed) {
      console.log(`    ⚠ SUPPRESSED: ${result.reason}`);
    } else if (result.id) {
      console.log(`    ✓ Persisted as recommendation #${result.id} (paper mode)`);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Micro-orphans (<₹5k): ${cleanup.microOrphans.length}`);
  console.log(`Thesis-less consolidation: ${cleanup.thesisLess.length}`);
  console.log(`LTCG harvest plans: ${cleanup.ltcgHarvest.length}`);
  console.log(`Legacy notes (Groww RPOWER): ${cleanup.legacyNotes.length}`);
  console.log(`Smallcase subscription notes: ${cleanup.cleanupRecs.filter(r => r.reason.includes('subscription')).length}`);
  console.log(`Bond credit reviews: ${cleanup.cleanupRecs.filter(r => r.instrumentId.startsWith('BOND:')).length}`);
  console.log(`Sammaan maturity routing: ${cleanup.sammaanRouting ? 'yes' : 'no'}`);
  console.log(`Total cleanup recommendations: ${cleanup.cleanupRecs.length}`);
  console.log(`Persisted: ${results.filter(r => !r.result.suppressed && r.result.id).length}`);
  console.log(`Suppressed: ${results.filter(r => r.result.suppressed).length}`);

  await recordCleanupRun(db, businessDate, results.filter(r => !r.result.suppressed && r.result.id).length);
  await db.close();
}