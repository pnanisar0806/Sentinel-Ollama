import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  issueChallenge, issueSession, isPublicPath, mayRegister, readChallenge, readSession,
  relyingParty, sameOrigin, sessionSecret, SESSION_TTL_SECONDS,
} from '../../web/lib/auth.js';

/**
 * The deployed web app had no authentication at all. `POST /api/approvals/*\/approve`,
 * `/api/exits/promote` and `/api/import` were reachable by anyone holding the URL.
 */
const SECRET = 'x'.repeat(40);
const NOW = 1_800_000_000;

describe('sessions', () => {
  it('round-trips a valid session', () => {
    expect(readSession(issueSession(SECRET, NOW), SECRET, NOW + 60)?.sub).toBe('owner');
  });

  it('rejects an expired session', () => {
    expect(readSession(issueSession(SECRET, NOW), SECRET, NOW + SESSION_TTL_SECONDS + 1)).toBeNull();
  });

  it('rejects a session signed with a different key', () => {
    // Rotating SESSION_SECRET is how every session gets revoked at once.
    expect(readSession(issueSession(SECRET, NOW), 'y'.repeat(40), NOW)).toBeNull();
  });

  it('rejects a tampered payload', () => {
    const [body, mac] = issueSession(SECRET, NOW).split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'owner', iat: NOW, exp: NOW + 10 ** 9 }))
      .toString('base64url');
    expect(body).not.toBe(forged);
    expect(readSession(`${forged}.${mac}`, SECRET, NOW)).toBeNull();
  });

  it('rejects garbage without throwing', () => {
    for (const t of [undefined, '', '.', 'abc', 'a.b', '..', 'eyJ9.x']) {
      expect(readSession(t, SECRET, NOW)).toBeNull();
    }
  });
});

describe('the signing key fails closed', () => {
  it('has no key when SESSION_SECRET is unset', () => {
    // A missing env var must never read as "auth disabled".
    expect(sessionSecret({})).toBeNull();
  });

  it('refuses a short key rather than accepting a weak one', () => {
    expect(sessionSecret({ SESSION_SECRET: 'short' })).toBeNull();
    expect(sessionSecret({ SESSION_SECRET: 'z'.repeat(32) })).toBe('z'.repeat(32));
  });
});

describe('WebAuthn challenges', () => {
  it('cannot replay a login challenge into registration', () => {
    // Registration is the gated step; a login challenge is issued to anyone.
    const loginChallenge = issueChallenge('abc', 'login', SECRET, NOW);
    expect(readChallenge(loginChallenge, 'register', SECRET, NOW)).toBeNull();
    expect(readChallenge(loginChallenge, 'login', SECRET, NOW)).toBe('abc');
  });

  it('expires after five minutes', () => {
    const c = issueChallenge('abc', 'login', SECRET, NOW);
    expect(readChallenge(c, 'login', SECRET, NOW + 301)).toBeNull();
  });
});

describe('who may register a passkey', () => {
  const env = { OWNER_SETUP_TOKEN: 'correct-horse-battery' };

  it('allows the owner who is already signed in, to add a second device', () => {
    expect(mayRegister({ hasSession: true, suppliedToken: undefined }, env)).toBe(true);
  });

  it('allows a stranger only with the setup token', () => {
    expect(mayRegister({ hasSession: false, suppliedToken: 'correct-horse-battery' }, env)).toBe(true);
    expect(mayRegister({ hasSession: false, suppliedToken: 'wrong-horse-battery!' }, env)).toBe(false);
    expect(mayRegister({ hasSession: false, suppliedToken: undefined }, env)).toBe(false);
  });

  it('refuses everyone without a session when no token is configured', () => {
    // Otherwise whoever reached the deployment first would own it.
    expect(mayRegister({ hasSession: false, suppliedToken: 'anything' }, {})).toBe(false);
    expect(mayRegister({ hasSession: false, suppliedToken: '' }, { OWNER_SETUP_TOKEN: '' })).toBe(false);
  });

  it('refuses a configured token too short to be a secret', () => {
    expect(mayRegister({ hasSession: false, suppliedToken: 'abc' }, { OWNER_SETUP_TOKEN: 'abc' })).toBe(false);
  });
});

describe('cross-origin mutations', () => {
  const self = 'https://sentinel.example.app';

  it('lets reads through', () => {
    expect(sameOrigin('GET', null, self)).toBe(true);
  });

  it('refuses a mutation from another origin, or with none', () => {
    expect(sameOrigin('POST', 'https://evil.example', self)).toBe(false);
    expect(sameOrigin('POST', null, self)).toBe(false);
    expect(sameOrigin('POST', self, self)).toBe(true);
  });
});

describe('relying party', () => {
  it('pins the origin from WEBAUTHN_ORIGIN when set', () => {
    expect(relyingParty('https://preview-123.vercel.app', { WEBAUTHN_ORIGIN: 'https://sentinel.app' }))
      .toEqual({ origin: 'https://sentinel.app', rpID: 'sentinel.app' });
  });

  it('falls back to the request origin', () => {
    expect(relyingParty('http://localhost:3000', {})).toEqual({ origin: 'http://localhost:3000', rpID: 'localhost' });
  });
});

describe('public paths', () => {
  it('opens only sign-in, the ceremony and static assets', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/api/auth/login/options')).toBe(true);
    expect(isPublicPath('/_next/static/chunk.js')).toBe(true);
  });

  it('does not open a path that merely starts like a public one', () => {
    expect(isPublicPath('/login-anything')).toBe(false);
    expect(isPublicPath('/api/authz')).toBe(false);
  });

  /**
   * Derived from the real route tree, not a hand-kept list: a route added tomorrow is
   * checked the day it exists. This is the check that would have caught the app being
   * deployed with every route open.
   */
  it('keeps every page and API route outside /api/auth behind the gate', () => {
    const appDir = join(__dirname, '../../web/app');
    const routes: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name === 'route.ts' || name === 'page.tsx') {
          const path = '/' + relative(appDir, dir).split(sep).join('/');
          routes.push(path === '/' ? '/' : path.replace(/\/$/, ''));
        }
      }
    };
    walk(appDir);

    expect(routes.length).toBeGreaterThan(20);
    const open = routes.filter((r) => isPublicPath(r.replace(/\[[^\]]+\]/g, 'x')));
    expect(open.sort()).toEqual([
      '/api/auth/login/options', '/api/auth/login/verify', '/api/auth/logout',
      '/api/auth/register/options', '/api/auth/register/verify', '/login',
    ]);
    // The mutations that prompted all this must be gated.
    for (const r of ['/api/approvals/[id]/approve', '/api/exits/promote', '/api/import']) {
      expect(routes).toContain(r);
      expect(isPublicPath(r.replace(/\[[^\]]+\]/g, 'x'))).toBe(false);
    }
  });
});
