import { db } from '@/lib/data';
import { NextRequest, NextResponse } from 'next/server';
import { loadPositions } from '../../../../../src/domain/networth';
import { blockedInstruments } from '../../../../../src/sources/staleness';
import { buildDigestInput } from '../../../../../src/notify/digest';
import { evaluateExits } from '../../../../../src/domain/sell-triggers';
import { promoteExitCandidate } from '../../../../../src/domain/exit-promotion';

export const dynamic = 'force-dynamic';

/**
 * Promotes one exit candidate into an FR-11 recommendation, on the owner's say-so.
 *
 * The candidate is re-derived here rather than taken from the request body: a body the
 * page sent could be stale, or could name a trigger that is no longer firing, and this
 * writes a recommendation the owner will act on.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null) as
    { instrumentId?: string; trigger?: string } | null;
  if (!body?.instrumentId || !body.trigger) {
    return NextResponse.json({ error: 'instrumentId and trigger are required' }, { status: 400 });
  }

  const d = await db();
  const now = new Date().toISOString();
  const input = await buildDigestInput(d, now);
  const positions = await loadPositions(d, input.businessDate);
  const candidates = await evaluateExits(
    d,
    { positions, blockedIds: blockedInstruments(input.staleness, positions), alternatives: [] },
    now.slice(0, 7),
  );

  const candidate = candidates.find(
    (c) => c.instrumentId === body.instrumentId && c.trigger === body.trigger,
  );
  if (!candidate) {
    return NextResponse.json(
      { error: `no ${body.trigger} candidate is currently firing for ${body.instrumentId}` },
      { status: 409 },
    );
  }

  const result = await promoteExitCandidate(d, candidate, now.slice(0, 10));
  return NextResponse.json(result, { status: result.suppressed ? 409 : 200 });
}
