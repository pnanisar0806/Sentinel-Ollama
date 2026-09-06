import { NextRequest, NextResponse } from 'next/server.js';
import { beginKiteLogin, kiteLoginUrl } from '../../../../lib/kite-auth.js';

export const dynamic = 'force-dynamic';

/**
 * Step 1 of the Kite Connect login flow. Redirects the owner's browser to Kite's
 * login page. The api_secret is never sent here — it only lives on the server for
 * the callback's checksum. If the redirect URI is wrong, Kite itself refuses, so
 * the failure is surfaced on /import rather than swallowed.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = req.nextUrl.origin;
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) {
    return NextResponse.redirect(`${origin}/import?kite=error&reason=no-api-key`);
  }
  const state = beginKiteLogin(apiKey);
  return NextResponse.redirect(kiteLoginUrl(apiKey, state));
}