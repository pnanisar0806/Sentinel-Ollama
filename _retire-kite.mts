/**
 * One-off: retire the `kite` snapshot after the owner's decision (2026-09-07) to
 * rely on INDmoney alone. INDmoney already aggregates the Zerodha account, so the
 * kite rows were double-counting it by Rs 14,72,851.
 *
 * A JSON dump of everything deleted here is at
 * data/kite-snapshot-backup-2026-09-07.json (gitignored) — this is reversible.
 *
 * Run once, then delete this file:  pnpm exec tsx --env-file=.env _retire-kite.mts
 */
import { openDb } from './src/db/client.js';
import { loadPositions, netWorth, outstandingLiabilities } from './src/domain/networth.js';
import type { Paise } from './src/money/paise.js';

const db = await openDb(process.env.DATABASE_URL);
const rupees = (p: bigint) => '₹' + (Number(p) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });

await db.withTransaction(async (tx) => {
  const h = await tx.query(
    `delete from holdings h using snapshots s
     where s.id = h.snapshot_id and s.source = 'kite' returning h.id`);
  const s = await tx.query(`delete from snapshots where source = 'kite' returning id`);
  const t = await tx.query(`delete from oauth_tokens where provider = 'kite' returning provider`);
  console.log(`deleted: holdings=${h.length} snapshots=${s.length} oauth_tokens=${t.length}`);
});

const pos = await loadPositions(db, '2026-09-06');
const liab = await outstandingLiabilities(db, '2026-09');
const nw = netWorth(pos, liab as Paise);
console.log(`\nafter cleanup: positions=${pos.length}  assets=${rupees(nw.assetsPaise)}  net=${rupees(nw.netPaise)}`);
console.log('remaining sources:', [...new Set(pos.map((p) => p.source))].join(', '));
console.log('\nexpect ~48 positions and assets ~₹57,12,936 (the 2026-09-05 figure, plus the day move).');
await db.close();
