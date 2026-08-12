import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Executes one or more statements over the simple protocol (DDL / migration files). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * In-memory/embedded Postgres for local dev and tests; postgres-js for Supabase.
 * Identical SQL runs on both — migrations must stay portable.
 */
export async function openDb(url = process.env.DATABASE_URL): Promise<Db> {
  if (!url || url.startsWith('pglite://')) {
    const dataDir = url ? url.slice('pglite://'.length) : undefined;
    const pg = dataDir ? new PGlite(dataDir) : new PGlite();
    await pg.waitReady;
    return {
      async query<T>(sql: string, params: unknown[] = []) {
        const res = await pg.query<T>(sql, params);
        return res.rows;
      },
      async exec(sql: string) {
        await pg.exec(sql);
      },
      async close() {
        await pg.close();
      },
    };
  }

  const sql = postgres(url, { max: 2, prepare: false });
  return {
    async query<T>(text: string, params: unknown[] = []) {
      return (await sql.unsafe(text, params as never[])) as unknown as T[];
    },
    async exec(text: string) {
      await sql.unsafe(text);
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
