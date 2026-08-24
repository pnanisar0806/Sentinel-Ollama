import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const MINIMAL = {
  TELEGRAM_BOT_TOKEN: 't',
  TELEGRAM_OWNER_CHAT_ID: '123',
  TOKEN_ENCRYPTION_KEY: 'aGVsbG93b3JsZGhlbGxvd29ybGRoZWxsb3dvcmxk', // base64 32 bytes
};

describe('env', () => {
  it('accepts a minimal local configuration', () => {
    const env = loadEnv(MINIMAL);
    expect(env.telegramOwnerChatId).toBe('123');
    expect(env.databaseUrl).toBeUndefined();
    expect(env.dryRun).toBe(false);
    expect(env.tokenEncryptionKey).toBe(MINIMAL.TOKEN_ENCRYPTION_KEY);
  });

  it('names the missing key rather than failing obscurely', () => {
    expect(() => loadEnv({}, ['all'])).toThrow(/TELEGRAM_BOT_TOKEN/);
  });

  it('names the missing TOKEN_ENCRYPTION_KEY', () => {
    expect(() => loadEnv({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_CHAT_ID: '1' }, ['all']))
      .toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it('treats DRY_RUN=1 as paper/no-send mode', () => {
    const env = loadEnv({ ...MINIMAL, DRY_RUN: '1' });
    expect(env.dryRun).toBe(true);
  });

  // A job must not be blocked on credentials it never reads. `pnpm indmoney:login`
  // needs only the encryption key; Telegram is unprovisioned in Phase 0.
  it('requires only the encryption key when a job asks for crypto alone', () => {
    const env = loadEnv({ TOKEN_ENCRYPTION_KEY: MINIMAL.TOKEN_ENCRYPTION_KEY }, ['crypto']);
    expect(env.tokenEncryptionKey).toBe(MINIMAL.TOKEN_ENCRYPTION_KEY);
    expect(env.telegramBotToken).toBeUndefined();
  });

  it('still names the missing TOKEN_ENCRYPTION_KEY under crypto alone', () => {
    expect(() => loadEnv({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_CHAT_ID: '1' }, ['crypto']))
      .toThrow(/TOKEN_ENCRYPTION_KEY/);
  });

  it('requires only Telegram when a job asks for telegram alone', () => {
    const env = loadEnv({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_CHAT_ID: '1' }, ['telegram']);
    expect(env.telegramOwnerChatId).toBe('1');
    expect(env.tokenEncryptionKey).toBeUndefined();
  });

  // The default was ['all'], which crashed both scheduled jobs on startup over
  // credentials neither reads. Demanding nothing by default is safe because a job
  // that needs a credential must name its purpose to get the narrowed type at all.
  it('demands nothing by default', () => {
    expect(() => loadEnv({})).not.toThrow();
    expect(loadEnv({}).telegramBotToken).toBeUndefined();
  });

  it("['all'] still demands every purpose's keys", () => {
    expect(() => loadEnv({ TOKEN_ENCRYPTION_KEY: MINIMAL.TOKEN_ENCRYPTION_KEY }, ['all']))
      .toThrow(/TELEGRAM_BOT_TOKEN/);
  });
});