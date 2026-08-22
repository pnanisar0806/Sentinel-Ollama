const MAX_MESSAGE = 4096;

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
      const res = await this.fetchImpl(
        `https://api.telegram.org/bot${this.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: this.ownerChatId,
            text: chunk,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
          }),
        },
      );
      const body = (await res.json()) as { ok: boolean; description?: string };
      if (!body.ok) throw new Error(`Telegram sendMessage failed: ${body.description ?? res.status}`);
    }
    return { sent: true };
  }
}

/** Splits on line boundaries so tables and sections stay intact. */
function split(text: string): string[] {
  if (text.length <= MAX_MESSAGE) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > MAX_MESSAGE) {
      chunks.push(current);
      current = '';
    }
    current += `${line}\n`;
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}