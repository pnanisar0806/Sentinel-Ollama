import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { RemoteIndmoneySource } from '../../src/sources/indmoney.js';
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
