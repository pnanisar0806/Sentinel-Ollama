import { createServer, type Server } from 'node:http';
import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { installIps } from '../domain/ips.js';
import { loadEnv } from '../config/env.js';
import { isMainModule } from '../util/main-module.js';
import { renderPage, type UiView } from './render.js';

export interface HttpResult {
  status: number;
  contentType: string;
  body: string;
}

export async function handleRequest(db: Db, urlPath: string, now: string): Promise<HttpResult> {
  const path = (urlPath ?? '/').split('?')[0];
  try {
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
    const result = await handleRequest(db, req.url ?? '/', new Date().toISOString());
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