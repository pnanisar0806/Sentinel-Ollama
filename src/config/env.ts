export interface Env {
  databaseUrl: string | undefined;
  telegramBotToken: string | undefined;
  telegramOwnerChatId: string | undefined;
  kiteApiKey: string | undefined;
  kiteAccessToken: string | undefined;
  indmoneySnapshotPath: string;
  tokenEncryptionKey: string | undefined;
  dryRun: boolean;
}

/**
 * What a job actually reads. A job must not be blocked on credentials it never
 * touches: `pnpm indmoney:login` needs the encryption key, and Telegram is
 * unprovisioned in Phase 0.
 */
export type Purpose = 'crypto' | 'telegram' | 'all';

/** `loadEnv(..., ['crypto'])` has already thrown if the key is absent, so it is a `string`. */
export interface CryptoEnv extends Env {
  tokenEncryptionKey: string;
}

/** `loadEnv(..., ['telegram'])` has already thrown if the keys are absent, so they are `string`. */
export interface TelegramEnv extends Env {
  telegramBotToken: string;
  telegramOwnerChatId: string;
}

const KEYS = {
  crypto: ['TOKEN_ENCRYPTION_KEY'],
  telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_OWNER_CHAT_ID'],
} as const satisfies Record<Exclude<Purpose, 'all'>, readonly string[]>;

function demanded(purposes: Purpose[]): Set<string> {
  const names = purposes.includes('all')
    ? (Object.keys(KEYS) as Exclude<Purpose, 'all'>[])
    : purposes.filter((p): p is Exclude<Purpose, 'all'> => p !== 'all');
  return new Set(names.flatMap((p) => KEYS[p] as readonly string[]));
}

function read(
  source: Record<string, string | undefined>,
  key: string,
  need: Set<string>,
): string | undefined {
  const value = source[key];
  if (need.has(key) && !value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export function loadEnv(
  source: Record<string, string | undefined>,
  purposes: ['crypto'],
): CryptoEnv;
export function loadEnv(
  source: Record<string, string | undefined>,
  purposes: ['telegram'],
): TelegramEnv;
export function loadEnv(
  source?: Record<string, string | undefined>,
  purposes?: Purpose[],
): Env;
export function loadEnv(
  source: Record<string, string | undefined> = process.env,
  purposes: Purpose[] = ['all'],
): Env {
  const need = demanded(purposes);
  return {
    databaseUrl: source.DATABASE_URL,
    telegramBotToken: read(source, 'TELEGRAM_BOT_TOKEN', need),
    telegramOwnerChatId: read(source, 'TELEGRAM_OWNER_CHAT_ID', need),
    kiteApiKey: source.KITE_API_KEY,
    kiteAccessToken: source.KITE_ACCESS_TOKEN,
    indmoneySnapshotPath: source.INDMONEY_SNAPSHOT_PATH ?? 'data/indmoney-snapshot.json',
    tokenEncryptionKey: read(source, 'TOKEN_ENCRYPTION_KEY', need),
    dryRun: source.DRY_RUN === '1' || source.DRY_RUN === 'true',
  };
}
