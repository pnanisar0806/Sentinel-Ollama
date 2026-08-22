import { describe, expect, it } from 'vitest';
import { Telegram } from '../../src/notify/telegram.js';

const ok: typeof fetch = (async () =>
  new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;

describe('Telegram', () => {
  it('posts to the owner chat only', async () => {
    let seenBody: Record<string, unknown> = {};
    const capture: typeof fetch = (async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await new Telegram({ botToken: 'T', ownerChatId: '42', fetchImpl: capture }).send('hi');
    expect(seenBody.chat_id).toBe('42');
  });

  it('ignores commands from any other chat id (PRD 12.3)', () => {
    const tg = new Telegram({ botToken: 'T', ownerChatId: '42', fetchImpl: ok });
    expect(tg.isOwner('42')).toBe(true);
    expect(tg.isOwner(42)).toBe(true);
    expect(tg.isOwner('43')).toBe(false);
  });

  it('does not send in dry-run mode but reports what it would have sent', async () => {
    const tg = new Telegram({ botToken: 'T', ownerChatId: '42', dryRun: true, fetchImpl: () => {
      throw new Error('must not call the network in dry run');
    } });
    expect(await tg.send('hi')).toEqual({ sent: false });
  });

  it('surfaces a Telegram API error instead of failing silently', async () => {
    const bad: typeof fetch = (async () =>
      new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 })) as unknown as typeof fetch;
    await expect(new Telegram({ botToken: 'T', ownerChatId: '42', fetchImpl: bad }).send('hi'))
      .rejects.toThrow(/chat not found/);
  });

  it('splits a message longer than the 4096-character limit', async () => {
    let calls = 0;
    const counting: typeof fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await new Telegram({ botToken: 'T', ownerChatId: '42', fetchImpl: counting })
      .send('x\n'.repeat(3000));
    expect(calls).toBeGreaterThan(1);
  });
});