import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/data';
import { approveMix } from '../../../../src/domain/fund-mix';

export const dynamic = 'force-dynamic';

/**
 * The owner signs the proposed fund mix whole (Decision 3). The band is what /funds showed;
 * a proposal that has moved since is refused. Authenticated by the middleware.
 */
type Body = { action: 'approve'; band: '15+' | '7-15' };

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.json().catch(() => null) as Body | null;
  if (!body) return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  if (body.action !== 'approve') return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  try {
    await approveMix(await db(), { band: body.band }, new Date().toISOString());
    return NextResponse.json({ ok: true, message: `Signed: the ${body.band} ranges are now the target.` });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 409 });
  }
}
