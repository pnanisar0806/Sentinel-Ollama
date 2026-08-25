import { describe, expect, it } from 'vitest';
import { extractHoldingsFromImage } from '../../src/sources/llm-extract.js';

const POSITIONS = [
  { name: 'Tata Motors Ltd', instrumentId: 'IND:INDS01789', account: 'zerodha' },
  { name: 'Zerodha Gold ETF', instrumentId: 'IND:INDS29570', account: 'zerodha' },
];

const okResponse = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe('extractHoldingsFromImage', () => {
  it('calls OpenRouter with the model, key, image and the numbered portfolio list', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | RequestInfo, init?: RequestInit) => {
      captured = { url: String(url), init: init! };
      return okResponse('```json\n{"items":[{"line":1,"name":"Tata Motors","totalCostInr":"47255.50","confidence":"high"}]}\n```');
    }) as typeof fetch;

    const proposals = await extractHoldingsFromImage({
      fetchImpl, apiKey: 'K', imageBase64: 'QQ==', imageMimeType: 'image/jpeg', positions: POSITIONS,
    });

    expect(captured!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = new Headers(captured!.init.headers);
    expect(headers.get('Authorization')).toBe('Bearer K');
    const body = JSON.parse(String(captured!.init.body));
    expect(body.model).toBe('google/gemma-4-31b-it:free');
    expect(body.messages[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QQ==' } }),
    ]));
    const prompt = body.messages[0].content[0].text as string;
    expect(prompt).toContain('1. Tata Motors Ltd');
    expect(prompt).toContain('2. Zerodha Gold ETF');

    // LLM lines are 1-based against the displayed list; internally 0-based.
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.line).toBe(0);
    expect(proposals[0]!.costPaise).toBe(4_725_550n);
    expect(proposals[0]!.confidence).toBe('high');
  });

  it('demotes an out-of-range line to unmatched instead of guessing', async () => {
    const fetchImpl = (async () => okResponse(
      '{"items":[{"line":99,"name":"Mystery","totalCostInr":"100"}]}',
    )) as typeof fetch;
    const proposals = await extractHoldingsFromImage({
      fetchImpl, apiKey: 'K', imageBase64: 'QQ==', imageMimeType: 'image/jpeg', positions: POSITIONS,
    });
    expect(proposals[0]!.line).toBeNull();
  });

  it('drops items whose cost is unreadable — never invents one (FR-02)', async () => {
    const fetchImpl = (async () => okResponse(
      '{"items":[{"line":1,"name":"A","totalCostInr":"abc"},{"line":1,"name":"B","totalCostInr":"0"},{"line":1,"name":"C","totalCostInr":"500"}]}',
    )) as typeof fetch;
    const proposals = await extractHoldingsFromImage({
      fetchImpl, apiKey: 'K', imageBase64: 'QQ==', imageMimeType: 'image/jpeg', positions: POSITIONS,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.costPaise).toBe(50_000n);
  });

  it('surfaces a provider error by name', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 })
    ) as typeof fetch;
    await expect(extractHoldingsFromImage({
      fetchImpl, apiKey: 'K', imageBase64: 'QQ==', imageMimeType: 'image/jpeg', positions: POSITIONS,
    })).rejects.toThrow(/rate limited/);
  });
});
