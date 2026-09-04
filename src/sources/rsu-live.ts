import { cents, dollars, type Cents } from '../money/paise.js';
import { fetchUsdInr } from './fx.js';

export interface LivePrice {
  symbol: string;
  priceCents: Cents;
  asOf: string;
  source: string;
}

export interface LiveRsuInputs {
  nowPriceCents: Cents;
  usdInr: number;
  asOf: string;
}

/**
 * Fetch live ServiceNow (NOW) price from Yahoo Finance.
 * Returns price in integer cents (e.g., $185.47 → 18547 cents).
 */
export async function fetchNowPrice(): Promise<LivePrice> {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/NOW?interval=1d&range=1d';
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Sentinel/1.0)',
      'Accept': 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance NOW price fetch failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const result = data.chart?.result?.[0];
  const meta = result?.meta;
  const regularMarketPrice = meta?.regularMarketPrice;

  if (typeof regularMarketPrice !== 'number' || !isFinite(regularMarketPrice)) {
    throw new Error('Yahoo Finance returned invalid NOW price');
  }

  // Yahoo returns price in USD with decimal precision
  const priceCents = dollars(regularMarketPrice.toFixed(2));

  return {
    symbol: 'NOW',
    priceCents,
    asOf: new Date(meta.regularMarketTime * 1000).toISOString(),
    source: 'yahoo-finance',
  };
}

/**
 * Fetch both live NOW price and USD/INR for RSU projection.
 * Returns fresh inputs with timestamps for audit trail.
 */
export async function fetchLiveRsuInputs(): Promise<LiveRsuInputs> {
  const [nowPrice, fxRate] = await Promise.all([
    fetchNowPrice(),
    fetchUsdInr(),
  ]);

  const asOf = new Date().toISOString();

  return {
    nowPriceCents: nowPrice.priceCents,
    usdInr: fxRate.rate,
    asOf,
  };
}