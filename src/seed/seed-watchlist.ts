import { openDb, type Db } from '../db/client.js';

/**
 * Advisor starter watchlist (~40 names).
 * Source='advisor' for generated entries; source='owner' only for names
 * the owner has explicitly confirmed at review.
 * Excludes held instruments (per §6.1); no penny stocks.
 * Large-caps + Indian MF funds for switch opportunities.
 */
export const SEED_WATCHLIST = [
  // Indian Large-cap equities
  { instrumentId: 'NSE:RELIANCE', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Large-cap energy/conglomerate; dividend yield + refining margin recovery thesis' },
  { instrumentId: 'NSE:TCS', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'IT services bellwether; consistent FCF, dividend growth, US revenue hedge' },
  { instrumentId: 'NSE:HDFCBANK', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Best-in-class private bank; NIM stability, asset quality cycle turning' },
  { instrumentId: 'NSE:ICICIBANK', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Retail franchise strength; credit cost normalization, RoE re-rating' },
  { instrumentId: 'NSE:INFY', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'IT services #2; margin recovery + deal pipeline visibility' },
  { instrumentId: 'NSE:HINDUNILVR', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'FMCG staple; pricing power, rural recovery play' },
  { instrumentId: 'NSE:BAJFINANCE', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Consumer finance leader; AUM growth + asset quality normalization' },
  { instrumentId: 'NSE:KOTAKBANK', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Conservative underwriting; Kotak Mahindra franchise value' },
  { instrumentId: 'NSE:LT', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Capex cycle beneficiary; order book visibility, margins inflecting' },
  { instrumentId: 'NSE:AXISBANK', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Turnaround story; Citi acquisition integration, RoE expansion' },
  { instrumentId: 'NSE:SBIN', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'PSU bank reform; NPA resolution, credit growth pickup' },
  { instrumentId: 'NSE:SUNPHARMA', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Pharma leader; specialty pipeline, US generic pricing stabilization' },
  { instrumentId: 'NSE:MARUTI', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Passenger vehicle leader; SUV mix shift, margin recovery' },
  { instrumentId: 'NSE:TITAN', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Jewellery/eyewear retail; wedding demand, CaratLane optionality' },
  { instrumentId: 'NSE:ASIANPAINT', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Decorative paint leader; raw material tailwinds, market share gains' },
  { instrumentId: 'NSE:DMART', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Value retail disruptor; store rollout, private label scaling' },
  { instrumentId: 'NSE:ZOMATO', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Food delivery duopoly; Blinkit adjacency, profitability inflection' },
  { instrumentId: 'NSE:PAYTM', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Payments ecosystem; UPI monetization, lending take-rate expansion' },
  { instrumentId: 'NSE:NYKAA', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Beauty/personal care marketplace; brand portfolio, loyalty moat' },
  { instrumentId: 'NSE:POLICYBZR', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Insurance aggregator; term/health cross-sell, renewal revenue visibility' },

  // Mid/Small-cap quality names
  { instrumentId: 'NSE:PERSISTENT', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Mid-cap IT services; digital engineering, margin expansion' },
  { instrumentId: 'NSE:COFORGE', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'BFSI-focused IT; BPS margin leverage, insurance vertical strength' },
  { instrumentId: 'NSE:MPHASIS', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Applied technology; Direct International growth, Blackstone backing' },
  { instrumentId: 'NSE:LTIM', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'LTI-Mindtree merger synergy; large deal wins, margin convergence' },
  { instrumentId: 'NSE:TRENT', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Tata retail; Zudio scale, Westside premiumization' },
  { instrumentId: 'NSE:DIXON', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'EMS leader; PLI beneficiary, mobile/wearables assembly' },
  { instrumentId: 'NSE:AMBER', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'AC components OEM; PLI, heat pump transition, backward integration' },
  { instrumentId: 'NSE:KAJARIACER', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Ceramic tiles leader; real estate recovery, organized shift' },
  { instrumentId: 'NSE:SUPREMEIND', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Piping/plastics leader; agri/infra capex, capacity expansion' },
  { instrumentId: 'NSE:ASTRAL', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'CPVC/piping leader; adhesive adjacency, export growth' },
  { instrumentId: 'NSE:PGHH', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Hygiene/health leader; Gillette/Vicks franchise, pricing power' },
  { instrumentId: 'NSE:NESTLEIND', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Nutrition/culinary leader; Maggi/Milkmaid moat, rural penetration' },
  { instrumentId: 'NSE:BRITANNIA', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Biscuit leader; premiumization, adjacency expansion (dairy/cake)' },
  { instrumentId: 'NSE:GODREJCP', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Home/personal care; Indonesia turnaround, Park Avenue integration' },

  // Indian MF funds for switch opportunities (direct plans)
  { instrumentId: 'MF:PPFC', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Flexi-cap benchmark; Parag Parikh process, overseas allocation optionality' },
  { instrumentId: 'MF:ICICI-NIFTY50-IDX', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Nifty 50 index core; low cost, tax-efficient, liquid' },
  { instrumentId: 'MF:HDFC-MIDCAP', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Mid-cap specialist; HDFC process, stock-picking alpha' },
  { instrumentId: 'MF:MOTILAL-MIDCAP', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Mid-cap quality focus; buy-and-hold, low turnover' },
  { instrumentId: 'MF:ICICI-LARGECAP', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Large-cap active; ICICI process, consistent alpha vs benchmark' },
  { instrumentId: 'MF:BANDHAN-SMALLCAP', addedOn: '2026-01-15', removedOn: null, source: 'advisor', reason: 'Small-cap specialist; Bandhan process, liquidity buffer management' },
];

/**
 * Seeds the watchlist table.
 * Uses upsert on (instrument_id, added_on) so re-runs are idempotent.
 * Skips instruments that don't exist in the database (allows partial seeding).
 */
export async function seedWatchlist(db: Db): Promise<void> {
  // First, get all existing instrument IDs
  const existing = await db.query<{ id: string }>(
    `select id from instruments`
  );
  const existingIds = new Set(existing.map(r => r.id));

  for (const w of SEED_WATCHLIST) {
    if (!existingIds.has(w.instrumentId)) {
      // Skip instruments that don't exist yet - they'll be added when the instrument is created
      continue;
    }
    await db.query(
      `insert into watchlist (instrument_id, added_on, removed_on, source, reason)
       values ($1, $2, $3, $4, $5)
       on conflict (instrument_id, added_on) do nothing`,
      [w.instrumentId, w.addedOn, w.removedOn ?? null, w.source, w.reason],
    );
  }
}