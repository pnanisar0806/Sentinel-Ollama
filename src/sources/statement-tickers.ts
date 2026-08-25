/**
 * Zerodha statement symbol → instrument id, curated from the OWNER'S OWN statements
 * and confirmed Telegram writes (cost equality across independent reads, 2026-08-25/26).
 * Nothing here is inferred — FR-02 discipline: an unknown ticker resolves to nothing
 * rather than to a guess.
 *
 * Why this exists: vision extraction reads tickers (TMCV, TMPV…) but anchors costs by
 * GUESSED line numbers against the holdings list. Near-identical names ("Tata Motors
 * Ltd" vs "Tata Motors Passenger Vehicles Ltd") flip that guess nondeterministically —
 * it bit three times on 2026-08-25 alone. A ticker hit overrides the line number;
 * the line is only a fallback for holdings this map does not know.
 */
export const TICKER_TO_INSTRUMENT: Record<string, string> = {
  ASIANPAINT: 'IND:INDS00427',
  BERGEPAINT: 'IND:INDS00365',
  CRISIL: 'IND:INDS00083',
  GOLDCASE: 'IND:INDS29570',
  HDFCBANK: 'IND:INDS01992',
  HINDUNILVR: 'IND:INDS01216',
  ITC: 'IND:INDS00972',
  JUNIORBEES: 'IND:INDS20619',
  KEI: 'IND:INDS01632',
  KIRLPNU: 'IND:INDS00128',
  KWIL: 'IND:INDS41134',
  LICI: 'IND:INDS03934',
  LIQUIDCASE: 'IND:INDS28892',
  MM: 'IND:INDS01150', // M&M
  MMFIN: 'IND:INDS01694', // M&MFIN
  MAHLIFE: 'IND:INDS02342',
  NIFTYBEES: 'IND:INDS19182',
  PERSISTENT: 'IND:INDS02755',
  PIDILITIND: 'IND:INDS00200',
  RELIANCE: 'IND:INDS01052',
  SCHAEFFLER: 'IND:INDS03891',
  SUNDARMFIN: 'IND:INDS01789',
  TASTEEL: 'IND:INDS00413',
  TATAPOWER: 'IND:INDS00395',
  TECHM: 'IND:INDS01469',
  TMCV: 'IND:INDS39566', // Tata Motors Ltd (post-demerger CV entity)
  TMPV: 'IND:INDS00954', // Tata Motors Passenger Vehicles Ltd
  ZFCVINDIA: 'IND:INDS03291',
};

/** Uppercase and strip everything non-alphanumeric: 'M&M' and 'm & m' both → 'MM'. */
export function normalizeTicker(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Resolves a statement symbol to its instrument id, or undefined when unknown. */
export function resolveTicker(name: string): string | undefined {
  return TICKER_TO_INSTRUMENT[normalizeTicker(name)];
}

/** Reverse view for the LLM prompt: "TMCV = Tata Motors Ltd". */
export function tickerForInstrument(instrumentId: string): string | undefined {
  return Object.entries(TICKER_TO_INSTRUMENT).find(([, id]) => id === instrumentId)?.[0];
}
