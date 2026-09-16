import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { installIps } from '../domain/ips.js';
import { loadEnv } from '../config/env.js';
import { isMainModule } from '../util/main-module.js';
import { renderPage, type UiView } from './render.js';
import { parseScreenPaste } from '../sources/screener-screen.js';
import { importScreenRows } from '../sources/screener-screen.js';

export interface HttpResult {
  status: number;
  contentType: string;
  body: string;
}

function parseMultipart(req: IncomingMessage): Promise<{ fields: Map<string, string>; files: Map<string, Buffer[]> }> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] ?? '';
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) {
      reject(new Error('Missing boundary'));
      return;
    }
    const boundary = `--${boundaryMatch[1]}`;
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const parts = body.toString().split(boundary);
      const fields = new Map<string, string>();
      const files = new Map<string, Buffer[]>();
      for (const part of parts) {
        if (!part.trim() || part.trim() === '--') continue;
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd);
        const content = part.slice(headerEnd + 4).replace(/\r\n$/, '');
        const nameMatch = headers.match(/name="([^"]+)"/);
        if (!nameMatch?.[1]) continue;
        const name = nameMatch[1];
        const filenameMatch = headers.match(/filename="([^"]+)"/);
        if (filenameMatch?.[1]) {
          const arr = files.get(name) ?? [];
          arr.push(Buffer.from(content ?? '', 'utf8'));
          files.set(name, arr);
        } else {
          fields.set(name, content ?? '');
        }
      }
      resolve({ fields, files });
    });
    req.on('error', reject);
  });
}

export async function handleRequest(db: Db, urlPath: string, now: string, req?: IncomingMessage): Promise<HttpResult> {
  const path = (urlPath ?? '/').split('?')[0];
  try {
    if (path === '/screener/upload' && req && req.method === 'POST') {
      const { files } = await parseMultipart(req);
      const csvBuffers = files.get('csvs') ?? files.get('csv');
      if (!csvBuffers || csvBuffers.length === 0) {
        return { status: 400, contentType: 'application/json', body: '{"error":"csv file(s) required (field: csvs)"}' };
      }

      const results = [];
      let totalInserted = 0;
      const allWarnings: string[] = [];

      for (const csvBuffer of csvBuffers) {
        const text = csvBuffer.toString('utf8');
        const { rows, warnings } = parseScreenPaste(text);
        const importResult = await importScreenRows(db, rows, {
          asOf: new Date().toISOString().slice(0, 10),
          screenUrl: 'screener-web-upload',
        });
        totalInserted += importResult.inserted;
        allWarnings.push(...warnings, ...importResult.warnings);
        results.push({ uploadedId: importResult.uploadedId, inserted: importResult.inserted, warnings: [...warnings, ...importResult.warnings] });
      }

      return {
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ totalInserted, fileCount: csvBuffers.length, results, warnings: allWarnings }),
      };
    }

    let view: UiView | null = null;
    if (path === '/' || path === '/weekly') view = 'weekly';
    else if (path === '/digest') view = 'digest';
    else if (path === '/favicon.ico') return { status: 204, contentType: 'text/plain', body: '' };
    else return { status: 404, contentType: 'application/json; charset=utf-8', body: '{"error":"not found"}' };

    const body = await renderPage(db, now, view as UiView);
    return { status: 200, contentType: 'text/html; charset=utf-8', body };
  } catch (err) {
    return {
      status: 500,
      contentType: 'text/plain; charset=utf-8',
      body: `render failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function startServer(db: Db, opts: { port?: number; host?: string } = {}): Server {
  const port = opts.port ?? 8081;
  const host = opts.host ?? '127.0.0.1';
  return createServer(async (req, res) => {
    const result = await handleRequest(db, req.url ?? '/', new Date().toISOString(), req);
    res.writeHead(result.status, { 'Content-Type': result.contentType });
    res.end(result.body);
  }).listen(port, host);
}

if (isMainModule(import.meta.url)) {
  const env = loadEnv(process.env, []);
  const db = await openDb(env.databaseUrl);
  await runMigrations(db);
  await installIps(db);
  const server = startServer(db);
  console.log('Sentinel preview UI: http://127.0.0.1:8081/  (Ctrl+C to stop)');
  const shutdown = () => {
    server.close();
    void db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}