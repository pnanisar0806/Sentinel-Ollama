import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseMfSips, RemoteIndmoneySource } from '../../src/sources/indmoney.js';
import type { McpClient } from '../../src/sources/mcp-client.js';

const fixture = JSON.parse(await readFile('tests/fixtures/indmoney-mf-sips-2026-10-14.json', 'utf8')) as {
  payload: { mf_sips: { name: string; isin: string; active_sips: { amount: number; fund_id: string; sip_id: string }[] }[] };
  _rateLimitedResponse: Record<string, unknown>;
};
const envelope = (p: unknown) => ({ result: JSON.stringify(p) });

describe('parseMfSips', () => {
  it('returns one row per active SIP, amounts in exact paise', () => {
    const rows = parseMfSips(envelope(fixture.payload));
    const expected = fixture.payload.mf_sips.flatMap((f) => f.active_sips.map((s) => ({
      sipId: s.sip_id, instrumentId: `IND:${s.fund_id}`, amountPaise: BigInt(s.amount) * 100n, isin: f.isin,
    })));
    expect(rows.map((r) => ({ sipId: r.sipId, instrumentId: r.instrumentId, amountPaise: r.amountPaise, isin: r.isin })))
      .toEqual(expected);
  });

  it('keeps the step-up exactly as given and converts the date to ISO', () => {
    const [nifty] = parseMfSips(envelope(fixture.payload));
    expect(nifty).toMatchObject({ stepUpRaw: 10, stepUpFreq: 'YEARLY', startDate: '2026-11-12', frequency: 'MONTHLY' });
  });

  it('a non-step-up SIP has a null step-up', () => {
    const p = structuredClone(fixture.payload) as { mf_sips: { active_sips: Record<string, unknown>[] }[] };
    p.mf_sips[0]!.active_sips[0]!['is_step_up_sip'] = false;
    expect(parseMfSips(envelope(p))[0]!.stepUpRaw).toBeNull();
  });

  it('an empty list is a real answer, not an error', () => {
    expect(parseMfSips(envelope({ mf_sips: [] }))).toEqual([]);
  });

  it.each([
    ['a throttle body', fixture._rateLimitedResponse],
    ['a missing list', { something: 'else' }],
  ])('refuses %s rather than reading it as no SIPs', (_label, payload) => {
    expect(() => parseMfSips(envelope(payload))).toThrow(/mf_sips/);
  });

  it('refuses holding_error even with an empty list: a partial answer is not "no SIPs"', () => {
    expect(() => parseMfSips(envelope({ mf_sips: [], holding_error: true }))).toThrow(/holding_error/);
  });

  it('refuses an unparseable envelope', () => {
    expect(() => parseMfSips({ nope: 1 })).toThrow(/mf_sips/);
  });

  it.each([
    ['a non-JSON result string', { result: 'not json' }],
    ['a JSON null result', { result: 'null' }],
  ])('refuses %s with an mf_sips error, not a raw crash', (_label, env) => {
    expect(() => parseMfSips(env)).toThrow(/mf_sips/);
  });

  it('refuses a non-integer or non-positive rupee amount', () => {
    for (const bad of [0, -5, 100.5, '14001']) {
      const p = structuredClone(fixture.payload) as { mf_sips: { active_sips: Record<string, unknown>[] }[] };
      p.mf_sips[0]!.active_sips[0]!['amount'] = bad;
      expect(() => parseMfSips(envelope(p))).toThrow(/amount/);
    }
  });

  it.each([
    ['sip_id', 'sip_id'],
    ['fund_id', 'fund_id'],
    ['sip_frequency', 'sip_frequency'],
  ])('refuses a SIP missing %s rather than inventing one', (_label, key) => {
    const p = structuredClone(fixture.payload) as { mf_sips: { active_sips: Record<string, unknown>[] }[] };
    delete p.mf_sips[0]!.active_sips[0]![key];
    expect(() => parseMfSips(envelope(p))).toThrow(new RegExp(key));
  });

  it('refuses a malformed start date', () => {
    const p = structuredClone(fixture.payload) as { mf_sips: { active_sips: Record<string, unknown>[] }[] };
    p.mf_sips[0]!.active_sips[0]!['sip_start_date'] = '2026-11-12';
    expect(() => parseMfSips(envelope(p))).toThrow(/start date/);
  });
});

describe('RemoteIndmoneySource.fetchSips', () => {
  it('calls mf_sips once and stamps as_of', async () => {
    const called: string[] = [];
    const client = { callTool: async (name: string) => { called.push(name); return envelope(fixture.payload); } } as unknown as McpClient;
    const { rows, asOf } = await new RemoteIndmoneySource({ client, spacingMs: 0 }).fetchSips();
    expect(called).toEqual(['mf_sips']);
    expect(rows).toHaveLength(3);
    expect(Number.isNaN(Date.parse(asOf))).toBe(false);
  });

  it('waits out one throttle on mf_sips too, and a second is fatal', async () => {
    const waits: number[] = [];
    const replies = [fixture._rateLimitedResponse, fixture.payload];
    const client = { callTool: async () => envelope(replies.shift()) } as unknown as McpClient;
    const s = new RemoteIndmoneySource({ client, spacingMs: 0, sleep: async (ms) => { waits.push(ms); } });
    expect((await s.fetchSips()).rows).toHaveLength(3);
    expect(waits).toEqual([((fixture._rateLimitedResponse['retry_after_seconds'] as number) + 1) * 1000]);

    const throttled = { callTool: async () => envelope(fixture._rateLimitedResponse) } as unknown as McpClient;
    await expect(new RemoteIndmoneySource({ client: throttled, spacingMs: 0, sleep: async () => {} }).fetchSips())
      .rejects.toThrow(/refused mf_sips: rate_limit_exceeded/);
  });

  it('caps a long retry_after at 120 s (+1) and still retries once', async () => {
    const waits: number[] = [];
    const replies = [{ ...fixture._rateLimitedResponse, retry_after_seconds: 3600 }, fixture.payload];
    const client = { callTool: async () => envelope(replies.shift()) } as unknown as McpClient;
    const s = new RemoteIndmoneySource({ client, spacingMs: 0, sleep: async (ms) => { waits.push(ms); } });
    expect((await s.fetchSips()).rows).toHaveLength(3);
    expect(waits).toEqual([121_000]);
  });
});
