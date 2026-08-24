import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db/client.js';

export interface AsMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  scope: string;
}

/** Thrown when only a human can fix it: the owner must re-run `pnpm indmoney:login`. */
export class ReauthRequired extends Error {
  constructor(public readonly provider: string, reason: string) {
    super(`${provider} needs re-authentication: ${reason}. Run: pnpm ${provider}:login`);
    this.name = 'ReauthRequired';
  }
}

const b64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * RFC 8414 discovery, validated rather than merely parsed.
 *
 * This used to fetch a URL and cast the body. Every endpoint in that document is a
 * place we later send the authorization code, the PKCE verifier and the client secret,
 * so a document that redirects them elsewhere is a credential leak. RFC 8414 section
 * 3.3 requires the issuer to match; the origin and https checks are what stop the
 * endpoints wandering off it.
 */
export async function discoverMetadata(
  issuer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AsMetadata> {
  const base = issuer.replace(/\/$/, '');
  if (!base.startsWith('https://')) {
    throw new Error(`OAuth issuer must be https, got ${issuer}`);
  }

  const res = await fetchImpl(`${base}/.well-known/oauth-authorization-server`);
  if (!res.ok) throw new Error(`OAuth discovery failed for ${issuer}: HTTP ${res.status}`);
  const md = (await res.json()) as AsMetadata;

  // Compared with trailing slashes stripped from both sides. The security property is
  // "this document is for the issuer we asked about", not byte-equality — real servers
  // vary on the trailing slash and rejecting on that alone is a false positive.
  if ((md.issuer ?? '').replace(/\/$/, '') !== base) {
    throw new Error(
      `OAuth issuer mismatch: document declares '${md.issuer}', requested '${base}' (RFC 8414 §3.3)`,
    );
  }

  const origin = new URL(base).origin;
  const sameOrigin = (name: keyof AsMetadata, required: boolean): void => {
    const value = md[name];
    if (value === undefined) {
      if (required) throw new Error(`OAuth metadata for ${base} has no ${name}`);
      return;
    }
    if (typeof value !== 'string' || !value.startsWith('https://') || new URL(value).origin !== origin) {
      throw new Error(`OAuth ${name} must be https on the issuer's origin (${origin}), got '${String(value)}'`);
    }
  };
  sameOrigin('authorization_endpoint', true);
  sameOrigin('token_endpoint', true);
  sameOrigin('registration_endpoint', false);

  return md;
}

/**
 * The granted scope must not exceed what was asked for.
 *
 * MEMORY recorded "read-only is enforced by the token's scope", but nothing ever
 * compared the two. A provider that upgrades the grant — or a client id that turns out
 * to be bound to a broader scope — went unnoticed, and the only thing standing between
 * this agent and a write-capable token is that comparison.
 *
 * A NARROWER grant is fine: the provider may always give less.
 */
export function assertGrantedScope(granted: string, requested: readonly string[]): void {
  const asked = new Set(requested);
  const extra = granted.split(/\s+/).filter((s) => s.length > 0 && !asked.has(s));
  if (extra.length > 0) {
    throw new Error(
      `OAuth grant exceeds the requested scope: got [${extra.join(', ')}] ` +
      `beyond [${requested.join(', ')}]. Refusing a token with more authority than asked for.`,
    );
  }
}

/** RFC 7591 dynamic client registration — INDmoney exposes this, so no manual app setup. */
export async function registerClient(
  md: AsMetadata,
  redirectUri: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ clientId: string; clientSecret?: string }> {
  if (!md.registration_endpoint) {
    throw new Error(`${md.issuer} does not support dynamic client registration`);
  }
  const res = await fetchImpl(md.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Sentinel (personal)',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }),
  });
  const body = (await res.json()) as { client_id?: string; client_secret?: string; error?: string };
  if (!res.ok || !body.client_id) {
    throw new Error(`client registration failed: ${body.error ?? res.status}`);
  }
  return body.client_secret
    ? { clientId: body.client_id, clientSecret: body.client_secret }
    : { clientId: body.client_id };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(64));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

export function authorizeUrl(
  md: AsMetadata,
  opts: { clientId: string; redirectUri: string; challenge: string; scopes: string[]; state: string },
): string {
  const url = new URL(md.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', opts.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', opts.scopes.join(' '));
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', opts.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function postToken(
  md: AsMetadata,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenSet> {
  const res = await fetchImpl(md.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const body = (await res.json()) as {
    access_token?: string; refresh_token?: string; expires_in?: number;
    scope?: string; error?: string; error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description ?? body.error ?? `token endpoint HTTP ${res.status}`);
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000).toISOString(),
    scope: body.scope ?? '',
  };
}

export const exchangeCode = (
  md: AsMetadata,
  opts: { code: string; clientId: string; clientSecret?: string; redirectUri: string; verifier: string; fetchImpl?: typeof fetch },
): Promise<TokenSet> =>
  postToken(md, {
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
    ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
  }, opts.fetchImpl ?? fetch);

export const refreshTokens = (
  md: AsMetadata,
  opts: { refreshToken: string; clientId: string; clientSecret?: string; fetchImpl?: typeof fetch },
): Promise<TokenSet> =>
  postToken(md, {
    grant_type: 'refresh_token',
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    ...(opts.clientSecret ? { client_secret: opts.clientSecret } : {}),
  }, opts.fetchImpl ?? fetch);

// --- encryption at rest (AES-256-GCM: iv | tag | ciphertext) ---

function encrypt(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

function decrypt(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8');
}

export async function saveTokens(
  db: Db, provider: string, tokens: TokenSet, key: Buffer,
): Promise<void> {
  await db.query(
    `insert into oauth_tokens (provider, access_token_enc, refresh_token_enc, expires_at, scope, updated_at)
     values ($1,$2,$3,$4,$5, now())
     on conflict (provider) do update set access_token_enc = excluded.access_token_enc,
       refresh_token_enc = excluded.refresh_token_enc, expires_at = excluded.expires_at,
       scope = excluded.scope, updated_at = now()`,
    [provider, encrypt(tokens.accessToken, key),
     tokens.refreshToken ? encrypt(tokens.refreshToken, key) : null,
     tokens.expiresAt, tokens.scope],
  );
}

export async function loadTokens(db: Db, provider: string, key: Buffer): Promise<TokenSet | null> {
  const [row] = await db.query<{
    access_token_enc: Uint8Array; refresh_token_enc: Uint8Array | null;
    expires_at: string; scope: string;
  }>('select access_token_enc, refresh_token_enc, expires_at, scope from oauth_tokens where provider = $1',
    [provider]);
  if (!row) return null;
  return {
    accessToken: decrypt(Buffer.from(row.access_token_enc), key),
    refreshToken: row.refresh_token_enc ? decrypt(Buffer.from(row.refresh_token_enc), key) : null,
    expiresAt: typeof row.expires_at === 'string' ? row.expires_at : new Date(row.expires_at).toISOString(),
    scope: row.scope,
  };
}

// --- client secret encryption (same scheme as token encryption) ---

export async function saveClientSecret(
  db: Db, provider: string, clientSecret: string, key: Buffer,
): Promise<void> {
  await db.query(
    `insert into oauth_clients (provider, issuer, client_id, client_secret_enc, redirect_uri)
     values ($1, $2, $3, $4, $5)
     on conflict (provider) do update set client_secret_enc = excluded.client_secret_enc`,
    [provider, '', '', encrypt(clientSecret, key), '']
  );
}

export async function loadClientSecret(db: Db, provider: string, key: Buffer): Promise<string | null> {
  const [row] = await db.query<{ client_secret_enc: Uint8Array | null }>(
    'select client_secret_enc from oauth_clients where provider = $1',
    [provider]
  );
  if (!row || !row.client_secret_enc) return null;
  return decrypt(Buffer.from(row.client_secret_enc), key);
}

const SKEW_MS = 60_000;

export async function ensureAccessToken(
  db: Db,
  provider: string,
  opts: {
    md: AsMetadata; clientId: string; clientSecret?: string; key: Buffer;
    fetchImpl?: typeof fetch;
    /** Scopes this provider is permitted. A refresh that widens the grant is refused. */
    allowedScopes?: readonly string[];
  },
): Promise<string> {
  const stored = await loadTokens(db, provider, opts.key);
  if (!stored) throw new ReauthRequired(provider, 'no stored credentials');

  if (Date.parse(stored.expiresAt) - Date.now() > SKEW_MS) return stored.accessToken;
  if (!stored.refreshToken) throw new ReauthRequired(provider, 'access token expired, no refresh token');

  let refreshed: TokenSet;
  try {
    refreshed = await refreshTokens(opts.md, {
      refreshToken: stored.refreshToken,
      clientId: opts.clientId,
      ...(opts.clientSecret ? { clientSecret: opts.clientSecret } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  } catch (error) {
    throw new ReauthRequired(provider, error instanceof Error ? error.message : String(error));
  }

  // A refresh must not widen the grant. Checked before the new token is stored.
  if (opts.allowedScopes) assertGrantedScope(refreshed.scope, opts.allowedScopes);

  // Servers may rotate the refresh token; keep the old one if none was returned.
  await saveTokens(db, provider, {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? stored.refreshToken,
  }, opts.key);
  return refreshed.accessToken;
}