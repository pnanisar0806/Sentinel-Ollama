/**
 * One-off: retire the `kite` data after the owner's decision (2026-09-07) to rely on
 * INDmoney alone. INDmoney already aggregates the Zerodha account, so the kite rows
 * were double-counting it by Rs 14,72,851.
 *
 * `snapshots` is APPEND-ONLY (trigger `snapshots_append_only`, migrations/0001 line 202),
 * so the snapshot row STAYS — it is the immutable record that a sync happened. Only its
 * holdings are removed, which is exactly what writeSnapshot does on every normal sync.
 * An empty snapshot joins to zero holdings and so contributes zero positions.
 *
 * `holdings` and `oauth_tokens` carry no such trigger; deleting there is permitted.
 *
 * A JSON dump of everything removed is at data/kite-snapshot-backup-2026-09-07.json
 * (gitignored), so this is reversible.
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
  const t = await tx.query(`delete from oauth_tokens where provider = 'kite' returning provider`);
  console.log(`deleted: holdings=${h.length} oauth_tokens=${t.length}`);
  console.log('kept: the kite snapshot row itself (append-only audit record, now empty)');
});

const pos = await loadPositions(db, '2026-09-06');
const liab = await outstandingLiabilities(db, '2026-09');
const nw = netWorth(pos, liab as Paise);
console.log(`\nafter cleanup: positions=${pos.length}  assets=${rupees(nw.assetsPaise)}  net=${rupees(nw.netPaise)}`);
console.log('remaining sources:', [...new Set(pos.map((p) => p.source))].join(', '));
console.log('\nexpect ~48 positions, assets ~₹57.1L, and NO kite in the source list.');
await db.close();
