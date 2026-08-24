import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/client.js';

/**
 * An unset GitHub secret interpolates to the empty string. `openDb` treated that
 * as "use the embedded PGlite", so a typo'd DATABASE_URL produced a confident
 * Rs 0 net-worth digest and exit 0 instead of failing loudly.
 */
describe('openDb rejects a blank DATABASE_URL', () => {
  it('throws when the url is present but empty', async () => {
    await expect(openDb('')).rejects.toThrow(/DATABASE_URL/);
  });

  it('throws when the url is whitespace only', async () => {
    await expect(openDb('   ')).rejects.toThrow(/DATABASE_URL/);
  });

  it('still defaults to embedded PGlite when the url is genuinely absent', async () => {
    const db = await openDb(undefined);
    const rows = await db.query<{ one: number }>('select 1 as one');
    expect(rows[0]?.one).toBe(1);
    await db.close();
  });
});
