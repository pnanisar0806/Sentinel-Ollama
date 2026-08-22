import { describe, expect, it } from 'vitest';
import { fetchUsdInr } from '../../src/sources/fx.js';

const stub = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

describe('fetchUsdInr', () => {
  it('returns the rate, its date and its source', async () => {
    const r = await fetchUsdInr({
      fetchImpl: stub({ date: '2026-08-12', rates: { INR: 95.42 } }),
    });
    expect(r.rate).toBeCloseTo(95.42, 4);
    expect(r.asOf).toBe('2026-08-12');
    expect(r.source).toMatch(/\w/);
  });

  it('rejects an implausible rate rather than corrupting NOW valuation', async () => {
    await expect(fetchUsdInr({ fetchImpl: stub({ date: '2026-08-12', rates: { INR: 0 } }) }))
      .rejects.toThrow(/implausible/i);
    await expect(fetchUsdInr({ fetchImpl: stub({ date: '2026-08-12', rates: { INR: 900 } }) }))
      .rejects.toThrow(/implausible/i);
  });
});