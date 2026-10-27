import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { parseMfSips } from '../../src/sources/indmoney.js';
import { loadFreeEnvelope, persistSipSnapshot } from '../../src/domain/sips.js';
import { approveMix, proposeMix } from '../../src/domain/fund-mix.js';
import { db, getSipSuggestions } from '../../web/lib/data.js';

const live = parseMfSips({
  result: JSON.stringify(JSON.parse(await readFile('tests/fixtures/indmoney-mf-sips-2026-10-14.json', 'utf8')).payload),
});

/** Piece 3 Task 9: /funds "Suggested SIPs". One web `db()` singleton: the cases run in order. */
describe('getSipSuggestions', () => {
  beforeAll(async () => {
    await runMigrations(await db());
    await persistSipSnapshot(await db(), live, new Date(Date.now() - 8 * 86_400_000).toISOString());
  });

  it('no signed mix: no suggestions', async () => {
    expect(await getSipSuggestions()).toEqual({ rows: null, reason: 'approve the fund mix first' });
  });

  it('a stale SIP snapshot withholds the suggestion with the envelope reason, never zeros', async () => {
    const now = new Date().toISOString();
    const p = proposeMix(now);
    if (p.band === null) throw new Error('fixture expects a proposal');
    await approveMix(await db(), { band: p.band }, now);
    const reason = (await loadFreeEnvelope(await db(), now)).reason;
    expect(reason).toMatch(/older than 7 days/);
    expect(await getSipSuggestions()).toEqual({ rows: null, reason });
  });

  it('fresh SIPs: rows keep the live total', async () => {
    await persistSipSnapshot(await db(), live, new Date().toISOString());
    const r = await getSipSuggestions();
    if (r.rows === null) throw new Error(r.reason);
    const total = live.reduce((a, s) => a + s.amountPaise, 0n);
    expect(r.totalPaise).toBe(total);
    expect(r.rows.reduce((a, s) => a + s.suggestedPaise, 0n)).toBe(total);
    expect(r.rows.reduce((a, s) => a + s.currentPaise, 0n)).toBe(total);
  });
});
