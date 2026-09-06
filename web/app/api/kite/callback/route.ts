import { NextRequest, NextResponse } from 'next/server.js';
import { db } from '../../../../lib/data.js';
import {
  consumeKiteState, exchangeKiteRequestToken,
} from '../../../../lib/kite-auth.js';
import { saveTokens } from '../../../../../src/sources/oauth.js';
import { KiteSource } from '../../../../../src/sources/kite.js';
import { writeSnapshot } from '../../../../../src/sources/types.js';

export const dynamic = 'force-dynamic';

const redirectBack = (req: NextRequest, query: string) =>
  NextResponse.redirect(`${req.nextUrl.origin}/import?${query}`);

/**
 * Step 2 of the Kite Connect login flow. Receives the `request_token` on the
 * REGISTERED redirect URI, exchanges it for an access token, stores that token
 * encrypted at rest (same scheme as INDmoney's), and immediately pulls holdings
 * into the database as a `kite` snapshot — mirroring `pnpm sync`. The owner is
 * the human-in-the-loop unlock: no password ever leaves Kite's login page.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const params = req.nextUrl.searchParams;
  const requestToken = params.get('request_token');
  const state = params.get('state');
  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;
  const encKey = process.env.TOKEN_ENCRYPTION_KEY;

  if (!requestToken) return redirectBack(req, 'error&reason=no-request-token');
  if (!consumeKiteState(state)) return redirectBack(req, 'error&reason=bad-state');
  if (!apiKey || !apiSecret) return redirectBack(req, 'error&reason=missing-keys');
  if (!encKey) return redirectBack(req, 'error&reason=missing-encryption-key');

  try {
    const session = await exchangeKiteRequestToken(apiKey, apiSecret, requestToken);

    const d = await db();
    await saveTokens(d, 'kite', {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      scope: 'holdings',
    }, Buffer.from(encKey, 'base64'));
    await d.query(
      `insert into audit_log (entity, entity_id, action, actor, payload)
       values ('oauth', 'kite', 'AUTHORIZED', 'owner', $1::jsonb)`,
      [{ scope: 'holdings', expiresAt: session.expiresAt, userId: session.userId }],
    );

    const source = new KiteSource({ apiKey, accessToken: session.accessToken });
    const { rows, asOf } = await source.fetch();
    await writeSnapshot(d, 'kite', asOf.slice(0, 10), rows, asOf);

    return redirectBack(req, `ok&rows=${rows.length}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return redirectBack(req, `error&reason=${encodeURIComponent(message)}`);
  }
}