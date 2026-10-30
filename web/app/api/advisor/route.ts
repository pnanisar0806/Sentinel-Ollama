import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/data';
import { signAdvice, dismissAdvice } from '../../../../src/domain/advisor-handoff';
import { decideWatchlistLine } from '../../../../src/domain/watchlist-signoff';
import { loadSizingInput } from '../../../../src/domain/sizing-input';
import { sizeCandidates } from '../../../../src/domain/sizing';
import { signLumpSum, dismissLumpSum } from '../../../../src/domain/lump-handoff';
import { loadLumpSizingInput, lumpLimits, sizeLumpSum } from '../../../../src/domain/lump-sizing';
import { loadLumpSum } from '../../../../src/domain/lump-sums';
import { loadProposals } from '../../../../src/advisor/proposals';

export const dynamic = 'force-dynamic';

/**
 * The owner's decisions on advice. Signing a BUY re-sizes it and creates an approval
 * request — it does not approve an order. Authenticated by the middleware.
 */
type Body =
  | { action: 'sign'; proposalId: number }
  | { action: 'dismiss'; proposalId: number; reason: string }
  | { action: 'watchlist'; proposalId: number; line: number; accept: boolean }
  | { action: 'sign_lump'; proposalId: number }
  | { action: 'dismiss_lump'; proposalId: number; reason: string };

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
      case 'sign_lump': {
        const id = Number(body.proposalId);
        const p = (await loadProposals(d, 'LUMP_SUM', 500)).find((x) => x.id === id);
        const lumpId = String(p?.payload['lumpSumId'] ?? '');
        // Sized only when the lump sum is live; signLumpSum refuses the rest with its own reason.
        const input = p && await loadLumpSum(d, lumpId) ? await loadLumpSizingInput(d, lumpId, today) : null;
        const r = await signLumpSum(d, id, input
          ? { candidates: sizeLumpSum(input), limits: lumpLimits(input) }
          : { candidates: [], limits: { freeCashPaise: 0n, typeRoomPaise: {}, goldRoomPaise: null } });
        return NextResponse.json({ ok: true, message: `Signed: ${r.note}.${r.recommendationIds.length > 0 ? ' Approve them on Approvals.' : ''}` });
      }
      case 'dismiss_lump':
        await dismissLumpSum(d, Number(body.proposalId), body.reason ?? '');
        return NextResponse.json({ ok: true, message: 'Dismissed. It is re-advised at the next weekly report.' });
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
