import { openDb } from './src/db/client.js';
import { loadEnv } from './src/config/env.js';

const env = loadEnv(process.env, []);
const db = await openDb(env.databaseUrl);

// Check if these exist with screener-like names
const names = [
  'BSE Ltd', 'Sanofi Consumer Healthcare India Ltd', 'Manipal Payment Solutions Pvt Ltd',
  'National Stock Exchange of India Ltd', 'Kirloskar Pneumatic Company Ltd',
  'ABB India Ltd', 'Hindustan Unilever Ltd', 'Karamtara Engineering Pvt Ltd',
  "Divi's Laboratories Ltd", 'Jindal Stainless Ltd',
  'Strides Pharma Science Ltd', 'Firstsource Solutions Ltd'
];

for (const name of names) {
  const rows = await db.query<{ id: string; name: string }>(
    `SELECT id, name FROM instruments WHERE LOWER(name) LIKE LOWER($1) LIMIT 3`,
    [`%${name.split(' ')[0]}%`],
  );
  console.log(`${name}:`, rows.length ? rows.map(r => `${r.id} (${r.name})`).join(', ') : 'NO MATCH');
}

await db.close();