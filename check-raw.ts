import { downloadDailyNav } from './src/sources/amfi.js';

const { rows } = await downloadDailyNav();

// Check the raw parts for a specific row
const iciciRows = rows.filter(r => r.schemeName.toLowerCase().includes('icici') && r.schemeName.toLowerCase().includes('nifty 50'));

for (const row of iciciRows) {
  console.log(`SchemeCode: ${row.schemeCode}`);
  console.log(`SchemeName: ${row.schemeName}`);
  console.log(`ISIN Payout: ${row.isinDivPayout}`);
  console.log(`ISIN Reinvest: ${row.isinDivReinvestment}`);
  console.log('---');
}