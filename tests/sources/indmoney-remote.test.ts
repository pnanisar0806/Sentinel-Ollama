import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { McpClient } from '../../src/sources/mcp-client.js';
import { RemoteIndmoneySource, ASSET_TYPES } from '../../src/sources/indmoney.js';
import { SEED_INSTRUMENTS } from '../../src/seed/seed-data.js';
import { rupees } from '../../src/money/paise.js';

interface FixtureHolding {
  investment_code?: string;
  investment?: string;
  asset_type?: string;
  market_value?: number;
  invested_amount?: number | string;
  total_units?: number;
}

const fixture = JSON.parse(
  await readFile('tests/fixtures/indmoney-holdings-mcp.json', 'utf8'),
) as {
  byAssetType: Record<string, { holdings: FixtureHolding[] } | undefined>;
  _rateLimitedResponse: Record<string, unknown>;
};

/** Fails loudly if the capture loses an asset class, rather than testing an empty book. */
function capture(assetType: string): { holdings: FixtureHolding[] } {
  const payload = fixture.byAssetType[assetType];
  if (!payload) throw new Error(`fixture has no capture for ${assetType}`);
  return payload;
}

/** The real tool answers with one `result` key holding a JSON string. */
const envelope = (payload: unknown) => ({ result: JSON.stringify(payload) });

/** Serves the real per-asset-type captures, and records what it was asked for. */
const captureClient = (asked: string[] = []) => ({
  asked,
  client: {
    callTool: async (_name: string, args: { asset_type: string }) => {
      asked.push(args.asset_type);
      return envelope(fixture.byAssetType[args.asset_type] ?? { holdings: [] });
    },
  } as unknown as McpClient,
});

const stubOnce = (payload: unknown) =>
  ({ callTool: async () => envelope(payload) } as unknown as McpClient);

const source = (client: McpClient, assetTypes?: readonly string[]) =>
  new RemoteIndmoneySource({ client, spacingMs: 0, ...(assetTypes ? { assetTypes } : {}) });

describe('RemoteIndmoneySource', () => {
  it('produces the same SourceRow shape as the file source', async () => {
    const { client } = captureClient();
    const { rows, asOf } = await source(client).fetch();

    expect(rows.length).toBeGreaterThan(0);
    expect(asOf).toMatch(/^\d{4}-\d{2}-\d{2}/);
    // Accounts are broker-attributed now: real custodies (zerodha/groww) plus the
    // per-type fallbacks (indmoney/epf/bank). 'fidelity' never comes from INDmoney.
    const allowed = new Set(['zerodha', 'groww', 'indmoney', 'epf', 'bank']);
    for (const r of rows) {
      expect(allowed.has(r.account)).toBe(true);
      expect(typeof r.valuePaise).toBe('bigint');
      expect(r.avgCostPaise === null || typeof r.avgCostPaise === 'bigint').toBe(true);
    }
  });

  it('asks per asset class, because the tool has no all-assets call', async () => {
    const { asked, client } = captureClient();
    await source(client).fetch();
    expect(asked).toEqual([...ASSET_TYPES]);
  });

  it('maps a zero, missing or "unknown" invested amount to null cost, never 0 (FR-02)', async () => {
    const { rows } = await source(stubOnce({
      holdings: [
        { investment_code: 'A1', investment: 'Unknown cost', asset_type: 'STOCK', market_value: 2649.85, invested_amount: 'unknown', total_units: 113 },
        { investment_code: 'A2', investment: 'Zero cost', asset_type: 'STOCK', market_value: 95000, invested_amount: 0, total_units: 1 },
        { investment_code: 'A3', investment: 'Absent cost', asset_type: 'STOCK', market_value: 100, total_units: 1 },
      ],
    }), ['IND_STOCK']).fetch();

    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.avgCostPaise).toBeNull();
  });

  // Derived from the fixture rather than hard-coded: the real book is entirely
  // cost-unknown, so a mapper that invented a cost basis would show up here.
  it('carries null cost for every Indian stock in the real capture', async () => {
    const stocks = capture('IND_STOCK');
    const rows = (await source(stubOnce(stocks), ['IND_STOCK']).fetch()).rows;
    const unknownInSource = stocks.holdings
      .filter((h) => typeof h.invested_amount !== 'number').length;

    expect(unknownInSource).toBe(stocks.holdings.length);
    expect(rows.filter((r) => r.avgCostPaise === null)).toHaveLength(rows.length);
  });

  it('aggregates folios within a broker but keeps real brokers apart', async () => {
    const mf = capture('MF');
    const codes = mf.holdings.map((h) => h.investment_code);
    const distinct = new Set(codes);
    expect(distinct.size).toBeLessThan(codes.length); // the capture really does repeat

    const { rows } = await source(stubOnce(mf), ['MF']).fetch();
    // Per-broker attribution means MORE rows than before (a Zerodha folio no longer
    // merges into an INDmoney folio of the same fund) but never fewer than the
    // distinct instrument count.
    expect(rows.length).toBeGreaterThanOrEqual(distinct.size);

    // Money is conserved exactly regardless of how folios are grouped.
    const expected = mf.holdings.reduce((s, h) => s + rupees(h.market_value!.toFixed(2)), 0n);
    expect(rows.reduce((s, r) => s + r.valuePaise, 0n)).toBe(expected);
  });

  it('treats a rate-limit reply as fatal rather than an empty portfolio', async () => {
    await expect(source(stubOnce(fixture._rateLimitedResponse), ['MF']).fetch())
      .rejects.toThrow(/rate_limit_exceeded/);
  });

  it('refuses a partial book flagged by holding_error', async () => {
    await expect(source(stubOnce({ holdings: [], holding_error: true }), ['MF']).fetch())
      .rejects.toThrow(/holding_error/);
  });

  it('throws on an unmapped asset_type instead of guessing an asset class', async () => {
    await expect(source(stubOnce({
      holdings: [{ investment_code: 'X', investment: 'Some FD', asset_type: 'FD', market_value: 100 }],
    }), ['FD']).fetch()).rejects.toThrow(/unmapped INDmoney asset_type 'FD'/);
  });

  it('fails loudly on an unrecognised payload instead of syncing an empty portfolio', async () => {
    await expect(source(stubOnce({ unexpected: true }), ['MF']).fetch())
      .rejects.toThrow(/could not parse/i);
  });

  // This claimed the ids "match the seeded bonds" while never importing SEED_INSTRUMENTS:
  // both sides of the comparison were the mapper's own convention, so it would have
  // passed under any naming scheme at all. It is the test that would have caught the
  // seed/sync double count (review C-A). It now reads the real seed.
  //
  // NOTE: the assertion below is that the ISINs AGREE, not that the ids do. They do not
  // yet — the seed uses 'BOND:SAMMAAN-2026' while the mapper mints 'ISIN:INE148I07GL3',
  // which is exactly cause (1) of C-A and is still open pending the owner's instrument
  // map. Pinning the ISIN correspondence is what makes that reconciliation checkable.
  it('mints ISIN ids that correspond to the ISINs the seed actually carries', async () => {
    const { rows } = await source(stubOnce(capture('BOND')), ['BOND']).fetch();

    const seededIsins = SEED_INSTRUMENTS
      .map((i) => i.isin)
      .filter((x): x is string => typeof x === 'string');
    expect(seededIsins.length).toBeGreaterThan(0);

    const mappedIsins = rows
      .map((r) => /^ISIN:(.+)$/.exec(r.instrumentId)?.[1])
      .filter((x): x is string => typeof x === 'string');

    // Derived from the seed, not restated: every bond the seed knows an ISIN for is
    // present in the live capture under that same ISIN.
    expect([...mappedIsins].sort()).toEqual([...seededIsins].sort());
  });

  it('does not label a non-ISIN investment_code as an ISIN', async () => {
    const { rows } = await source(stubOnce(capture('MF')), ['MF']).fetch();
    for (const r of rows) expect(r.instrumentId.startsWith('ISIN:')).toBe(false);
  });
});
