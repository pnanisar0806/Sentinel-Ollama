import { openDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv, type Purpose } from '../config/env.js';
import {
  applyWatchlistProposals,
  proposeWatchlist,
  watchlistCandidates,
} from '../sources/llm-watchlist.js';
import { isMainModule } from '../util/main-module.js';

/**
 * `pnpm watchlist:propose [--limit N] [--as-of YYYY-MM-DD] [--dry-run]`
 *
 * Drafts a watchlist shortlist with the project's text model and records it as
 * `llm-advisor` proposals. They are proposals: the weekly report shows them as awaiting
 * sign-off, and the engine still gates every one of them on real data.
 */
export const ENV_PURPOSES: Purpose[] = [];

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const env = loadEnv(process.env, ENV_PURPOSES);
  const asOf = flag(argv, '--as-of') ?? new Date().toISOString().slice(0, 10);
  const limit = Number(flag(argv, '--limit') ?? 40);
  const dryRun = argv.includes('--dry-run');

  const db = await openDb(env.databaseUrl);
  await runMigrations(db);

  const candidates = await watchlistCandidates(db, asOf);
  if (candidates.length === 0) {
    console.log('no candidates: every known instrument is held or already watched');
    await db.close();
    process.exit(0);
  }

  const picks = await proposeWatchlist({
    apiKey: process.env.LLM_API_KEY,
    model: process.env.WATCHLIST_LLM_MODEL,
    candidates,
    limit,
  });

  if (picks.length === 0) {
    console.error(
      `no shortlist produced from ${candidates.length} candidates ` +
        `(no LLM_API_KEY, or the model returned nothing usable)`,
    );
    await db.close();
    process.exit(1);
  }

  for (const p of picks) console.log(`${p.instrumentId} — ${p.reason}`);
  if (dryRun) {
    console.log(`\n${picks.length} proposals (dry run — nothing written)`);
  } else {
    const written = await applyWatchlistProposals(db, picks, asOf);
    console.log(`\n${written} proposals recorded as 'llm-advisor', awaiting your sign-off`);
  }
  await db.close();
}
