import { downloadDailyNav } from './src/sources/amfi.js';

const { rows } = await downloadDailyNav();

// Search for ICICI Nifty 50 Index funds
const searchTerms = [
  'icici prudential nifty 50 index',
  'icici prudential nifty 50',
  'icici nifty 50',
];

for (const term of searchTerms) {
  const matches = rows.filter(r => r.schemeName.toLowerCase().includes(term.toLowerCase()));
  console.log(`\n--- ${term} ---`);
  if (matches.length > 0) {
    for (const m of matches.slice(0, 10)) {
      console.log(`  ${m.schemeCode}: ${m.schemeName} | Payout: ${m.isinDivPayout} | Reinvest: ${m.isinDivReinvestment}`);
    }
  } else {
    console.log('  NO MATCHES');
  }
}