const ENDPOINT = 'https://api.frankfurter.app/latest?from=USD&to=INR';

/** Sanity band. A bad FX rate silently misprices the largest single-stock position. */
const MIN_PLAUSIBLE = 50;
const MAX_PLAUSIBLE = 200;

export async function fetchUsdInr(
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ rate: number; asOf: string; source: string }> {
  const impl = opts.fetchImpl ?? fetch;
  const res = await impl(ENDPOINT);
  if (!res.ok) throw new Error(`USDINR fetch failed: HTTP ${res.status}`);

  const body = (await res.json()) as { date: string; rates: { INR?: number } };
  const rate = body.rates?.INR;
  if (typeof rate !== 'number' || rate < MIN_PLAUSIBLE || rate > MAX_PLAUSIBLE) {
    throw new Error(`implausible USDINR rate: ${rate}`);
  }
  return { rate, asOf: body.date, source: 'frankfurter' };
}