import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * On Vercel the app runs from a read-only `/var/task`, so archiving an upload under
 * `data/screenshots` threw `ENOENT: no such file or directory, mkdir '/var/task/data'`
 * and the whole import failed before the LLM was ever called. Extraction reads the
 * bytes from memory, so the upload can still work — it just must not claim to have
 * archived anything.
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: vi.fn(async () => { throw new Error("ENOENT: no such file or directory, mkdir '/var/task/data'"); }),
    writeFile: vi.fn(async () => { throw new Error('EROFS: read-only file system'); }),
  };
});

const { archiveFiles, insertUpload, NOT_ARCHIVED } = await import('../../web/lib/ingest.js');
const { ensureWebIngestion } = await import('../../web/lib/ingest.js');

describe('upload archiving on a read-only filesystem', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await ensureWebIngestion(db);
  });

  const file = { name: 'vest.png', mime: 'image/png', bytes: Buffer.from('not-a-real-png') };

  it('still returns the page, with the bytes the extractor needs', async () => {
    const [page] = await archiveFiles([file]);
    expect(page).toBeDefined();
    expect(page!.fileName).toBe('vest.png');
    expect(page!.mime).toBe('image/png');
    // The base64 is what reaches the LLM; losing the archive must not lose the upload.
    expect(Buffer.from(page!.base64, 'base64').toString()).toBe('not-a-real-png');
  });

  it('reports no stored path rather than inventing one', async () => {
    const [page] = await archiveFiles([file]);
    expect(page!.storedPath).toBeNull();
  });

  it('records the absence in words, since stored_path is NOT NULL', async () => {
    const pages = await archiveFiles([file]);
    const id = await insertUpload(db, {
      kind: 'fidelity',
      fileName: pages[0]!.fileName,
      storedPaths: pages.map((p) => p.storedPath),
      pageCount: pages.length,
      status: 'proposed',
      proposals: [],
    });
    const [row] = await db.query<{ stored_path: string }>(
      `select stored_path from web_uploads where id = $1`, [id],
    );
    expect(row!.stored_path).toBe(NOT_ARCHIVED);
    // A path-shaped string here would send the owner looking for a file that is not there.
    expect(row!.stored_path).not.toMatch(/data[\\/]screenshots/);
    await db.close();
  });
});
