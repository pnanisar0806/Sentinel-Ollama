const MAX_MESSAGE = 4096;

/**
 * Escapes the characters Telegram's legacy Markdown treats as markup.
 *
 * The digest interpolates names straight out of the database — fund names like
 * "HDFC Mid Cap Fund -Direct Plan" and issuer names the sync supplies. One stray
 * `_`, `*`, backtick or `[` makes the whole message a 400, and the owner gets
 * NOTHING. Escape every value that is data rather than formatting.
 */
export const escapeMarkdown = (text: string): string =>
  text.replace(/([_*`[])/g, '\\$1');

export class Telegram {
  private readonly botToken: string;
  private readonly ownerChatId: string;
  private readonly dryRun: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: {
    botToken: string; ownerChatId: string; dryRun?: boolean; fetchImpl?: typeof fetch;
  }) {
    this.botToken = opts.botToken;
    this.ownerChatId = opts.ownerChatId;
    this.dryRun = opts.dryRun ?? false;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Single-user product: any other chat id is ignored outright (PRD §4.1, §12.3). */
  isOwner(chatId: string | number): boolean {
    return String(chatId) === this.ownerChatId;
  }

  async send(markdown: string): Promise<{ sent: boolean }> {
    if (this.dryRun) {
      console.log(`[dry-run] would send ${markdown.length} chars to ${this.ownerChatId}`);
      return { sent: false };
    }

    for (const chunk of split(markdown)) {
      const failure = await this.post(chunk, 'Markdown');
      if (failure === undefined) continue;

      // A parse error must never cost the owner the message. Escaping is the primary
      // defence; this is the backstop for anything it misses — the content matters far
      // more than the bold. Any OTHER failure (revoked token, blocked bot) stays loud.
      if (!/can't parse entities|parse entities|entity/i.test(failure)) {
        throw new Error(`Telegram sendMessage failed: ${failure}`);
      }
      const plain = await this.post(chunk, undefined);
      if (plain !== undefined) {
        throw new Error(`Telegram sendMessage failed even as plain text: ${plain}`);
      }
    }
    return { sent: true };
  }

  /** Returns undefined on success, or Telegram's own description on failure. */
  private async post(text: string, parseMode: 'Markdown' | undefined): Promise<string | undefined> {
    const res = await this.fetchImpl(
      `https://api.telegram.org/bot${this.botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.ownerChatId,
          text,
          ...(parseMode ? { parse_mode: parseMode } : {}),
          disable_web_page_preview: true,
        }),
      },
    );
    const body = (await res.json()) as { ok: boolean; description?: string };
    return body.ok ? undefined : (body.description ?? String(res.status));
  }
}

/**
 * Splits on line boundaries so tables and sections stay intact — but a single line
 * longer than the limit is hard-split rather than emitted whole. The previous version
 * pushed an EMPTY chunk and then an oversized one (measured [0, 5001] for a 5000-char
 * line); Telegram rejects both.
 */
function split(text: string): string[] {
  if (text.length <= MAX_MESSAGE) return [text];

  const chunks: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current.length > 0) chunks.push(current);
    current = '';
  };

  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > MAX_MESSAGE) flush();

    if (line.length + 1 > MAX_MESSAGE) {
      // One line longer than a whole message: hard-split it. Never push an empty
      // chunk, never push one over the limit.
      for (let i = 0; i < line.length; i += MAX_MESSAGE) {
        chunks.push(line.slice(i, i + MAX_MESSAGE));
      }
      continue;
    }
    current += `${line}\n`;
  }
  flush();
  return chunks;
}