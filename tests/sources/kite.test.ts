import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { KiteSource } from '../../src/sources/kite.js';

const fixture = JSON.parse(await readFile('tests/fixtures/kite-holdings.json', 'utf8'));

const stubFetch = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('KiteSource', () => {
  it('maps holdings to SourceRows valued at last price', async () => {
    const src = new KiteSource({ apiKey: 'k', accessToken: 'a', fetchImpl: stubFetch(fixture) });
    const { rows } = await src.fetch();
    const bees = rows.find((r) => r.instrumentId === 'NSE:NIFTYBEES')!;
    expect(bees.valuePaise).toBe(9_500_000n); // 380 * 250.00 = 95,000.00
    expect(bees.account).toBe('zerodha');
  });

  it('reports a zero average price as unknown cost, never as 0 (FR-02)', async () => {
    const src = new KiteSource({ apiKey: 'k', accessToken: 'a', fetchImpl: stubFetch(fixture) });
    const { rows } = await src.fetch();
    expect(rows.find((r) => r.instrumentId === 'NSE:TATASTEEL')!.avgCostPaise).toBeNull();
    expect(rows.find((r) => r.instrumentId === 'NSE:GOLDBEES')!.avgCostPaise).not.toBeNull();
  });

  it('sends the Kite authorization header and API version', async () => {
    let seen: Request | undefined;
    const capture: typeof fetch = (async (url: string, init: RequestInit) => {
      seen = new Request(url, init);
      return new Response(JSON.stringify(fixture), { status: 200 });
    }) as unknown as typeof fetch;

    await new KiteSource({ apiKey: 'k', accessToken: 'a', fetchImpl: capture }).fetch();
    expect(seen!.headers.get('Authorization')).toBe('token k:a');
    expect(seen!.headers.get('X-Kite-Version')).toBe('3');
  });

  it('throws a named error on a broker error rather than returning empty holdings', async () => {
    const src = new KiteSource({
      apiKey: 'k', accessToken: 'expired',
      fetchImpl: stubFetch({ status: 'error', message: 'Invalid access token' }, 403),
    });
    await expect(src.fetch()).rejects.toThrow(/Invalid access token/);
  });

  // An earlier version asserted only `.not.toContain('placeOrder')`. That is a check on
  // one NAME, and the constraint is about CAPABILITY: `submitOrder`, `createOrder`,
  // `modifyGtt`, `exitPosition` would all have sailed through it. CLAUDE.md is explicit
  // that trading paths are "absent code paths, not disabled features", so the guard has
  // to be an exhaustive allowlist - anything not on it fails, including methods nobody
  // has thought of yet.
  //
  // If you are here because you added a legitimate read method and this test failed:
  // that is the test working. Add it to the list deliberately, and only after checking it
  // cannot mutate broker state.
  it('exposes exactly the read-only surface and nothing else', () => {
    const src = new KiteSource({ apiKey: 'k', accessToken: 'a' });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(src))
      .filter((m) => m !== 'constructor')
      .sort();
    expect(methods).toEqual(['fetch', 'getHoldings'].sort());
  });

  // Belt and braces: the allowlist above governs the prototype, but a write path could
  // also be reached through a raw endpoint string. Kite's mutating endpoints all live
  // under /orders, /gtt and /positions, and the only HTTP verb this source may use is GET.
  it('contains no mutating endpoint or verb anywhere in the module', async () => {
    const source = await readFile('src/sources/kite.ts', 'utf8');
    expect(source).not.toMatch(/\/orders\b/);
    expect(source).not.toMatch(/\/gtt\b/);
    expect(source).not.toMatch(/method:\s*['"](POST|PUT|DELETE|PATCH)['"]/i);
  });
});