import { downloadDailyNav } from './src/sources/amfi.js';

const { rows } = await downloadDailyNav();

// Check raw line for one of the ICICI Nifty 50 funds
const rawResponse = await fetch('https://www.amfiindia.com/spages/NAVAll.txt', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/plain, text/csv, */*',
  },
});
const text = await rawResponse.text();
const lines = text.trim().split('\n');

// Find lines for ICICI Nifty 50
for (const line of lines) {
  if (line.toLowerCase().includes('icici') && line.toLowerCase().includes('nifty 50') && line.toLowerCase().includes('index')) {
    console.log(line);
  }
}