import { NextResponse, type NextRequest } from 'next/server';
import { verifyAuthenticationResponse, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { db } from '@/lib/data';
import {
  CHALLENGE_COOKIE, SESSION_COOKIE, SESSION_TTL_SECONDS, issueSession, readChallenge, relyingParty,
} from '@/lib/auth';
import { noSecret, sessionSecret, setCookie } from '@/lib/auth-http';
import { auditAuth, findPasskey, touchPasskey } from '@/lib/passkeys';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = sessionSecret();
  if (secret === null) return noSecret();

  const challenge = readChallenge(request.cookies.get(CHALLENGE_COOKIE)?.value, 'login', secret);
  if (challenge === null) {
    return NextResponse.json({ error: 'no sign-in in progress, or it expired' }, { status: 400 });
  }

  const body = await request.json().catch(() => null) as { response?: AuthenticationResponseJSON } | null;
  if (!body?.response) return NextResponse.json({ error: 'response is required' }, { status: 400 });

  const d = await db();
  const passkey = await findPasskey(d, body.response.id);
  if (passkey === null) {
    await auditAuth(d, 'LOGIN_FAILED', { credentialId: body.response.id, reason: 'unknown credential' });
    return NextResponse.json({ error: 'unknown passkey' }, { status: 401 });
  }

  const { origin, rpID } = relyingParty(request.nextUrl.origin);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response, expectedChallenge: challenge,
      expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: {
        id: passkey.id,
        publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')),
        counter: passkey.counter,
        transports: passkey.transports,
      },
    });
  } catch (e) {
    await auditAuth(d, 'LOGIN_FAILED', { credentialId: passkey.id, reason: e instanceof Error ? e.message : 'error' });
    return NextResponse.json({ error: 'verification failed' }, { status: 401 });
  }
  if (!verification.verified) {
    await auditAuth(d, 'LOGIN_FAILED', { credentialId: passkey.id, reason: 'not verified' });
    return NextResponse.json({ error: 'verification failed' }, { status: 401 });
  }

  await touchPasskey(d, passkey.id, verification.authenticationInfo.newCounter);
  await auditAuth(d, 'LOGIN', { credentialId: passkey.id });

  const res = NextResponse.json({ ok: true });
  setCookie(res, request, SESSION_COOKIE, issueSession(secret), SESSION_TTL_SECONDS);
  setCookie(res, request, CHALLENGE_COOKIE, '', 0);
  return res;
}
