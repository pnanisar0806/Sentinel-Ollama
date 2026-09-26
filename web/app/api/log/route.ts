import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/data';
import { completeMilestone, logGoalMove, logNote, type GoalMoveKind } from '../../../../src/domain/owner-log';
import { recordRedemption, stateRedemptionAmount } from '../../../../src/domain/bond-redemptions';

export const dynamic = 'force-dynamic';

/**
 * The owner telling Sentinel what they did (/log). Authenticated by the middleware like
 * every other route; validation lives in the domain so every surface enforces it.
 * Rupee amounts arrive as text and become paise here — never through a float.
 */
type Body =
  | { action: 'goal'; bucketId: string; on: string; rupees: string; kind: GoalMoveKind; note: string }
  | { action: 'milestone'; id: string; on: string }
  | { action: 'bond'; instrumentId: string; on: string; rupees: string; note: string }
  | { action: 'note'; on: string; text: string };

function paise(rupees: string): bigint {
  const m = /^\s*(\d{1,12})(?:\.(\d{1,2}))?\s*$/.exec(rupees.replace(/,/g, ''));
  if (!m) throw new Error(`"${rupees}" is not a rupee amount`);
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null) as Body | null;
  if (!body) return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const d = await db();
  try {
    switch (body.action) {
      case 'goal':
        await logGoalMove(d, { bucketId: body.bucketId, occurredOn: body.on, amountPaise: paise(body.rupees), kind: body.kind, note: body.note ?? '' });
        return NextResponse.json({ ok: true, message: `Recorded against ${body.bucketId}.` });
      case 'milestone':
        await completeMilestone(d, body.id, body.on);
        return NextResponse.json({ ok: true, message: 'Milestone marked complete.' });
      case 'bond': {
        const amount = paise(body.rupees);
        if (amount <= 0n) throw new Error('the amount credited must be positive');
        const fresh = await recordRedemption(d, body.instrumentId, { receivedOn: body.on, amountPaise: null, note: body.note ?? '' });
        await stateRedemptionAmount(d, body.instrumentId, amount, body.note ?? '');
        return NextResponse.json({ ok: true, message: fresh ? 'Redemption recorded.' : 'Already redeemed; the amount was added.' });
      }
      case 'note':
        await logNote(d, { on: body.on, text: body.text ?? '' });
        return NextResponse.json({ ok: true, message: 'Noted.' });
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
