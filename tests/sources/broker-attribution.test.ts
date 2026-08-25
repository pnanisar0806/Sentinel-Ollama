import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../src/sources/mcp-client.js';
import { RemoteIndmoneySource } from '../../src/sources/indmoney.js';
import { rupees } from '../../src/money/paise.js';

const fixture = JSON.parse(
  await readFile('tests/fixtures/indmoney-holdings-mcp.json', 'utf8'),
) as { byAssetType: Record<string, { holdings: Record<string, unknown>[] }> };

const stubAll = () =>
  ({
    callTool: async (_name: string, args: { asset_type: string }) => {
      const payload = fixture.byAssetType[args.asset_type] ?? { holdings: [] };
      return { result: JSON.stringify(payload) };
    },
  } as unknown as McpClient);

const fetchAll = async () =>
  (await new RemoteIndmoneySource({ client: stubAll(), spacingMs: 0 } as never).fetch()).rows;

/**
 * Broker provenance is the dedup backbone: live rows must wear their real broker as
 * `account` (normalized), so they collide with — and retire — the owner's seed rows
 * under the existing (canonical_id, account) rule. Before this fix every live row
 * was account 'indmoney' and nothing ever reconciled.
 */
describe('broker attribution and per-broker aggregation', () => {
  it('splits ICICI Nifty 50 into its real folios instead of one merged blob', async () => {
    const rows = await fetchAll();
    const icici = rows.filter((r) => r.instrumentId === 'IND:5536');

    // Real capture: two INDmoney folios (merged together) + one Zerodha folio (kept apart).
    expect(icici).toHaveLength(2);
    const accounts = new Set(icici.map((r) => r.account));
    expect(accounts.has('zerodha')).toBe(true);
    expect(accounts.has('indmoney')).toBe(true);

    const zerodha = icici.find((r) => r.account === 'zerodha')!;
    expect(zerodha.valuePaise).toBe(rupees('46515.91'));
    const indmoney = icici.find((r) => r.account === 'indmoney')!;
    expect(indmoney.valuePaise).toBe(65_454_637n); // 376831.52 + 277714.85, paise-exact

    for (const r of icici) expect(r.instrument.canonicalId).toBe('MF:5536');
  });

  it('normalizes sloppy broker strings ("Zerodha ") like the clean ones', async () => {
    const rows = await fetchAll();
    const nifty = rows.filter((r) => r.instrumentId === 'IND:INDS19182');
    expect(nifty).toHaveLength(1);
    expect(nifty[0]!.account).toBe('zerodha');
    expect(nifty[0]!.instrument.canonicalId).toBe('NSE:INDS19182');
  });

  it('falls back by asset type when the broker field is blank', async () => {
    const rows = await fetchAll();
    const epf = rows.filter((r) => r.instrument.canonicalId === 'EPF:SERVICE_NOW');
    expect(epf.length).toBeGreaterThan(0);
    for (const r of epf) {
      expect(r.account).toBe('epf');
      // Unlike Indian stocks, INDmoney DOES report an invested amount for EPF —
      // the two ServiceNow EPF accounts carry real numbers, not 'unknown'.
      expect(r.avgCostPaise === null || typeof r.avgCostPaise === 'bigint').toBe(true);
    }

    const savings = rows.filter((r) => r.instrument.canonicalId === 'CASH:SAVINGS_HDFC_FEDERAL');
    expect(savings).toHaveLength(2); // Federal + HDFC stay separate rows, same bucket
    for (const r of savings) expect(r.account).toBe('bank');
  });
});
