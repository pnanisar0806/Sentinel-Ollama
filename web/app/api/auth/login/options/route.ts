import { NextResponse, type NextRequest } from 'next/server';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { db } from '@/lib/data';
import { CHALLENGE_COOKIE, CHALLENGE_TTL_SECONDS, issueChallenge, relyingParty } from '@/lib/auth';
import { noSecret, sessionSecret, setCookie } from '@/lib/auth-http';
import { listPasskeys } from '@/lib/passkeys';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = sessionSecret();
  if (secret === null) return noSecret();

  const passkeys = await listPasskeys(await db());
  if (passkeys.length === 0) {
    return NextResponse.json({ error: 'no passkey is registered yet — register one first' }, { status: 409 });
  }

  const { rpID } = relyingParty(request.nextUrl.origin);
  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: passkeys.map((p) => ({ id: p.id, transports: p.transports as never })),
    userVerification: 'required',
  });

  const res = NextResponse.json(options);
  setCookie(res, request, CHALLENGE_COOKIE, issueChallenge(options.challenge, 'login', secret), CHALLENGE_TTL_SECONDS);
  return res;
}
