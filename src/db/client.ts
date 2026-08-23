import { PGlite } from '@electric-sql/pglite';
import postgres from 'postgres';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Executes one or more statements over the simple protocol (DDL / migration files). */
  exec(sql: string): Promise<void>;
  /** Runs fn inside a transaction on a single pinned connection; rolls back if fn throws. */
  withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * In-memory/embedded Postgres for local dev and tests; postgres-js for Supabase.
 * Identical SQL runs on both — migrations must stay portable.
 */
export async function openDb(url = process.env.DATABASE_URL): Promise<Db> {
  // An unset GitHub secret interpolates to '', not undefined. Treating that as
  // "use the embedded PGlite" gave a confident Rs 0 digest and exit 0.
  if (url !== undefined && url.trim() === '') {
    throw new Error('DATABASE_URL is set but empty — refusing to fall back to embedded PGlite');
  }
  if (!url || url.startsWith('pglite://')) {
    const dataDir = url ? url.slice('pglite://'.length) : undefined;
    const pg = dataDir ? new PGlite(dataDir) : new PGlite();
    await pg.waitReady;

    const dbImpl: Db = {
      async query<T>(sql: string, params: unknown[] = []) {
        const res = await pg.query<T>(sql, params);
        return res.rows;
      },
      async exec(sql: string) {
        await pg.exec(sql);
      },
      async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
        await pg.exec('begin');
        try {
          const result = await fn(dbImpl);
          await pg.exec('commit');
          return result;
        } catch (error) {
          await pg.exec('rollback');
          throw error;
        }
      },
      async close() {
        await pg.close();
      },
    };
    return dbImpl;
  }

  const sql = postgres(url, { max: 2, prepare: false });
  return {
    async query<T>(text: string, params: unknown[] = []) {
      return (await sql.unsafe(text, params as never[])) as unknown as T[];
    },
    async exec(text: string) {
      await sql.unsafe(text);
    },
    async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      return (await sql.begin(async (tx) => {
        const txDb: Db = {
          async query<T>(text: string, params: unknown[] = []) {
            return (await tx.unsafe(text, params as never[])) as unknown as T[];
          },
          async exec(text: string) {
            await tx.unsafe(text);
          },
          async withTransaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
            // No nesting; just invoke with itself
            return fn(txDb);
          },
          async close() {
            // No-op; outer pool owns the lifecycle
          },
        };
        return fn(txDb);
      })) as unknown as T;
    },
    async close() {
      await sql.end({ timeout: 5 });
    },
  };
}
