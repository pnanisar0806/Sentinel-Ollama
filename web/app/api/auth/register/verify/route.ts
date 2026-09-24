import { NextResponse, type NextRequest } from 'next/server';
import { verifyRegistrationResponse, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { db } from '@/lib/data';
import {
  CHALLENGE_COOKIE, SESSION_COOKIE, SESSION_TTL_SECONDS, issueSession, readChallenge, relyingParty,
} from '@/lib/auth';
import { noSecret, sessionSecret, setCookie } from '@/lib/auth-http';
import { auditAuth, savePasskey } from '@/lib/passkeys';

export const dynamic = 'force-dynamic';

/**
 * Finishes a registration.
 *
 * The gate ran when the challenge was issued: a `register` challenge cookie is only ever
 * signed after `mayRegister` passed, and a `login` challenge cannot stand in for one.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = sessionSecret();
  if (secret === null) return noSecret();

  const challenge = readChallenge(request.cookies.get(CHALLENGE_COOKIE)?.value, 'register', secret);
  if (challenge === null) {
    return NextResponse.json({ error: 'no registration in progress, or it expired' }, { status: 400 });
  }

  const body = await request.json().catch(() => null) as
    { response?: RegistrationResponseJSON; label?: string } | null;
  if (!body?.response) return NextResponse.json({ error: 'response is required' }, { status: 400 });

  const { origin, rpID } = relyingParty(request.nextUrl.origin);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response, expectedChallenge: challenge,
      expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'verification failed' }, { status: 400 });
  }
  if (!verification.verified) return NextResponse.json({ error: 'verification failed' }, { status: 400 });

  const { credential } = verification.registrationInfo;
  const label = (body.label ?? '').slice(0, 60);
  const d = await db();
  await savePasskey(d, {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: credential.transports ?? [],
    label,
  });
  await auditAuth(d, 'PASSKEY_REGISTERED', { credentialId: credential.id, label });

  const res = NextResponse.json({ ok: true });
  setCookie(res, request, SESSION_COOKIE, issueSession(secret), SESSION_TTL_SECONDS);
  setCookie(res, request, CHALLENGE_COOKIE, '', 0);
  return res;
}
