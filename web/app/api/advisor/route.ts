import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/data';
import { signAdvice, dismissAdvice } from '../../../../src/domain/advisor-handoff';
import { decideWatchlistLine } from '../../../../src/domain/watchlist-signoff';
import { loadSizingInput } from '../../../../src/domain/sizing-input';
import { sizeCandidates } from '../../../../src/domain/sizing';

export const dynamic = 'force-dynamic';

/**
 * The owner's decisions on advice. Signing a BUY re-sizes it and creates an approval
 * request — it does not approve an order. Authenticated by the middleware.
 */
type Body =
  | { action: 'sign'; proposalId: number }
  | { action: 'dismiss'; proposalId: number; reason: string }
  | { action: 'watchlist'; proposalId: number; line: number; accept: boolean };

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null) as Body | null;
  if (!body) return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const d = await db();
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);
  try {
    switch (body.action) {
      case 'sign': {
        const candidates = sizeCandidates(await loadSizingInput(d, today));
        const r = await signAdvice(d, Number(body.proposalId), { candidates });
        return NextResponse.json({ ok: true, message: r.approvalRequested ? 'Signed — an approval request is waiting on Approvals.' : `Signed: ${r.note}.` });
      }
      case 'dismiss':
        await dismissAdvice(d, Number(body.proposalId), body.reason ?? '');
        return NextResponse.json({ ok: true, message: 'Dismissed.' });
      case 'watchlist':
        await decideWatchlistLine(d, Number(body.proposalId), Number(body.line), Boolean(body.accept), today);
        return NextResponse.json({ ok: true, message: body.accept ? 'Applied.' : 'Declined.' });
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
