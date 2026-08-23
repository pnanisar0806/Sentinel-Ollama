import { describe, expect, it } from 'vitest';
import { Telegram, escapeMarkdown } from '../../src/notify/telegram.js';

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200 });
const parseError = () =>
  new Response(
    JSON.stringify({
      ok: false,
      error_code: 400,
      description: "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 42",
    }),
    { status: 400 },
  );

interface Sent { text: string; parse_mode?: string }

/** Records every outbound message; `fail` decides which attempts Telegram rejects. */
const recorder = (fail: (body: Sent, n: number) => boolean = () => false) => {
  const sent: Sent[] = [];
  let n = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Sent;
    sent.push(body);
    return fail(body, ++n) ? parseError() : ok();
  }) as unknown as typeof fetch;
  return { sent, fetchImpl };
};

const client = (fetchImpl: typeof fetch) =>
  new Telegram({ botToken: 't', ownerChatId: '99', fetchImpl });

/**
 * Review item 11: send() posted unescaped free text with parse_mode 'Markdown'. One
 * stray _ * ` or [ in an instrument name out of the database gives a 400, send()
 * throws, and the OWNER GETS NOTHING. MEMORY called this notifier "MarkdownV2-safe";
 * it was neither MarkdownV2 nor escaping.
 */
describe('escapeMarkdown', () => {
  // Only the four entity STARTERS are escaped. `]` is not special in Telegram's legacy
  // Markdown, and escaping it would render a literal backslash in some clients.
  it('escapes every character Telegram treats as markup', () => {
    expect(escapeMarkdown('ICICI_Pru *Large* `Cap` [Direct]'))
      .toBe('ICICI\\_Pru \\*Large\\* \\`Cap\\` \\[Direct]');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeMarkdown('Parag Parikh Flexi Cap Direct Growth'))
      .toBe('Parag Parikh Flexi Cap Direct Growth');
  });

  it('is safe on the real fund names that carry markup characters', () => {
    // A real holding: "HDFC Mid Cap Fund -Direct Plan - Growth Option"
    const escaped = escapeMarkdown('Nippon India ETF Nifty 50 BeES [NSE]_2026');
    expect(escaped).not.toMatch(/(?<!\\)[_*`[]/);
  });
});

describe('send never loses the message to a formatting error', () => {
  it('retries as plain text when Telegram rejects the markup', async () => {
    // Fail only the first, markup-parsed attempt.
    const { sent, fetchImpl } = recorder((b) => b.parse_mode !== undefined);
    const result = await client(fetchImpl).send('net worth is *up* 3_5%');

    expect(result.sent).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.parse_mode).toBe('Markdown');
    expect(sent[1]!.parse_mode).toBeUndefined();      // plain text retry
    expect(sent[1]!.text).toBe('net worth is *up* 3_5%'); // content intact
  });

  it('still throws when the failure is not about parsing', async () => {
    // A revoked token or a blocked bot must stay loud, not be retried into silence.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 })
    ) as unknown as typeof fetch;

    await expect(client(fetchImpl).send('hello')).rejects.toThrow(/Unauthorized/);
  });

  it('does not retry when the first attempt succeeds', async () => {
    const { sent, fetchImpl } = recorder();
    await client(fetchImpl).send('all good');
    expect(sent).toHaveLength(1);
  });
});

/**
 * Review item 12: the chunker emitted an empty chunk AND an oversized chunk when a
 * single line exceeded 4096 — measured [0, 5001] for a 5000-char line. Telegram
 * rejects both.
 */
describe('chunking survives a single oversized line', () => {
  const lengths = async (text: string): Promise<number[]> => {
    const { sent, fetchImpl } = recorder();
    await client(fetchImpl).send(text);
    return sent.map((s) => s.text.length);
  };

  it('emits no empty chunk and nothing over the limit', async () => {
    const sizes = await lengths('x'.repeat(5000));
    expect(sizes.every((n) => n > 0)).toBe(true);
    expect(sizes.every((n) => n <= 4096)).toBe(true);
  });

  it('preserves the whole message across chunks', async () => {
    const text = `${'a'.repeat(5000)}\nshort tail`;
    const { sent, fetchImpl } = recorder();
    await client(fetchImpl).send(text);
    expect(sent.map((s) => s.text).join('').replace(/\n/g, ''))
      .toBe(text.replace(/\n/g, ''));
  });

  it('still splits on line boundaries when lines are normal', async () => {
    const line = `${'y'.repeat(100)}\n`;
    const sizes = await lengths(line.repeat(60)); // ~6060 chars, all short lines
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.every((n) => n > 0 && n <= 4096)).toBe(true);
  });

  it('sends a short message as exactly one chunk', async () => {
    expect(await lengths('one line')).toEqual([8]);
  });
});
