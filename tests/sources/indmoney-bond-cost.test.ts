import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../src/sources/mcp-client.js';
import { RemoteIndmoneySource } from '../../src/sources/indmoney.js';
import { rupees } from '../../src/money/paise.js';

const fixture = JSON.parse(
  await readFile('tests/fixtures/indmoney-holdings-mcp.json', 'utf8'),
) as { byAssetType: Record<string, { holdings: Record<string, unknown>[] } | undefined> };

const envelope = (payload: unknown) => ({ result: JSON.stringify(payload) });
const client = {
  callTool: async (_name: string, args: { asset_type: string }) =>
    envelope(fixture.byAssetType[args.asset_type] ?? { holdings: [] }),
} as unknown as McpClient;

/**
 * MEMORY.md § Owner true-up item 1, in bold: "Never map `invested_amount` to
 * `avgCostPaise`" — for bonds it is FACE VALUE, confirmed exactly against the owner's
 * portal. The API returns 300000 / 100000 / 220000, which is precisely units x face
 * (300x1,000, 1x1,00,000, 220x1,000). The real cost is 2,84,057.70 / 95,941.91 /
 * 2,20,000.00 = Rs 5,99,999.61, because the two Sammaan bonds were bought below par —
 * which is exactly why their YTM (11.29%, 11.70%) exceeds their coupon (9%, 9.75%).
 *
 * The source does not know bond cost. FR-02 says that is NULL, never a number that
 * happens to be available.
 */
describe('bond cost basis is never taken from invested_amount', () => {
  it('reports unknown cost for every bond in the real capture', async () => {
    const { rows } = await new RemoteIndmoneySource({ client, spacingMs: 0 }).fetch();
    const bonds = rows.filter((r) => r.instrument.kind === 'BOND');

    // Derived from the capture, so losing the bond block fails rather than passing empty.
    expect(bonds).toHaveLength(fixture.byAssetType.BOND!.holdings.length);
    expect(bonds.every((b) => b.avgCostPaise === null)).toBe(true);
  });

  it('does not write the face value the API calls invested_amount', async () => {
    const { rows } = await new RemoteIndmoneySource({ client, spacingMs: 0 }).fetch();
    const faceValues = fixture.byAssetType.BOND!.holdings
      .map((h) => rupees((h.invested_amount as number).toFixed(2)));

    const bondCosts = rows.filter((r) => r.instrument.kind === 'BOND').map((r) => r.avgCostPaise);
    for (const face of faceValues) {
      expect(bondCosts).not.toContain(face);
    }
    // The specific number MEMORY names: 300 units x Rs 1,000 face.
    expect(bondCosts).not.toContain(rupees('300000.00'));
  });

  it('still reports cost for asset classes whose invested_amount IS cost', async () => {
    // The guard must be bond-specific, not a blanket "drop all cost".
    const { rows } = await new RemoteIndmoneySource({ client, spacingMs: 0 }).fetch();
    const mf = rows.filter((r) => r.instrument.kind === 'MF');
    expect(mf.length).toBeGreaterThan(0);
    expect(mf.some((r) => r.avgCostPaise !== null)).toBe(true);
  });
});
