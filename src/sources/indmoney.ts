import { readFile } from 'node:fs/promises';
import type { McpClient } from './mcp-client.js';
import type { Source, SourceRow } from './types.js';
import { rupees, type Paise } from '../money/paise.js';
import type { InstrumentSeed } from '../seed/seed-data.js';

interface SnapshotRow {
  instrumentId: string;
  kind: InstrumentSeed['kind'];
  name: string;
  currency: 'INR' | 'USD';
  issuer?: string;
  quantity: number;
  valueInr: number;
  /** null or 0 both mean "INDmoney does not know" — Zerodha-linked rows lack cost. */
  avgCostInr: number | null;
}

/**
 * INDmoney's MCP is read-only (good) but authenticates with OAuth 2.1 + PKCE
 * behind OTP + MPIN, which no unattended runner can complete. Phase 0 therefore
 * reads an owner-refreshed snapshot file; staleness (Task 12) nags when it ages.
 * RemoteIndmoneySource implements the same `Source` interface for live MCP access.
 */
export class FileIndmoneySource implements Source {
  readonly name = 'indmoney';
  constructor(private readonly path: string) {}

  async fetch(): Promise<{ rows: SourceRow[]; asOf: string }> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch {
      throw new Error(
        `INDmoney snapshot not found at ${this.path}. Refresh it before syncing — ` +
        `Sentinel will not silently report a portfolio it cannot see.`,
      );
    }

    const parsed = JSON.parse(raw) as { asOf: string; holdings: SnapshotRow[] };
    const rows = parsed.holdings.map((h): SourceRow => ({
      instrumentId: h.instrumentId,
      account: 'indmoney',
      quantity: h.quantity,
      valuePaise: rupees(h.valueInr),
      avgCostPaise: h.avgCostInr ? rupees(h.avgCostInr) : null,
      instrument: {
        id: h.instrumentId, kind: h.kind, name: h.name,
        currency: h.currency, ...(h.issuer ? { issuer: h.issuer } : {}),
      },
    }));
    return { rows, asOf: parsed.asOf };
  }
}

/**
 * One row of `networth_holdings`. Field names are from a real capture, not the
 * plan's sketch: the payload says `investment` / `market_value` / `invested_amount`
 * / `investment_code`, and carries no issuer at all.
 */
interface RemoteHolding {
  investment_code?: string;
  investment?: string;
  asset_type?: string;
  /** A number, or the literal string 'unknown' — every IND_STOCK row is 'unknown'. */
  invested_amount?: number | string | null;
  market_value?: number;
  total_units?: number;
}

/** The tool answers per asset class; there is no all-assets call. */
export const ASSET_TYPES = ['IND_STOCK', 'MF', 'US_STOCK', 'BOND', 'EPF', 'SA'] as const;

/**
 * Keyed on the `asset_type` each ROW carries, which is not always the argument that
 * fetched it — asking for IND_STOCK returns rows stamped `STOCK`.
 *
 * Deliberately partial. An unmapped type throws rather than defaulting: silently
 * classifying an unknown holding as EQUITY would feed a wrong asset class straight
 * into allocation drift and the IPS bands.
 */
const KIND_BY_ASSET_TYPE: Record<string, InstrumentSeed['kind']> = {
  STOCK: 'EQUITY', IND_STOCK: 'EQUITY', ETF: 'ETF', MF: 'MF',
  BOND: 'BOND', EPF: 'EPF', SA: 'CASH', US_STOCK: 'EQUITY',
};

const CURRENCY_BY_ASSET_TYPE: Record<string, 'INR' | 'USD'> = { US_STOCK: 'USD' };

/**
 * The payload stamps EVERY Indian ETF with asset_type 'STOCK', so the 'ETF' entry above
 * is unreachable from a real capture and there is no 'GOLD' asset_type at all. Left
 * alone, gold and liquid ETFs land as EQUITY — which erases the one allocation
 * recommendation this portfolio actually has (GOLD 1.32% against a 5% floor) and
 * overstates equity against its IPS band.
 *
 * Name-based, because the payload gives us nothing else to go on. Narrow on purpose:
 * only a row the provider already called a share is reconsidered.
 */
const GOLD_HINT = /\bgold\b/i;
const ETF_HINT = /\bETFs?\b|BeES\b/i;

function kindFor(assetType: string, name: string): InstrumentSeed['kind'] | undefined {
  const base = KIND_BY_ASSET_TYPE[assetType];
  if (base !== 'EQUITY') return base;
  if (GOLD_HINT.test(name)) return 'GOLD';
  if (ETF_HINT.test(name)) return 'ETF';
  return base;
}

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

/** Money values arrive as INR for every asset class, US holdings included. */
function instrumentIdFor(h: RemoteHolding): string {
  const code = h.investment_code?.trim();
  if (code && ISIN.test(code)) return `ISIN:${code}`;
  if (code) return `IND:${code}`;
  return `IND:${(h.investment ?? 'UNNAMED').replace(/\s+/g, '-').toUpperCase()}`;
}

export class RemoteIndmoneySource implements Source {
  readonly name = 'indmoney';

  constructor(
    private readonly opts: {
      client: McpClient;
      assetTypes?: readonly string[];
      /**
       * networth_holdings costs 2 against a 15-per-minute budget, so six classes
       * sit just inside one window. Spacing the calls keeps a sync from tipping
       * into the rate limiter; tests pass 0.
       */
      spacingMs?: number;
    },
  ) {}

  async fetch(): Promise<{ rows: SourceRow[]; asOf: string }> {
    const types = this.opts.assetTypes ?? ASSET_TYPES;
    const spacing = this.opts.spacingMs ?? 9_000;
    const holdings: RemoteHolding[] = [];

    for (const [i, assetType] of types.entries()) {
      if (i > 0 && spacing > 0) await new Promise((r) => setTimeout(r, spacing));
      holdings.push(...await this.fetchOne(assetType));
    }

    return { rows: aggregate(holdings), asOf: new Date().toISOString() };
  }

  private async fetchOne(assetType: string): Promise<RemoteHolding[]> {
    const envelope = await this.opts.client.callTool<{ result?: string }>(
      'networth_holdings', { asset_type: assetType },
    );

    // callTool hands back the tool's own envelope: one `result` key holding a JSON string.
    if (typeof envelope?.result !== 'string') {
      throw new Error(
        `could not parse INDmoney networth_holdings payload for ${assetType} — the tool ` +
        'contract changed; recapture the fixture before trusting this sync',
      );
    }

    const payload = JSON.parse(envelope.result) as {
      holdings?: RemoteHolding[]; error?: string; message?: string; holding_error?: boolean;
    };

    // A throttled call answers successfully with an error body instead of holdings.
    // Reading that as "no holdings" would wipe the portfolio, so it is fatal.
    if (payload.error) {
      throw new Error(`INDmoney refused networth_holdings for ${assetType}: ${payload.error} — ${payload.message ?? '(no message)'}`);
    }
    if (payload.holding_error) {
      throw new Error(`INDmoney reported holding_error for ${assetType}; the book may be partial — refusing to sync it`);
    }
    if (!Array.isArray(payload.holdings)) {
      throw new Error(
        `could not parse INDmoney networth_holdings payload for ${assetType} — the tool ` +
        'contract changed; recapture the fixture before trusting this sync',
      );
    }
    return payload.holdings;
  }
}

/**
 * One instrument is one position. The same fund arrives once per broker/folio —
 * ICICI Nifty 50 comes back three times — and leaving them as separate rows would
 * understate a single-scheme concentration and collide on (snapshot, instrument).
 */
function aggregate(holdings: RemoteHolding[]): SourceRow[] {
  const byId = new Map<string, SourceRow>();

  for (const h of holdings) {
    const assetType = h.asset_type ?? '';
    const kind = kindFor(assetType, h.investment ?? '');
    if (!kind) {
      throw new Error(
        `unmapped INDmoney asset_type '${assetType}' on '${h.investment ?? '(unnamed)'}' — ` +
        'add it to KIND_BY_ASSET_TYPE deliberately rather than guessing an asset class',
      );
    }
    if (typeof h.market_value !== 'number') {
      throw new Error(`INDmoney holding '${h.investment ?? '(unnamed)'}' has no numeric market_value`);
    }

    const id = instrumentIdFor(h);
    // A non-numeric invested_amount ('unknown') is FR-02 unknown cost, never zero.
    //
    // For BONDS `invested_amount` is FACE VALUE, not cost — confirmed exactly against
    // the owner's portal (MEMORY.md § Owner true-up item 1). The API returns 300000 /
    // 100000 / 220000, which is precisely units x face; the real cost is 2,84,057.70 /
    // 95,941.91 / 2,20,000.00. The two Sammaan bonds were bought below par, which is
    // why their YTM exceeds their coupon. This source simply does not know bond cost,
    // and FR-02 says an unknown is NULL — never the number that happens to be to hand.
    // (`total_pnl` / `pnl_per` are computed against face too, so they are unusable here
    // for the same reason.)
    const cost = kind === 'BOND' ? null
      : typeof h.invested_amount === 'number' && h.invested_amount > 0
      ? rupees(h.invested_amount.toFixed(2))
      : null;
    const existing = byId.get(id);

    if (!existing) {
      byId.set(id, {
        instrumentId: id,
        account: 'indmoney',
        quantity: h.total_units ?? 0,
        valuePaise: rupees(h.market_value.toFixed(2)),
        avgCostPaise: cost,
        instrument: {
          id, kind, name: h.investment ?? id,
          currency: CURRENCY_BY_ASSET_TYPE[assetType] ?? 'INR',
        },
      });
      continue;
    }

    existing.quantity += h.total_units ?? 0;
    existing.valuePaise = (existing.valuePaise + rupees(h.market_value.toFixed(2))) as Paise;
    // Any leg of unknown cost makes the aggregate cost unknown — not a partial sum.
    existing.avgCostPaise = existing.avgCostPaise === null || cost === null
      ? null
      : (existing.avgCostPaise + cost) as Paise;
  }

  return [...byId.values()];
}