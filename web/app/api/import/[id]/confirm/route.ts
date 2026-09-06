import { NextRequest, NextResponse } from 'next/server.js';
import { db } from '../../../../../lib/data.js';
import { confirmUpload } from '../../../../../lib/ingest.js';

export const dynamic = 'force-dynamic';

/** Owner said yes: write the approved proposals through the platform functions
 *  (exactly the bot's /confirm path) and file the queue row as confirmed. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const { id } = await params;
    let indexes: number[] | undefined;
    try {
      const body: unknown = await req.json();
      if (body && typeof body === 'object' && 'indexes' in body) {
        const raw = (body as { indexes?: unknown }).indexes;
        if (raw != null) {
          if (!Array.isArray(raw) || raw.some((i) => typeof i !== 'number')) {
            return NextResponse.json({ error: 'indexes must be an array of numbers' }, { status: 400 });
          }
          indexes = raw as number[];
        }
      }
    } catch {
      // empty body = confirm all
    }
    const result = await confirmUpload(await db(), id, indexes);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith('no such upload') || message.includes('not pending') ? 404 : message.startsWith('no proposal') ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}