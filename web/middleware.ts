import { NextResponse, type NextRequest } from 'next/server';
import { isPublicPath, readSession, sameOrigin, SESSION_COOKIE, sessionSecret } from './lib/auth';

/**
 * Every page and every API route requires the owner's session, except the sign-in page
 * and the passkey ceremony itself.
 *
 * This is the only gate. Individual routes do not re-check, so a new route is protected
 * the moment it exists — the failure mode of per-route checks is the route someone
 * forgets, which is how the app came to be deployed with no auth at all.
 *
 * Fails CLOSED: with no `SESSION_SECRET` configured, nothing is served.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  // A cross-site mutation is refused before anything else, public route or not.
  if (!sameOrigin(request.method, request.headers.get('origin'), request.nextUrl.origin)) {
    return NextResponse.json({ error: 'cross-origin request refused' }, { status: 403 });
  }

  if (isPublicPath(pathname)) return NextResponse.next();

  const secret = sessionSecret();
  const signedIn = secret !== null
    && readSession(request.cookies.get(SESSION_COOKIE)?.value, secret) !== null;
  if (signedIn) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: secret === null ? 'authentication is not configured' : 'sign in required' },
      { status: secret === null ? 503 : 401 },
    );
  }
  const login = new URL('/login', request.url);
  if (pathname !== '/') login.searchParams.set('next', pathname);
  return NextResponse.redirect(login);
}

export const config = {
  // Node runtime so `node:crypto` is available for the HMAC — stable in Next 15.5.
  runtime: 'nodejs',
  matcher: ['/((?!_next/static|_next/image).*)'],
};
