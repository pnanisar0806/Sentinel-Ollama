import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { RemoteIndmoneySource } from '../../src/sources/indmoney.js';
import { KiteSource } from '../../src/sources/kite.js';
import { McpClient } from '../../src/sources/mcp-client.js';
import { classify } from '../../src/domain/networth.js';

const fixture = JSON.parse(
  await readFile('tests/fixtures/indmoney-holdings-mcp.json', 'utf8'),
) as { byAssetType: Record<string, { holdings: Record<string, unknown>[] } | undefined> };

const client = {
  callTool: async (_n: string, a: { asset_type: string }) =>
    ({ result: JSON.stringify(fixture.byAssetType[a.asset_type] ?? { holdings: [] }) }),
} as unknown as McpClient;

const indmoneyRows = async () =>
  (await new RemoteIndmoneySource({ client, spacingMs: 0 }).fetch()).rows;

/**
 * Review item 6. The payload stamps every Indian ETF with asset_type 'STOCK', so the
 * mapper's 'ETF' entry was unreachable and there was no 'GOLD' entry at all — gold and
 * liquid ETFs landed as EQUITY. That destroys the single allocation recommendation the
 * portfolio actually has (MEMORY § Task 9: GOLD is 1.32% against a 5% floor, Rs 1,75,449.98
 * to buy), because post-sync the GOLD bucket held only the seed row.
 */
describe('INDmoney ETFs are not all equity', () => {
  it('routes a gold ETF to GOLD even though the payload calls it STOCK', async () => {
    const rows = await indmoneyRows();
    const gold = rows.find((r) => /gold/i.test(r.instrument.name));
    expect(gold, 'the capture contains a gold ETF').toBeDefined();
    expect(gold!.instrument.kind).toBe('GOLD');
    expect(classify(gold!.instrument.kind, gold!.instrumentId, gold!.instrument.name)).toBe('GOLD');
  });

  it('routes a liquid ETF to DEBT, not EQUITY', async () => {
    const rows = await indmoneyRows();
    const liquid = rows.find((r) => /liquid/i.test(r.instrument.name));
    expect(liquid, 'the capture contains a liquid ETF').toBeDefined();
    expect(classify(liquid!.instrument.kind, liquid!.instrumentId, liquid!.instrument.name)).toBe('DEBT');
  });

  it('still calls an index ETF equity', async () => {
    const rows = await indmoneyRows();
    const bees = rows.find((r) => /Nifty 50 BeES/i.test(r.instrument.name));
    expect(bees).toBeDefined();
    expect(bees!.instrument.kind).toBe('ETF');
    expect(classify(bees!.instrument.kind, bees!.instrumentId, bees!.instrument.name)).toBe('EQUITY');
  });

  it('leaves an ordinary share as equity', async () => {
    const rows = await indmoneyRows();
    const reliance = rows.find((r) => /Reliance Industries/i.test(r.instrument.name));
    expect(reliance).toBeDefined();
    expect(classify(reliance!.instrument.kind, reliance!.instrumentId, reliance!.instrument.name))
      .toBe('EQUITY');
  });
});

const kite = (holdings: unknown[]) =>
  new KiteSource({
    apiKey: 'k', accessToken: 'a',
    fetchImpl: (async () =>
      new Response(JSON.stringify({ status: 'success', data: holdings }), { status: 200 })
    ) as unknown as typeof fetch,
  });

const holding = (over: Record<string, unknown> = {}) => ({
  tradingsymbol: 'NIFTYBEES', exchange: 'NSE', isin: 'INF204KB14I2',
  quantity: 380, average_price: 250, last_price: 250, close_price: 250, ...over,
});

describe('Kite has the mirror defects', () => {
  it('routes GOLDBEES to GOLD, not EQUITY', async () => {
    const { rows } = await kite([holding({ tradingsymbol: 'GOLDBEES', quantity: 2616 })]).fetch();
    const r = rows[0]!;
    expect(r.instrument.kind).toBe('GOLD');
    expect(classify(r.instrument.kind, r.instrumentId, r.instrument.name)).toBe('GOLD');
  });

  it('routes LIQUIDBEES to DEBT', async () => {
    const { rows } = await kite([holding({ tradingsymbol: 'LIQUIDBEES' })]).fetch();
    const r = rows[0]!;
    expect(classify(r.instrument.kind, r.instrumentId, r.instrument.name)).toBe('DEBT');
  });

  /**
   * Review item 8: Kite wrote avgCostPaise from `average_price`, which is PER UNIT,
   * while INDmoney (and the seed) write the TOTAL invested. 380 units of NIFTYBEES at
   * Rs 250 recorded a Rs 250 cost basis against a Rs 95,000 position — a 380x error, and
   * every P&L and XIRR downstream of it.
   */
  it('records TOTAL cost, matching the unit INDmoney and the seed use', async () => {
    const { rows } = await kite([holding()]).fetch();
    const r = rows[0]!;
    expect(r.valuePaise).toBe(9_500_000n);     // 380 x 250.00
    expect(r.avgCostPaise).toBe(9_500_000n);   // total, NOT 25_000n per unit
  });

  it('still reports an unknown cost as null rather than zero (FR-02)', async () => {
    const { rows } = await kite([holding({ average_price: 0 })]).fetch();
    expect(rows[0]!.avgCostPaise).toBeNull();
  });

  /** Review item 10: `last_price || close_price` yields 0 when both are absent. */
  it('refuses to value a holding with no price rather than reporting Rs 0', async () => {
    await expect(kite([holding({ last_price: 0, close_price: 0 })]).fetch())
      .rejects.toThrow(/price/i);
  });

  it('falls back to close_price when last_price is missing', async () => {
    const { rows } = await kite([holding({ last_price: 0, close_price: 250 })]).fetch();
    expect(rows[0]!.valuePaise).toBe(9_500_000n);
  });
});
