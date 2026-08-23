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
  //
  // The prototype-only version of this check was ITSELF defeatable. `private get =
  // async <T>(path) => {...}` is a class FIELD, so it lives on the instance, not the
  // prototype - which is precisely why the old assertion could read ['fetch',
  // 'getHoldings'] while a third callable existed. A `placeOrder = async () => {...}`
  // written in the same style as the code already here would have been invisible.
  // The allowlist therefore covers the prototype AND the instance, every property
  // regardless of type.
  const READ_ONLY_SURFACE =
    ['accessToken', 'apiKey', 'fetch', 'fetchImpl', 'get', 'getHoldings', 'name'];

  const surfaceOf = (o: object): string[] => {
    const names = new Set([
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(o)),
      ...Object.getOwnPropertyNames(o),
    ]);
    names.delete('constructor');
    return [...names].sort();
  };

  it('exposes exactly the read-only surface - instance fields included', () => {
    const src = new KiteSource({ apiKey: 'k', accessToken: 'a' });
    expect(surfaceOf(src)).toEqual([...READ_ONLY_SURFACE].sort());
  });

  // Proves the allowlist above actually sees instance fields. If this ever fails, the
  // check has regressed to prototype-only and the guard is worthless again.
  it('would see a write method added as a class field', () => {
    class Rogue extends KiteSource {
      placeOrder = async () => 'order-id';
    }
    const rogue = new Rogue({ apiKey: 'k', accessToken: 'a' });
    expect(typeof (rogue as unknown as { placeOrder: unknown }).placeOrder).toBe('function');

    // The defect, pinned: a prototype-only scan does NOT see it. That is what the
    // shipped guard did, which is why it read ['fetch','getHoldings'] and passed.
    const protoOnly = Object.getOwnPropertyNames(Object.getPrototypeOf(rogue))
      .filter((m) => m !== 'constructor');
    expect(protoOnly).not.toContain('placeOrder');

    // The allowlist that covers the instance does see it, and rejects it.
    expect(surfaceOf(rogue)).toContain('placeOrder');
    expect(READ_ONLY_SURFACE).not.toContain('placeOrder');
  });

  // Belt and braces: the allowlist above governs the prototype, but a write path could
  // also be reached through a raw endpoint string. Kite's mutating endpoints all live
  // under /orders, /gtt and /positions, and the only HTTP verb this source may use is GET.
  it('contains no mutating endpoint or verb anywhere in the module', async () => {
    const source = await readFile('src/sources/kite.ts', 'utf8');
    expect(source).not.toMatch(/\/orders\b/);
    expect(source).not.toMatch(/\/gtt\b/);
    expect(source).not.toMatch(/method:\s*['"](POST|PUT|DELETE|PATCH)['"]/i);

    // Stronger than a denylist of endpoints someone remembered: every request path
    // in the module must be on the allowlist, so a new endpoint fails until it is
    // justified rather than only the ones already thought of.
    const paths = [...source.matchAll(/['\"`](\/[a-z0-9\/_-]+)['\"`]/gi)].map((m) => m[1]);
    expect([...new Set(paths)]).toEqual(['/portfolio/holdings']);
  });
});