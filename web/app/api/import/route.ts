import { NextRequest, NextResponse } from 'next/server.js';
import { db } from '../../../lib/data.js';
import {
  archiveFiles,
  ensureWebIngestion,
  extractBrokerage,
  extractFidelity,
  insertUpload,
  type IngestKind,
} from '../../../lib/ingest.js';

export const dynamic = 'force-dynamic';

/** Owner uploads one or more statement pages. The file is archived immediately (a
 *  permanent record), then — if LLM_API_KEY is configured — either the brokerage or
 *  the Fidelity pipeline proposes costs/vests. Nothing is written until the owner
 *  confirms from /import. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const form = await req.formData();
    const kind = (form.get('kind') as string | null)?.toLowerCase();
    if (kind !== 'brokerage' && kind !== 'fidelity') {
      return NextResponse.json({ error: 'kind must be brokerage or fidelity' }, { status: 400 });
    }
    const files = form.getAll('files').filter((f): f is File => f instanceof File);
    if (files.length === 0) {
      return NextResponse.json({ error: 'no files uploaded' }, { status: 400 });
    }

    const pages = await archiveFiles(
      await Promise.all(files.map(async (f) => ({ name: f.name, mime: f.type, bytes: Buffer.from(await f.arrayBuffer()) }))),
    );

    const server = await db();
    await ensureWebIngestion(server);

    const key = process.env.LLM_API_KEY;
    if (!key) {
      const id = await insertUpload(server, {
        kind: kind as IngestKind,
        fileName: pages[0]!.fileName,
        storedPaths: pages.map((p) => p.storedPath),
        pageCount: pages.length,
        status: 'unusable',
        proposals: [],
        error: 'LLM_API_KEY not configured — set it in the repo-root .env and start the server again',
      });
      return NextResponse.json({
        id,
        status: 'unusable',
        error: 'LLM_API_KEY not configured',
        proposals: [],
      });
    }

    const proposals = kind === 'brokerage'
      ? await extractBrokerage(server, pages)
      : await extractFidelity(server, pages);

    const id = await insertUpload(server, {
      kind: kind as IngestKind,
      fileName: pages[0]!.fileName,
      storedPaths: pages.map((p) => p.storedPath),
      pageCount: pages.length,
      status: 'proposed',
      proposals,
    });

    return NextResponse.json({ id, status: 'proposed', proposals });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}