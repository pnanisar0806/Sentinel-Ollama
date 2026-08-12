import type { Cents, Paise } from './paise.js';

/** 95.3 -> 95_300_000 micros. Stored in fx_rates.rate_micros. */
export const rateMicros = (rate: number): bigint => BigInt(Math.round(rate * 1_000_000));

/** USD cents -> INR paise at the given dated rate. Truncates toward zero. */
export function usdToInr(amount: Cents, micros: bigint): Paise {
  if (micros <= 0n) throw new Error('fx rate must be positive');
  return ((amount * micros) / 1_000_000n) as Paise;
}
