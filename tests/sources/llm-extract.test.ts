import { describe, expect, it } from 'vitest';
import { extractHoldingsFromImage, LLM_MODEL_CHAIN, parseModelJson } from '../../src/sources/llm-extract.js';

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
      fetchImpl, apiKey: 'K', images: [{ base64: 'QQ==', mimeType: 'image/jpeg' }], positions: POSITIONS,
    });

    expect(captured!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const headers = new Headers(captured!.init.headers);
    expect(headers.get('Authorization')).toBe('Bearer K');
    const body = JSON.parse(String(captured!.init.body));
    expect(body.model).toBe(LLM_MODEL_CHAIN[0]);
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

  it('sends every page of a multi-page statement in one request', async () => {
    let captured: { init: RequestInit } | null = null;
    const fetchImpl = (async (_url: string | URL | RequestInfo, init?: RequestInit) => {
      captured = { init: init! };
      return okResponse('{"items":[]}');
    }) as typeof fetch;

    await extractHoldingsFromImage({
      fetchImpl, apiKey: 'K',
      images: [
        { base64: 'UAGE1', mimeType: 'image/jpeg' },
        { base64: 'UAGE2', mimeType: 'image/png' },
      ],
      positions: POSITIONS,
    });

    const body = JSON.parse(String(captured!.init.body));
    const parts = body.messages[0].content.filter((c: { type: string }) => c.type === 'image_url');
    expect(parts).toHaveLength(2);
    expect(parts[0].image_url.url).toBe('data:image/jpeg;base64,UAGE1');
    expect(parts[1].image_url.url).toBe('data:image/png;base64,UAGE2');
  });

  it('demotes an out-of-range line to unmatched instead of guessing', async () => {
    const fetchImpl = (async () => okResponse(
      '{"items":[{"line":99,"name":"Mystery","totalCostInr":"100"}]}',
    )) as typeof fetch;
    const proposals = await extractHoldingsFromImage({
      fetchImpl, apiKey: 'K', images: [{ base64: 'QQ==', mimeType: 'image/jpeg' }], positions: POSITIONS,
    });
    expect(proposals[0]!.line).toBeNull();
  });

  it('drops items whose cost is unreadable — never invents one (FR-02)', async () => {
    const fetchImpl = (async () => okResponse(
      '{"items":[{"line":1,"name":"A","totalCostInr":"abc"},{"line":1,"name":"B","totalCostInr":"0"},{"line":1,"name":"C","totalCostInr":"500"}]}',
    )) as typeof fetch;
    const proposals = await extractHoldingsFromImage({
      fetchImpl, apiKey: 'K', images: [{ base64: 'QQ==', mimeType: 'image/jpeg' }], positions: POSITIONS,
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.costPaise).toBe(50_000n);
  });

  it('surfaces a provider error by name', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: { message: 'model is broken' } }), { status: 500 })
    ) as typeof fetch;
    await expect(extractHoldingsFromImage({
      fetchImpl, apiKey: 'K', images: [{ base64: 'QQ==', mimeType: 'image/jpeg' }], positions: POSITIONS,
    })).rejects.toThrow(/model is broken/);
  });

  it('walks the model chain when the free pool is saturated (429)', async () => {
    const calledModels: string[] = [];
    const fetchImpl = (async (_url: string | URL | RequestInfo, init?: RequestInit) => {
      const model = (JSON.parse(String(init!.body)) as { model: string }).model;
      calledModels.push(model);
      if (calledModels.length <= 2) {
        return new Response(JSON.stringify({
          error: { message: 'Provider returned error', code: 429,
            metadata: { raw: 'temporarily rate-limited upstream' } },
        }), { status: 429 });
      }
      return okResponse('{"items":[{"line":2,"name":"Gold","totalCostInr":"63000"}]}');
    }) as typeof fetch;

    const proposals = await extractHoldingsFromImage({
      fetchImpl, apiKey: 'K', images: [{ base64: 'QQ==', mimeType: 'image/jpeg' }], positions: POSITIONS,
    });

    // primary retried once, then the chain moved to the next free pool
    expect(calledModels[0]).toBe(LLM_MODEL_CHAIN[0]);
    expect(calledModels[1]).toBe(LLM_MODEL_CHAIN[0]);
    expect(calledModels[2]).toBe(LLM_MODEL_CHAIN[1]);
    expect(proposals[0]!.costPaise).toBe(6_300_000n);
  });
});

/**
 * OpenRouter retired `minimax/minimax-m3:free` on 2026-09-21 and the /import page died
 * with `OpenRouter failed: {"message":"This model is unavailable for free...","code":404}`.
 * The chain walked only on 429, so a 404 threw and the five healthy models behind it
 * were never tried — a fallback chain that gave up on the second most likely failure it
 * exists to survive.
 */
describe('the model chain survives a retired model', () => {
  const ok = {
    ok: true,
    json: async () => ({ choices: [{ message: { content: '{"items":[]}' } }] }),
  } as unknown as Response;
  const gone = (model: string) => ({
    ok: false,
    status: 404,
    json: async () => ({
      error: { code: 404, message: `${model} is unavailable for free.` },
    }),
  } as unknown as Response);

  it('moves to the next model on a 404 instead of abandoning the chain', async () => {
    const tried: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const model = JSON.parse(String(init.body)).model as string;
      tried.push(model);
      return model === LLM_MODEL_CHAIN[0] ? gone(model) : ok;
    }) as unknown as typeof fetch;

    await expect(extractHoldingsFromImage({
      fetchImpl, apiKey: 'k', images: [{ base64: 'x', mimeType: 'image/png' }], positions: [],
    })).resolves.toEqual([]);
    expect(tried).toEqual([LLM_MODEL_CHAIN[0], LLM_MODEL_CHAIN[1]]);
  });

  it('names every model it tried when the whole chain is gone', async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      gone(JSON.parse(String(init.body)).model as string)) as unknown as typeof fetch;

    // The old message reported only whichever model happened to be last.
    const err = await extractHoldingsFromImage({
      fetchImpl, apiKey: 'k', images: [{ base64: 'x', mimeType: 'image/png' }], positions: [],
    }).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    for (const model of LLM_MODEL_CHAIN) expect(err!.message).toContain(model);
  });
});

/**
 * A model replied with a SPACE before the fence and /import died with
 * `Unexpected token '`', " ```json { "... is not valid JSON`. The old strip anchored on
 * `^```, so the fence had to be the very first character. The free pool is six
 * different models with six habits.
 */

const BT = '```';
const body = '{"items":[]}';

/**
 * A model replied with a SPACE before the fence and /import died with
 * `Unexpected token '`', " ```json { "... is not valid JSON`. The old strip anchored the
 * fence to the very first character. The free pool is six models with six habits.
 */
describe('parseModelJson', () => {
  it('reads a fence that is not the first character', () => {
    expect(parseModelJson(` ${BT}json\n${body}\n${BT}`)).toEqual({ items: [] });
  });

  it('reads a bare fence with no language tag', () => {
    expect(parseModelJson(`${BT}\n${body}\n${BT}`)).toEqual({ items: [] });
  });

  it('reads unfenced JSON', () => {
    expect(parseModelJson(body)).toEqual({ items: [] });
    expect(parseModelJson(`  ${body}  `)).toEqual({ items: [] });
  });

  it('ignores prose the model put around the block', () => {
    expect(parseModelJson(`Here is the data:\n${BT}json\n${body}\n${BT}\nHope that helps.`))
      .toEqual({ items: [] });
  });

  it('still throws on content that holds no JSON at all', () => {
    expect(() => parseModelJson('I cannot read this image.')).toThrow();
  });
});
