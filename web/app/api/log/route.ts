import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/data';
import {
  completeMilestone, logEarmark, logGoalMove, logNote, logPurchase, logSale, logSipMove, logSpend, type EarmarkEnd, type GoalMoveKind,
} from '../../../../src/domain/owner-log';
import { reverseEntry, type ReversalEntity } from '../../../../src/domain/reversals';
import { loadGoalTracker } from '../../../../src/domain/goal-plan';
import type { Db } from '../../../../src/db/client';
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
  | { action: 'note'; on: string; text: string }
  | { action: 'purchase'; on: string; rupees: string; description: string; instrumentId?: string; units?: string; note?: string }
  | { action: 'sale'; on: string; instrumentId: string; units?: string; rupees: string; destination?: string; label?: string; note?: string }
  | { action: 'spend'; on: string; rupees: string; purpose: string; from: 'B2' | 'B3' | 'B4' | 'SP' | 'BANK'; label?: string; note?: string }
  | { action: 'earmark'; on: string; rupees: string; from: EarmarkEnd; to: EarmarkEnd; label?: string; expectedOn?: string; note?: string }
  | { action: 'sip_move'; on: string; fromInstrumentId: string; toInstrumentId: string; rupees: string; firstMonth: string; note?: string }
  | { action: 'reverse'; entity: ReversalEntity; entityId: string; reason: string };

/** Optional exact decimal units; '' is none. The column's own error is not readable. */
function units(text: string | undefined): string | null {
  const u = (text ?? '').trim();
  if (u === '') return null;
  if (!(/^\d+(\.\d+)?$/.test(u) && /[1-9]/.test(u))) throw new Error(`"${u}" is not a positive number of units`);
  return u;
}

/**
 * The FI corpus for an earmark from FI: the goal tracker's FI pots (only web/ may read
 * goal status). Null when the tracker or its pots are unknown; the domain then refuses.
 */
async function fiCorpus(d: Db): Promise<bigint | null> {
  try {
    const p = (await loadGoalTracker(d, new Date().toISOString())).fiPots;
    return p === null ? null : p.equity + p.debt + p.gold + p.cash;
  } catch {
    return null;
  }
}

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
      case 'purchase': {
        await logPurchase(d, {
          boughtOn: body.on, description: body.description ?? '', amountPaise: paise(body.rupees ?? ''),
          instrumentId: body.instrumentId || null, units: units(body.units), note: body.note ?? '',
        });
        return NextResponse.json({ ok: true, message: 'Purchase recorded against that month’s budget. Holdings and allocation update separately through the daily holdings sync.' });
      }
      case 'sale': {
        const u = units(body.units);
        const destination = (body.destination || null) as 'B2' | 'B3' | 'B4' | 'SP' | null;
        await logSale(d, {
          on: body.on, instrumentId: body.instrumentId ?? '', units: u === null ? null : Number(u), proceedsPaise: paise(body.rupees ?? ''),
          destination, label: body.label, note: body.note ?? '',
        });
        return NextResponse.json({ ok: true, message: destination
          ? 'Sale recorded and the money added to that pot. The bank balance and holdings catch up at the next sync.'
          : 'Sale recorded. The bank balance and holdings catch up at the next sync.' });
      }
      case 'spend':
        await logSpend(d, { on: body.on, amountPaise: paise(body.rupees ?? ''), purpose: body.purpose ?? '', from: body.from, label: body.label, note: body.note ?? '' });
        return NextResponse.json({ ok: true, message: body.from === 'BANK' ? 'Spend noted on the timeline.' : 'Spend recorded; that pot is smaller by it.' });
      case 'earmark':
        await logEarmark(d, {
          on: body.on, from: body.from, to: body.to, amountPaise: paise(body.rupees ?? ''), label: body.label, expectedOn: body.expectedOn,
          note: body.note ?? '', fiCorpusPaise: body.from === 'FI' ? await fiCorpus(d) : null,
        });
        return NextResponse.json({ ok: true, message: 'Earmark recorded.' });
      case 'sip_move':
        await logSipMove(d, {
          on: body.on, fromInstrumentId: body.fromInstrumentId ?? '', toInstrumentId: body.toInstrumentId ?? '',
          amountPaise: paise(body.rupees ?? ''), firstMonth: body.firstMonth ?? '', note: body.note ?? '',
        });
        return NextResponse.json({ ok: true, message: 'SIP move recorded.' });
      case 'reverse':
        await reverseEntry(d, { entity: body.entity, entityId: body.entityId ?? '', reason: body.reason ?? '' }, new Date().toISOString());
        return NextResponse.json({ ok: true, message: 'Reversed. The original stays on the timeline, struck through.' });
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
