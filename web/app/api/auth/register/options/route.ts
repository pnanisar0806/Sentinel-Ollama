import { NextResponse, type NextRequest } from 'next/server';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { db } from '@/lib/data';
import { CHALLENGE_COOKIE, CHALLENGE_TTL_SECONDS, issueChallenge, mayRegister, relyingParty } from '@/lib/auth';
import { hasSession, noSecret, sessionSecret, setCookie } from '@/lib/auth-http';
import { listPasskeys } from '@/lib/passkeys';

export const dynamic = 'force-dynamic';

/**
 * Starts a passkey registration.
 *
 * Gated: whoever registers first would own the app, so this needs either an existing
 * owner session (adding a second device) or the `OWNER_SETUP_TOKEN` from the deployment's
 * environment. See `mayRegister`.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = sessionSecret();
  if (secret === null) return noSecret();

  const body = await request.json().catch(() => ({})) as { setupToken?: string };
  if (!mayRegister({ hasSession: hasSession(request, secret), suppliedToken: body.setupToken })) {
    return NextResponse.json(
      { error: 'registration needs the owner setup token or an existing session' },
      { status: 403 },
    );
  }

  const { rpID } = relyingParty(request.nextUrl.origin);
  const existing = await listPasskeys(await db());
  const options = await generateRegistrationOptions({
    rpName: 'Sentinel',
    rpID,
    userName: 'owner',
    userDisplayName: 'Owner',
    attestationType: 'none',
    // A device that already holds a passkey here is not registered twice.
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });

  const res = NextResponse.json(options);
  setCookie(res, request, CHALLENGE_COOKIE, issueChallenge(options.challenge, 'register', secret), CHALLENGE_TTL_SECONDS);
  return res;
}
