import { openDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { currentIps, installIps, renderIps } from '../domain/ips.js';

const clause = process.argv[2];
const db = await openDb();
await runMigrations(db);
await installIps(db);
const ips = await currentIps(db);
console.log(`IPS v${ips.version} (effective ${ips.effectiveAt})\n`);
console.log(renderIps(ips.fullText, clause));
await db.close();