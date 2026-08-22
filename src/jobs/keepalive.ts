import { openDb } from '../db/client.js';
import { loadEnv } from '../config/env.js';

// Supabase free tier pauses idle projects; a weekly write plus the daily sync keeps it awake.
const env = loadEnv();
const db = await openDb(env.databaseUrl);
await db.query(
  `insert into audit_log (entity, entity_id, action, actor, payload)
   values ('system', 'keepalive', 'PINGED', 'system', '{}'::jsonb)`,
);
console.log('keepalive ping written');
await db.close();