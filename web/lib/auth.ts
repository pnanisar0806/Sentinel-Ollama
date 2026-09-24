import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Single-owner authentication for the web app: passkeys (WebAuthn) plus a signed
 * session cookie.
 *
 * The deployed app had none. Every page and every mutation — approving an order,
 * promoting an exit, importing a statement — was open to anyone holding the URL.
 *
 * Stateless by design: a session is an HMAC-signed expiry, so there is no session table
 * to leak or clean up. The price is that a stolen cookie stays valid until it expires;
 * `SESSION_TTL_SECONDS` bounds that, and rotating `SESSION_SECRET` revokes every
 * session at once.
 */

export const SESSION_COOKIE = 'sentinel_session';
export const CHALLENGE_COOKIE = 'sentinel_challenge';

/** Seven days. A personal app used a few times a week; long enough not to nag. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A WebAuthn ceremony takes seconds; five minutes is generous. */
export const CHALLENGE_TTL_SECONDS = 5 * 60;

/**
 * Pages and routes reachable without a session. Everything else requires one.
 *
 * Exact paths and prefixes are kept apart on purpose: a bare `startsWith('/login')`
 * would also open `/login-anything`.
 */
const PUBLIC_EXACT = new Set(['/login', '/favicon.ico']);
const PUBLIC_PREFIXES = ['/api/auth/', '/_next/'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_EXACT.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

/**
 * The HMAC key. **Fails closed**: without a secret nothing can be signed or verified,
 * so every request is refused rather than every request being let through. A missing
 * env var must never read as "auth disabled".
 */
export function sessionSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = env['SESSION_SECRET'];
  // 32 bytes of entropy is the floor for an HMAC-SHA256 key; a short one is refused
  // rather than accepted and silently weak.
  return s !== undefined && s.length >= 32 ? s : null;
}

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');

function sign(payload: object, secret: string): string {
  const body = b64u(JSON.stringify(payload));
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/** The payload, if the signature holds and it has not expired. Never throws. */
function verify<T extends { exp: number }>(token: string | undefined, secret: string, nowSec: number): T | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  // Constant-time: a byte-by-byte early exit would leak how much of a forged MAC matched.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec) return null;
    return payload;
  } catch {
    return null;
  }
}

export interface Session { sub: 'owner'; iat: number; exp: number }

export function issueSession(secret: string, nowSec = Math.floor(Date.now() / 1000)): string {
  return sign({ sub: 'owner', iat: nowSec, exp: nowSec + SESSION_TTL_SECONDS } satisfies Session, secret);
}

export function readSession(
  token: string | undefined, secret: string, nowSec = Math.floor(Date.now() / 1000),
): Session | null {
  const s = verify<Session>(token, secret, nowSec);
  return s !== null && s.sub === 'owner' ? s : null;
}

export type Ceremony = 'register' | 'login';
export interface ChallengeClaim { c: string; purpose: Ceremony; exp: number }

/**
 * The WebAuthn challenge rides in a signed, short-lived cookie rather than a table.
 * `purpose` stops a challenge issued for login being replayed into registration, which
 * is the step that is gated.
 */
export function issueChallenge(
  challenge: string, purpose: Ceremony, secret: string, nowSec = Math.floor(Date.now() / 1000),
): string {
  return sign({ c: challenge, purpose, exp: nowSec + CHALLENGE_TTL_SECONDS } satisfies ChallengeClaim, secret);
}

export function readChallenge(
  token: string | undefined, purpose: Ceremony, secret: string, nowSec = Math.floor(Date.now() / 1000),
): string | null {
  const claim = verify<ChallengeClaim>(token, secret, nowSec);
  return claim !== null && claim.purpose === purpose ? claim.c : null;
}

/**
 * Whether a registration may begin.
 *
 * Registration is the dangerous step: whoever registers first owns the app. So it needs
 * EITHER an existing owner session (adding a second device) OR `OWNER_SETUP_TOKEN`,
 * which only the owner has because it lives in the deployment's env. Without a token
 * configured, only an already-signed-in owner can add a passkey.
 */
export function mayRegister(
  opts: { hasSession: boolean; suppliedToken: string | null | undefined },
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (opts.hasSession) return true;
  const expected = env['OWNER_SETUP_TOKEN'];
  if (!expected || expected.length < 16 || !opts.suppliedToken) return false;
  const a = Buffer.from(opts.suppliedToken);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * CSRF defence in depth for state-changing requests.
 *
 * The session cookie is `SameSite=Strict`, which already stops a cross-site form from
 * carrying it. This adds a check browsers cannot be talked out of: a mutation's `Origin`
 * must be this site. A missing Origin on a mutation is refused — every browser that
 * supports passkeys sends it.
 */
export function sameOrigin(method: string, originHeader: string | null, selfOrigin: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  return originHeader !== null && originHeader === selfOrigin;
}

/** Where the relying party lives. `WEBAUTHN_ORIGIN` pins it; otherwise the request's own. */
export function relyingParty(
  requestOrigin: string, env: Record<string, string | undefined> = process.env,
): { origin: string; rpID: string } {
  const origin = env['WEBAUTHN_ORIGIN'] ?? requestOrigin;
  return { origin, rpID: new URL(origin).hostname };
}

export function cookieFlags(maxAgeSeconds: number, secure: boolean): string {
  return [
    'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}
