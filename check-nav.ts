import { openDb } from './src/db/client.js';

async function main() {
  const db = await openDb();
  const rows = await db.query("select instrument_id, nav_date, nav_micros from navs where instrument_id in ('MF:PPFC', 'MF:ICICI-LARGECAP', 'MF:ICICI-NIFTY50-IDX', 'MF:HDFC-MIDCAP', 'MF:MOTILAL-MIDCAP', 'MF:BANDHAN-SMALLCAP') order by instrument_id, nav_date desc");
  console.log('NAV rows:', JSON.stringify(rows, null, 2));
  await db.close();
}

main().catch(e => console.error('Error:', e));