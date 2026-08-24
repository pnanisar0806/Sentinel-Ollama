import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  discoverMetadata,
  assertGrantedScope,
  saveClientSecret,
  loadClientSecret,
} from '../../src/sources/oauth.js';

let db: Db;
const KEY = randomBytes(32);
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

const ISSUER = 'https://mcp.indmoney.com';
const good = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
};
const serving = (md: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(md), { status: 200 })) as unknown as typeof fetch;

/**
 * Review I8/I9: `discoverMetadata` did none of RFC 8414's validation. It fetched a URL
 * and cast the body. A hostile or misconfigured discovery document could point the
 * authorize and token endpoints at another origin entirely — which is where the
 * authorization code and the client secret get sent.
 */
describe('discoverMetadata validates the document (RFC 8414)', () => {
  it('accepts a well-formed document', async () => {
    await expect(discoverMetadata(ISSUER, serving(good))).resolves.toMatchObject({ issuer: ISSUER });
  });

  it('tolerates a trailing slash on the issuer, which real servers vary on', async () => {
    const md = { ...good, issuer: `${ISSUER}/` };
    await expect(discoverMetadata(ISSUER, serving(md))).resolves.toMatchObject({ issuer: `${ISSUER}/` });
  });

  it('refuses an issuer mismatch', async () => {
    // RFC 8414 section 3.3: the issuer in the document MUST match the requested issuer.
    const md = { ...good, issuer: 'https://evil.example' };
    await expect(discoverMetadata(ISSUER, serving(md))).rejects.toThrow(/issuer/i);
  });

  it('refuses a non-https issuer', async () => {
    await expect(discoverMetadata('http://mcp.indmoney.com', serving(good))).rejects.toThrow(/https/i);
  });

  it.each([
    ['authorization_endpoint', 'https://evil.example/authorize'],
    ['token_endpoint', 'https://evil.example/token'],
    ['registration_endpoint', 'https://evil.example/register'],
  ])('refuses %s on a different origin', async (field, value) => {
    const md = { ...good, [field]: value };
    await expect(discoverMetadata(ISSUER, serving(md))).rejects.toThrow(/origin|https/i);
  });

  it.each(['authorization_endpoint', 'token_endpoint'])('refuses a missing %s', async (field) => {
    const md: Record<string, unknown> = { ...good };
    delete md[field];
    await expect(discoverMetadata(ISSUER, serving(md))).rejects.toThrow(new RegExp(field));
  });

  it('refuses a plaintext endpoint even on the right host', async () => {
    const md = { ...good, token_endpoint: 'http://mcp.indmoney.com/token' };
    await expect(discoverMetadata(ISSUER, serving(md))).rejects.toThrow(/https|origin/i);
  });
});

/**
 * MEMORY said "read-only is enforced by the token's scope" — but nothing ever compared
 * the granted scope to what was asked for. A provider that upgrades the grant, or a
 * copy-pasted client id bound to a broader scope, went entirely unnoticed.
 */
describe('assertGrantedScope', () => {
  it('accepts exactly what was requested', () => {
    expect(() => assertGrantedScope('portfolio:read', ['portfolio:read'])).not.toThrow();
  });

  it('accepts a narrower grant — the provider may give less', () => {
    expect(() => assertGrantedScope('', ['portfolio:read'])).not.toThrow();
  });

  it('refuses any scope that was not requested', () => {
    expect(() => assertGrantedScope('portfolio:read trade:write', ['portfolio:read']))
      .toThrow(/trade:write/);
  });

  it('names every unexpected scope, not just the first', () => {
    const call = () => assertGrantedScope('portfolio:read orders:write funds:write', ['portfolio:read']);
    expect(call).toThrow(/orders:write/);
    expect(call).toThrow(/funds:write/);
  });

  it('is not fooled by extra whitespace between scopes', () => {
    expect(() => assertGrantedScope('  portfolio:read   trade:write ', ['portfolio:read']))
      .toThrow(/trade:write/);
  });
});

/**
 * Review I10: the test cited as proof that "Audit #4 FIXED" built its own
 * `Buffer.from('encrypted-placeholder')`, inserted it with raw SQL, and asserted the
 * column was not null. It never called either function, and both had ZERO coverage
 * repo-wide. It would have passed if saveClientSecret stored plaintext.
 */
describe('client secret round-trips through real encryption', () => {
  it('stores ciphertext that is not the plaintext, and reads it back', async () => {
    const secret = 'cs_live_9f3a2b1c-not-a-real-secret';
    await saveClientSecret(db, 'indmoney', secret, KEY);

    const [row] = await db.query<{ client_secret_enc: Uint8Array }>(
      'select client_secret_enc from oauth_clients where provider = $1', ['indmoney'],
    );
    const stored = Buffer.from(row!.client_secret_enc);

    // The assertion the old test could not make: the bytes on disk are not the secret.
    expect(stored.toString('utf8')).not.toBe(secret);
    expect(stored.includes(Buffer.from(secret, 'utf8'))).toBe(false);
    expect(stored.length).toBeGreaterThan(secret.length); // iv + tag + ciphertext

    expect(await loadClientSecret(db, 'indmoney', KEY)).toBe(secret);
  });

  it('refuses to decrypt with the wrong key', async () => {
    await saveClientSecret(db, 'indmoney', 'secret', KEY);
    await expect(loadClientSecret(db, 'indmoney', randomBytes(32))).rejects.toThrow();
  });

  it('returns null for a provider that has never registered', async () => {
    expect(await loadClientSecret(db, 'nobody', KEY)).toBeNull();
  });

  it('uses a fresh IV, so the same secret encrypts differently each time', async () => {
    await saveClientSecret(db, 'a', 'same-secret', KEY);
    await saveClientSecret(db, 'b', 'same-secret', KEY);
    const rows = await db.query<{ client_secret_enc: Uint8Array }>(
      'select client_secret_enc from oauth_clients where provider in ($1,$2)', ['a', 'b'],
    );
    expect(Buffer.from(rows[0]!.client_secret_enc).equals(Buffer.from(rows[1]!.client_secret_enc)))
      .toBe(false);
  });
});
