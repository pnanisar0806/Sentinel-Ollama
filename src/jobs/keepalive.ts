import { openDb } from '../db/client.js';
import { loadEnv, type Purpose } from '../config/env.js';
import { isMainModule } from '../util/main-module.js';

/** This job reads DATABASE_URL and nothing else. */
export const ENV_PURPOSES: Purpose[] = [];

// Supabase free tier pauses idle projects; a weekly write plus the daily sync keeps it awake.
if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, ENV_PURPOSES);
  const db = await openDb(env.databaseUrl);
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('system', 'keepalive', 'PINGED', 'system', '{}'::jsonb)`,
  );
  console.log('keepalive ping written');
  await db.close();
}
