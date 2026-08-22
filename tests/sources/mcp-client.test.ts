import { describe, expect, it } from 'vitest';
import { McpClient } from '../../src/sources/mcp-client.js';

const rpc = (result: unknown): typeof fetch =>
  (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { id?: number; method: string };
    if (req.method === 'notifications/initialized') return new Response('', { status: 202 });
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: req.id, result: req.method === 'initialize' ? {} : result }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

const client = (impl: typeof fetch) =>
  new McpClient({ url: 'https://mcp.indmoney.com/mcp', getToken: async () => 'AT', fetchImpl: impl });

describe('McpClient', () => {
  it('initializes once, then calls tools', async () => {
    let calls = 0;
    const counting: typeof fetch = (async (url: string, init: RequestInit) => {
      calls++;
      return rpc({ content: [{ type: 'text', text: '{"ok":true}' }] })(url, init);
    }) as unknown as typeof fetch;

    const c = client(counting);
    await c.callTool('networth_holdings', {});
    await c.callTool('networth_holdings', {});
    // initialize + initialized notification + two tool calls
    expect(calls).toBe(4);
  });

  it('sends the bearer token and MCP accept headers', async () => {
    let headers: Headers | undefined;
    const capture: typeof fetch = (async (url: string, init: RequestInit) => {
      headers ??= new Headers(init.headers);
      return rpc({ content: [{ type: 'text', text: '{}' }] })(url, init);
    }) as unknown as typeof fetch;

    await client(capture).callTool('networth_holdings', {});
    expect(headers!.get('Authorization')).toBe('Bearer AT');
    expect(headers!.get('Accept')).toMatch(/text\/event-stream/);
  });

  it('parses a JSON payload out of an MCP text content block', async () => {
    const result = await client(rpc({ content: [{ type: 'text', text: '{"holdings":[1,2]}' }] }))
      .callTool<{ holdings: number[] }>('networth_holdings', {});
    expect(result.holdings).toEqual([1, 2]);
  });

  it('reads a result delivered as an SSE stream', async () => {
    const sse: typeof fetch = (async (_url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (req.method === 'notifications/initialized') return new Response('', { status: 202 });
      const body = `event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0', id: req.id,
        result: req.method === 'initialize' ? {} : { content: [{ type: 'text', text: '{"via":"sse"}' }] },
      })}\n\n`;
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;

    const result = await client(sse).callTool<{ via: string }>('networth_holdings', {});
    expect(result.via).toBe('sse');
  });

  it('surfaces a JSON-RPC error rather than returning undefined', async () => {
    const failing: typeof fetch = (async (_url: string, init: RequestInit) => {
      const req = JSON.parse(String(init.body)) as { id?: number; method: string };
      if (req.method === 'notifications/initialized') return new Response('', { status: 202 });
      if (req.method === 'initialize') {
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'unknown tool' },
      }), { status: 200 });
    }) as unknown as typeof fetch;

    await expect(client(failing).callTool('nope', {})).rejects.toThrow(/unknown tool/);
  });
});