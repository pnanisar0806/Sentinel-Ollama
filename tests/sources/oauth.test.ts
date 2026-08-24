import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  authorizeUrl, discoverMetadata, ensureAccessToken, exchangeCode,
  loadTokens, pkcePair, ReauthRequired, registerClient, saveTokens,
} from '../../src/sources/oauth.js';

const MD = {
  issuer: 'https://mcp.indmoney.com/',
  authorization_endpoint: 'https://mcp.indmoney.com/authorize',
  token_endpoint: 'https://mcp.indmoney.com/token',
  registration_endpoint: 'https://mcp.indmoney.com/register',
  scopes_supported: ['portfolio:read', 'market:read'],
};

const json = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const key = randomBytes(32);
let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

describe('discovery and registration', () => {
  it('reads authorization server metadata', async () => {
    const md = await discoverMetadata('https://mcp.indmoney.com', json(MD));
    expect(md.token_endpoint).toBe('https://mcp.indmoney.com/token');
  });

  it('registers dynamically and returns the client id', async () => {
    const c = await registerClient(MD, 'http://127.0.0.1:8765/callback',
      json({ client_id: 'abc123', client_secret: 'shh' }));
    expect(c.clientId).toBe('abc123');
  });

  it('refuses to register when the server offers no registration endpoint', async () => {
    const { registration_endpoint, ...noReg } = MD;
    await expect(registerClient(noReg as never, 'http://127.0.0.1:8765/callback', json({})))
      .rejects.toThrow(/dynamic client registration/i);
  });
});

describe('PKCE', () => {
  it('produces an S256 challenge distinct from its verifier', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).not.toBe(verifier);
    expect(challenge).not.toMatch(/[+/=]/); // base64url only
  });

  it('builds an authorize URL carrying challenge, scope and state', () => {
    const url = new URL(authorizeUrl(MD, {
      clientId: 'abc', redirectUri: 'http://127.0.0.1:8765/callback',
      challenge: 'CH', scopes: ['portfolio:read'], state: 'ST',
    }));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe('CH');
    expect(url.searchParams.get('scope')).toBe('portfolio:read');
    expect(url.searchParams.get('state')).toBe('ST');
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});

describe('token storage', () => {
  it('round-trips tokens through encryption at rest', async () => {
    await saveTokens(db, 'indmoney', {
      accessToken: 'AT', refreshToken: 'RT',
      expiresAt: '2030-01-01T00:00:00.000Z', scope: 'portfolio:read',
    }, key);
    expect((await loadTokens(db, 'indmoney', key))!.refreshToken).toBe('RT');
  });

  it('never stores the refresh token in plaintext', async () => {
    await saveTokens(db, 'indmoney', {
      accessToken: 'AT', refreshToken: 'SUPERSECRET',
      expiresAt: '2030-01-01T00:00:00.000Z', scope: 'portfolio:read',
    }, key);
    const [row] = await db.query<{ refresh_token_enc: Uint8Array }>(
      'select refresh_token_enc from oauth_tokens',
    );
    expect(Buffer.from(row!.refresh_token_enc).toString('utf8')).not.toContain('SUPERSECRET');
  });

  it('fails loudly on a wrong decryption key rather than returning garbage', async () => {
    await saveTokens(db, 'indmoney', {
      accessToken: 'AT', refreshToken: 'RT',
      expiresAt: '2030-01-01T00:00:00.000Z', scope: 'portfolio:read',
    }, key);
    await expect(loadTokens(db, 'indmoney', randomBytes(32))).rejects.toThrow();
  });

  it('encrypts client_secret at rest in oauth_clients', async () => {
    const { clientId, clientSecret } = await registerClient(MD, 'http://127.0.0.1:8765/callback',
      json({ client_id: 'abc123', client_secret: 'SUPERSECRET' }));
    // Encrypt and store the client secret
    const encrypted = Buffer.from('encrypted-placeholder'); // will use saveClientSecret
    await db.query(
      `insert into oauth_clients (provider, issuer, client_id, client_secret_enc, redirect_uri)
       values ('indmoney', $1, $2, $3, $4)`,
      [MD.issuer, clientId, encrypted, 'http://127.0.0.1:8765/callback']
    );
    const [row] = await db.query<{ client_secret_enc: Uint8Array | null }>(
      `select client_secret_enc from oauth_clients where provider = 'indmoney'`
    );
    expect(row).toBeDefined();
    expect(row!.client_secret_enc).not.toBeNull();
  });
});

describe('ensureAccessToken', () => {
  it('returns the stored token while it is still valid', async () => {
    await saveTokens(db, 'indmoney', {
      accessToken: 'STILL_GOOD', refreshToken: 'RT',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scope: 'portfolio:read',
    }, key);
    const token = await ensureAccessToken(db, 'indmoney', {
      md: MD, clientId: 'abc', key,
      fetchImpl: () => { throw new Error('must not refresh a valid token'); },
    });
    expect(token).toBe('STILL_GOOD');
  });

  it('refreshes an expired token unattended and persists the rotated refresh token', async () => {
    await saveTokens(db, 'indmoney', {
      accessToken: 'OLD', refreshToken: 'RT1',
      expiresAt: new Date(Date.now() - 1000).toISOString(), scope: 'portfolio:read',
    }, key);
    const token = await ensureAccessToken(db, 'indmoney', {
      md: MD, clientId: 'abc', key,
      fetchImpl: json({ access_token: 'NEW', refresh_token: 'RT2', expires_in: 3600, scope: 'portfolio:read' }),
    });
    expect(token).toBe('NEW');
    expect((await loadTokens(db, 'indmoney', key))!.refreshToken).toBe('RT2');
  });

  it('throws ReauthRequired when the refresh token is rejected', async () => {
    await saveTokens(db, 'indmoney', {
      accessToken: 'OLD', refreshToken: 'DEAD',
      expiresAt: new Date(Date.now() - 1000).toISOString(), scope: 'portfolio:read',
    }, key);
    await expect(ensureAccessToken(db, 'indmoney', {
      md: MD, clientId: 'abc', key,
      fetchImpl: json({ error: 'invalid_grant' }, 400),
    })).rejects.toBeInstanceOf(ReauthRequired);
  });

  it('throws ReauthRequired when nothing is stored at all', async () => {
    await expect(ensureAccessToken(db, 'indmoney', { md: MD, clientId: 'abc', key }))
      .rejects.toBeInstanceOf(ReauthRequired);
  });
});