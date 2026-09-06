import { createHash, randomBytes } from 'node:crypto';
import type { Db } from '../../src/db/client.js';

/**
 * Kite Connect v3 login flow — the browser sibling of `pnpm indmoney:login`,
 * but through Kite's own endpoints (there is no Kite MCP server in this setup):
 *
 *   1. Browser → GET /api/kite/login → redirect to the Kite Connect login page.
 *   2. Owner authenticates on Kite's page; Kite redirects to the REGISTERED
 *      redirect URI (KITE_REDIRECT_URI defaulting to localhost) with a
 *      `request_token`, echoing the `state` we put in `redirect_params`.
 *   3. Callback exchanges `request_token` for an `access_token` via
 *      POST https://api.kite.trade/session/token (checksum = sha256(api_key +
 *      request_token + api_secret)). The token is stored encrypted at rest with
 *      the same AES-256-GCM scheme as INDmoney's, then holdings are pulled with
 *      KiteSource and written as a `kite` snapshot exactly like `pnpm sync`.
 *
 * The PRD security model is preserved: the owner performs the login (human
 * unlock), no password/TOTP secret ever exists here, and the access token is
 * only kept so the just-authenticated session can write the snapshot.
 */

export const KITE_LOGIN_BASE = 'https://kite.zerodha.com/connect/login';
export const KITE_API_BASE = 'https://api.kite.trade';

/** The redirect URI that must be registered for this api_key in the Kite
 *  Connect developer console. Passed as env so a deployed host can differ. */
export function kiteRedirectUri(): string {
  return process.env.KITE_REDIRECT_URI ?? 'http://localhost:3001/api/kite/callback';
}

/** `redirect_params` is a URL-encoded query string Kite echoes onto the
 *  registered redirect URL; it carries our CSRF `state` beside `request_token`. */
export function kiteLoginUrl(apiKey: string, state: string): string {
  return `${KITE_LOGIN_BASE}?v=3&api_key=${encodeURIComponent(apiKey)}` +
    `&redirect_params=${encodeURIComponent(`state=${state}`)}`;
}

// Single-user local app: a module-level nonce store with an expiry is sufficient.
// A server restart invalidates any in-flight login — the owner just clicks again.
const PENDING: Map<string, number> = new Map();
const STATE_TTL_MS = 10 * 60_000;

export function beginKiteLogin(apiKey: string): string {
  for (const [state, at] of PENDING) if (Date.now() - at > STATE_TTL_MS) PENDING.delete(state);
  const state = randomBytes(16).toString('hex');
  PENDING.set(state, Date.now());
  return state;
}

/** True iff `state` came from a live beginKiteLogin; consumed on first use. */
export function consumeKiteState(state: string | null): boolean {
  if (!state) return false;
  const at = PENDING.get(state);
  if (at === undefined) return false;
  PENDING.delete(state);
  return Date.now() - at <= STATE_TTL_MS;
}

export interface KiteSession {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  userId: string | null;
}

/** POST /session/token — one-time request_token → access_token (expires at
 *  06:00 IST next morning, the broker's regulatory session boundary). */
export async function exchangeKiteRequestToken(
  apiKey: string,
  apiSecret: string,
  requestToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KiteSession> {
  const checksum = createHash('sha256')
    .update(apiKey + requestToken + apiSecret)
    .digest('hex');
  const res = await fetchImpl(`${KITE_API_BASE}/session/token`, {
    method: 'POST',
    headers: {
      'X-Kite-Version': '3',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      api_key: apiKey,
      request_token: requestToken,
      checksum,
    }).toString(),
  });
  const body = (await res.json().catch(() => null)) as {
    status?: string; message?: string; error_description?: string;
    data?: { access_token?: string; refresh_token?: string; user_id?: string; expires_in?: number };
    access_token?: string; refresh_token?: string; user_id?: string; expires_in?: number;
  } | null;
  // Kite may nest under `data` or return a flat body; accept whichever is present.
  const data = (body?.data ?? body) as NonNullable<typeof body>;
  if (!res.ok || !data || !data.access_token) {
    throw new Error(
      `Kite token exchange failed: ${body?.error_description ?? body?.message ?? `HTTP ${res.status}`}`,
    );
  }
  const expiresInS = typeof data.expires_in === 'number' ? data.expires_in : undefined;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    // If the response states a lifetime, trust it; otherwise the 06:00 IST next
    // morning boundary (00:30 UTC) — Kite did not always return expires_in.
    expiresAt: expiresInS
      ? new Date(Date.now() + expiresInS * 1000).toISOString()
      : nextSixAmUtc().toISOString(),
    userId: data.user_id ?? null,
  };
}

function nextSixAmUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 30, 0));
}

export interface KiteConnection {
  connected: boolean;
  expiresAt: string | null;
}

/** Did a previous login leave an unexpired access token in oauth_tokens? */
export async function readKiteConnection(db: Db): Promise<KiteConnection> {
  const [row] = await db.query<{ expires_at: string | Date }>(
    'select expires_at from oauth_tokens where provider = $1',
    ['kite'],
  );
  if (!row) return { connected: false, expiresAt: null };
  const expiresAt = row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at);
  return { connected: Date.parse(expiresAt) > Date.now(), expiresAt };
}