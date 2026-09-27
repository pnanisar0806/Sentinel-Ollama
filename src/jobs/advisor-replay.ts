import { openDb } from '../db/client.js';
import { replayWindow } from '../advisor/replay.js';
import { isMainModule } from '../util/main-module.js';

/** `pnpm advisor:replay --from=2026-07-01 --to=2026-09-30` — a point-in-time replay, stored in replay_runs. */
if (isMainModule(import.meta.url)) {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  const to = arg('to') ?? new Date().toISOString().slice(0, 10);
  const from = arg('from') ?? `${to.slice(0, 7)}-01`;
  const db = await openDb();
  const r = await replayWindow(db, { from, to });
  console.log(`replay ${from}..${to}: ${r.coverage.points} cutoffs, ${r.coverage.newsSeen} news, ${r.coverage.scoresSeen} scores; dataset ${r.datasetHash}`);
  for (const u of r.coverage.unreconstructable) console.log(`  not reconstructable: ${u}`);
  await db.close();
}
