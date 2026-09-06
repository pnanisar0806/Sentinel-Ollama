import { NextRequest, NextResponse } from 'next/server.js';
import { db } from '../../../../../lib/data.js';
import { rejectUpload } from '../../../../../lib/ingest.js';

export const dynamic = 'force-dynamic';

/** Owner said no: nothing writes, the queue row is filed as rejected. */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const { id } = await params;
    await rejectUpload(await db(), id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith('no such upload') || message.includes('not pending') ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}