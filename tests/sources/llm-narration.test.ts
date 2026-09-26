import { describe, expect, it } from 'vitest';
import { DEFAULT_NARRATION_MODEL, narrate } from '../../src/sources/llm-narration.js';

describe('narrate', () => {
  it('uses the default model when the configured one is blank', async () => {
    // An unset GitHub Actions variable interpolates to '', not undefined. `??` let that
    // through as `model: ""`, OpenRouter refused it, and every weekly report since the
    // key was added went out with no narration and no error anywhere.
    let sent: { model?: string } = {};
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'prose' } }] }) };
    }) as unknown as typeof fetch;
    const out = await narrate({ apiKey: 'k', model: '', fetchImpl, bullets: ['b'], engineJson: '{}' });
    expect(sent.model).toBe(DEFAULT_NARRATION_MODEL);
    expect(out).toBe('prose');
  });
});
