import { describe, expect, it } from 'vitest';
import { McpClient } from '../../src/sources/mcp-client.js';

/**
 * `callTool(name: string)` accepted any tool name at all. It is the one component in
 * the codebase that can invoke a NAMED REMOTE TOOL, and it got neither the method
 * allowlist nor the source scan KiteSource gets. Pointing it at Kite's MCP server —
 * which exposes `place_order`, `modify_order`, `cancel_order`, `place_gtt_order` —
 * needed only a URL change.
 *
 * CLAUDE.md: trading paths are "absent code paths, not disabled features". A client
 * that *could* name an order tool is a trading path.
 */
const never = (): typeof fetch =>
  (async () => {
    throw new Error('fetch must not be reached — the allowlist rejects before any network call');
  }) as unknown as typeof fetch;

const client = (allowedTools: readonly string[]) =>
  new McpClient({
    url: 'https://mcp.indmoney.com/mcp',
    getToken: async () => 'AT',
    fetchImpl: never(),
    allowedTools,
  });

describe('McpClient refuses any tool outside its allowlist', () => {
  it.each([
    'place_order',
    'modify_order',
    'cancel_order',
    'place_gtt_order',
    'delete_gtt_order',
    'anything_at_all',
  ])('refuses %s', async (tool) => {
    await expect(client(['networth_holdings']).callTool(tool, {})).rejects.toThrow(/not on the allowlist/);
  });

  it('rejects before opening a connection, not after', async () => {
    // fetchImpl throws a distinguishable error; seeing the allowlist message instead
    // proves nothing was sent — an allowlist checked after the request is not a guard.
    await expect(client(['networth_holdings']).callTool('place_order', {}))
      .rejects.toThrow(/not on the allowlist/);
  });

  it('names the offending tool and the permitted set', async () => {
    await expect(client(['networth_holdings']).callTool('place_order', {}))
      .rejects.toThrow(/place_order[\s\S]*networth_holdings/);
  });

  it('will not construct with an empty allowlist', () => {
    // An empty list is almost always a mistake that would read as "deny all" and get
    // "fixed" by widening. Force the caller to name what it needs.
    expect(() => client([])).toThrow(/allowedTools/);
  });

  it('permits a tool that IS on the allowlist (it reaches the transport)', async () => {
    await expect(client(['networth_holdings']).callTool('networth_holdings', {}))
      .rejects.toThrow(/fetch must not be reached/);
  });
});
