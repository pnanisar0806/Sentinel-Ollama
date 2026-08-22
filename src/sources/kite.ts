import type { SourceRow } from './types.js';
import type { Paise } from '../money/paise.js';
import type { InstrumentSeed } from '../seed/seed-data.js';

const BASE_URL = 'https://api.kite.trade';

interface KiteHolding {
  tradingsymbol: string;
  exchange: string;
  isin: string;
  quantity: number;
  average_price: number;
  last_price: number;
  close_price: number;
}

const toPaise = (rupeeValue: number): Paise =>
  BigInt(Math.round(rupeeValue * 100)) as Paise;

/**
 * Read-only Kite Connect client. Phase 0 has no order path — placing orders is
 * Phase 3 work behind the human-in-the-loop unlock, and static-IP registration
 * is mandatory for it (verified Aug 2026). Adding a write method here is a
 * scope violation, not a convenience.
 */
export class KiteSource {
  readonly name = 'kite';
  private readonly apiKey: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { apiKey: string; accessToken: string; fetchImpl?: typeof fetch }) {
    this.apiKey = opts.apiKey;
    this.accessToken = opts.accessToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private get = async <T>(path: string): Promise<T> => {
    const res = await this.fetchImpl(`${BASE_URL}${path}`, {
      headers: {
        Authorization: `token ${this.apiKey}:${this.accessToken}`,
        'X-Kite-Version': '3',
      },
    });
    const body = (await res.json()) as { status: string; data?: T; message?: string };
    if (!res.ok || body.status !== 'success') {
      throw new Error(`Kite ${path} failed: ${body.message ?? res.status}`);
    }
    return body.data as T;
  }

  async getHoldings(): Promise<KiteHolding[]> {
    return this.get<KiteHolding[]>('/portfolio/holdings');
  }

  async fetch(): Promise<{ rows: SourceRow[]; asOf: string }> {
    const holdings = await this.getHoldings();
    const rows = holdings.map((h): SourceRow => {
      const instrumentId = `${h.exchange}:${h.tradingsymbol}`;
      const price = h.last_price || h.close_price;
      const instrument: InstrumentSeed = {
        id: instrumentId,
        kind: /BEES$|ETF$/.test(h.tradingsymbol) ? 'ETF' : 'EQUITY',
        name: h.tradingsymbol,
        currency: 'INR',
      };
      return {
        instrumentId,
        account: 'zerodha',
        quantity: h.quantity,
        valuePaise: toPaise(h.quantity * price),
        // A zero average price means Kite has no cost basis for the lot — unknown, not free.
        avgCostPaise: h.average_price > 0 ? toPaise(h.average_price) : null,
        instrument,
      };
    });
    return { rows, asOf: new Date().toISOString() };
  }
}