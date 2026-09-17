import { downloadDailyNav } from './src/sources/amfi.js';

const { rows } = await downloadDailyNav();

// Search for Direct plans
const matches = rows.filter(r => 
  r.schemeName.toLowerCase().includes('icici') && 
  r.schemeName.toLowerCase().includes('nifty 50') &&
  r.schemeName.toLowerCase().includes('direct')
);

console.log('Direct plans:');
for (const m of matches.slice(0, 20)) {
  console.log(`  ${m.schemeCode}: ${m.schemeName} | Payout: ${m.isinDivPayout} | Reinvest: ${m.isinDivReinvestment}`);
}