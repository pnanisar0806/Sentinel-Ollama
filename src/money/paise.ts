declare const brand: unique symbol;
export type Paise = bigint & { readonly [brand]: 'Paise' };
export type Cents = bigint & { readonly [brand]: 'Cents' };

function parseMinorUnits(amount: number | string, unitName: string): bigint {
  const text = typeof amount === 'number' ? amount.toString() : amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(`invalid ${unitName} amount: ${amount}`);
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = text.replace('-', '').split('.');
  if (fraction.length > 2) throw new Error(`sub-paise precision not representable: ${amount}`);
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  return negative ? -minor : minor;
}

export const rupees = (amount: number | string): Paise =>
  parseMinorUnits(amount, 'rupee') as Paise;
export const paise = (v: bigint | string | number): Paise => BigInt(v) as Paise;
export const dollars = (amount: number | string): Cents =>
  parseMinorUnits(amount, 'dollar') as Cents;
export const cents = (v: bigint | string | number): Cents => BigInt(v) as Cents;

export const addP = (...xs: Paise[]): Paise => xs.reduce((a, b) => a + b, 0n) as Paise;
export const subP = (a: Paise, b: Paise): Paise => (a - b) as Paise;

/** Multiplies by a real factor via micro-precision integers; truncates toward zero. */
export const mulP = (p: Paise, factor: number): Paise => {
  const micros = BigInt(Math.round(factor * 1_000_000));
  return ((p * micros) / 1_000_000n) as Paise;
};

export const pctOf = (part: Paise, whole: Paise): number =>
  whole === 0n ? 0 : Number(part) / Number(whole);

const groupIndian = (digits: string): string => {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
};

export function formatInr(p: Paise, opts: { compact?: boolean } = {}): string {
  const negative = p < 0n;
  const abs = negative ? -p : p;
  const sign = negative ? '-' : '';

  if (opts.compact) {
    const wholeRupees = abs / 100n;
    if (wholeRupees >= 10_000_000n) return `${sign}₹${(Number(abs) / 1e9).toFixed(2)}Cr`;
    if (wholeRupees >= 100_000n) return `${sign}₹${(Number(abs) / 1e7).toFixed(2)}L`;
  }

  const whole = groupIndian((abs / 100n).toString());
  const frac = abs % 100n;
  return frac === 0n
    ? `${sign}₹${whole}`
    : `${sign}₹${whole}.${frac.toString().padStart(2, '0')}`;
}
