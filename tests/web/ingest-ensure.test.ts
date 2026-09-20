import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { ensureWebIngestion, resetWebIngestionCacheForTests } from '../../web/lib/ingest.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

// ingest.ts resolves the repo root as `process.cwd()/..`, which is only correct when
// the process was started from web/ (as `next dev` and `next start` are). vitest runs
// from the repo root, so the bootstrap branch has to be exercised from web/ to match
// the real caller.
const WEB_DIR = fileURLToPath(new URL('../../web', import.meta.url));
const ORIGINAL_CWD = process.cwd();

describe('ensureWebIngestion', () => {
  beforeEach(() => {
    resetWebIngestionCacheForTests();
    vi.mocked(readFile).mockClear();
    process.chdir(ORIGINAL_CWD);
  });

  afterAll(() => process.chdir(ORIGINAL_CWD));

  // Not a virgin database: 0009_web_uploads.sql calls sentinel_append_only(), which an
  // earlier migration defines, so the file can only ever be replayed on a schema that
  // already has the rest. The reachable case is the table having been dropped.
  it('recreates web_uploads from the migration file when the table is missing', async () => {
    const db = await openDb();
    await runMigrations(db);
    await db.exec('drop table web_uploads cascade');
    resetWebIngestionCacheForTests();

    process.chdir(WEB_DIR);
    await ensureWebIngestion(db);

    const [row] = await db.query<{ present: boolean }>(
      "select to_regclass('public.web_uploads') is not null as present",
    );
    expect(row?.present).toBe(true);
    await db.close();
  });

  // The regression: migrations/ is not bundled into the Vercel serverless output, so
  // reading the .sql file on an already-migrated database throws ENOENT and takes the
  // whole /import page down. On a migrated database the file must never be touched.
  it('never reads the migration file when web_uploads already exists', async () => {
    const db = await openDb();
    await runMigrations(db);
    vi.mocked(readFile).mockClear();

    await ensureWebIngestion(db);

    const readMigration = vi
      .mocked(readFile)
      .mock.calls.filter(([p]) => String(p).includes('0009_web_uploads.sql'));
    expect(readMigration).toEqual([]);
    await db.close();
  });
});
