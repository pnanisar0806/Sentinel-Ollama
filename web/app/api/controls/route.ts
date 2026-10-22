import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/data';
import { invalidRailMessage, railChangeMessage, validRailValue } from '@/lib/rail-form';
import {
  confirmBudget, freeze, istDateTime, proposeRailChange, resetBreakerWithPostMortem, unfreeze,
} from '../../../../src/domain/controls';

export const dynamic = 'force-dynamic';

/**
 * The owner's safety controls, on the web.
 *
 * The same domain functions the Telegram bot calls. The bot runs only while the owner
 * has it open locally, so without this a freeze would depend on a laptop being on.
 * Authenticated by the middleware like every other route; the typed phrases for
 * unfreeze and reset are checked in the domain, not here, so both surfaces enforce them.
 */
type Body =
  | { action: 'freeze'; reason: string }
  | { action: 'unfreeze'; typed: string }
  | { action: 'reset_breaker'; typed: string }
  | { action: 'propose_rail'; key: string; value: number; note?: string }
  | { action: 'confirm_budget' };

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null) as Body | null;
  if (!body) return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  const d = await db();
  try {
    switch (body.action) {
      case 'freeze': {
        const { cancelled } = await freeze(d, body.reason ?? '');
        return NextResponse.json({ ok: true, message: `Frozen. ${cancelled.length} open request(s) cancelled.` });
      }
      case 'unfreeze':
        await unfreeze(d, body.typed ?? '');
        return NextResponse.json({ ok: true, message: 'Unfrozen. Cancelled requests stay cancelled.' });
      case 'reset_breaker': {
        const note = await resetBreakerWithPostMortem(d, body.typed ?? '');
        return NextResponse.json({ ok: true, message: `Breaker reset. Post-mortem recorded:\n${note}` });
      }
      case 'propose_rail': {
        if (typeof body.key !== 'string' || !validRailValue(body.key, body.value)) {
          return NextResponse.json({ error: invalidRailMessage(String(body.key)) }, { status: 400 });
        }
        if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 2_000)) {
          return NextResponse.json({ error: 'A note must be text of at most 2,000 characters.' }, { status: 400 });
        }
        const r = await proposeRailChange(d, body.key, body.value, new Date(), body.note);
        return NextResponse.json({
          ok: true,
          message: railChangeMessage(body.key, body.value, istDateTime(r.activatesAt), r.loosening),
        });
      }
      case 'confirm_budget':
        await confirmBudget(d, new Date());
        return NextResponse.json({ ok: true, message: "This month's budget is confirmed. The advisor runs at the next weekly report." });
      default:
        return NextResponse.json({ error: 'unknown action' }, { status: 400 });
    }
  } catch (e) {
    // A refusal — wrong phrase, drawdown too deep, unknown rail — is the owner's to read.
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
