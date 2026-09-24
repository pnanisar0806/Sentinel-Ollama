import { NextResponse, type NextRequest } from 'next/server';
import { readSession, SESSION_COOKIE, sessionSecret } from './auth';

/** Shared plumbing for the auth routes. */

export function isSecure(request: NextRequest): boolean {
  return request.nextUrl.protocol === 'https:';
}

export function setCookie(
  res: NextResponse, request: NextRequest, name: string, value: string, maxAgeSeconds: number,
): void {
  res.cookies.set(name, value, {
    httpOnly: true, sameSite: 'strict', path: '/', maxAge: maxAgeSeconds, secure: isSecure(request),
  });
}

/** 503 when the deployment has no signing key. Fails closed, and names the variable. */
export function noSecret(): NextResponse {
  return NextResponse.json(
    {
      error: 'SESSION_SECRET is not configured (at least 32 characters). '
        + 'Authentication cannot work without it, so every request is refused.',
    },
    { status: 503 },
  );
}

export function hasSession(request: NextRequest, secret: string): boolean {
  return readSession(request.cookies.get(SESSION_COOKIE)?.value, secret) !== null;
}

export { sessionSecret };
