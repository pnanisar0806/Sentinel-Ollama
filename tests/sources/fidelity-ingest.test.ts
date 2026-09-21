import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { persistVests } from '../../src/domain/rsu.js';
import {
  checkFidelityVestExists,
  extractRsuVestsFromImage,
  fidelityVestsToProposals,
} from '../../src/sources/fidelity-ingest.js';
import { rateMicros, usdToInr } from '../../src/money/fx.js';
import { cents, mulP, rupees } from '../../src/money/paise.js';
import { UNITS_SCALE, toUnitsMicros } from '../../src/domain/rsu.js';

/** OpenRouter response shape `extractJsonFromImage` understands — hardwired only by the
 *  message-content path the real client reads. */
const llmReply = (content: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content } }] }),
});

describe('fidelityVestsToProposals', () => {
  it('prices vests at confirmVest scale — net ≤ recomputed gross, exact gross match', () => {
    const vests = [
      { grantId: '21RUIN4A1', vestOn: '2026-02-15', units: 120, priceUsd: 12.345, withholdingPct: 30 },
      { grantId: '26RSU', vestOn: '2026-08-15', units: 71.25, priceUsd: 185.47, withholdingPct: 30, netUnits: 49.875 },
    ];
    const rate = 95.3;
    const proposals = fidelityVestsToProposals(vests, rate);
    const micros = rateMicros(rate);

    proposals.forEach((p, i) => {
      // Derived from the REAL confirmVest recompute (`toUnitsMicros`/`UNITS_SCALE` in
      // rsu.ts), not retyped against fidelityVestsToProposals.
      const gross = usdToInr(cents((p.priceUsdCents * toUnitsMicros(vests[i]!.units)) / UNITS_SCALE), micros);
      const net = mulP(gross, (100 - vests[i]!.withholdingPct) / 100);
      expect(p.grossPaise).toBe(gross);
      expect(p.netPaise).toBe(net);
      expect(p.netPaise).toBeLessThanOrEqual(p.grossPaise);
      expect(p.usdInrMicros).toBe(micros);
      expect(p.confidence).toBe('HIGH');
    });
  });

  it('does not inflate USD gross by the old 10000x unit scale (shipped defect)', () => {
    const [maybeP] = fidelityVestsToProposals(
      [{ grantId: '26RSU', vestOn: '2026-08-15', units: 7.125, priceUsd: 185.47, withholdingPct: 30 }],
      95.3,
    );
    const p = maybeP!;
    const honest = usdToInr(cents((p.priceUsdCents * toUnitsMicros(7.125)) / UNITS_SCALE), p.usdInrMicros);
    // The bug: `priceCents * BigInt(Math.round(units * 10000))` — scale never divided off.
    const inflated = usdToInr(cents(p.priceUsdCents * BigInt(Math.round(7.125 * 10000))), p.usdInrMicros);
    expect(p.grossPaise).toBe(honest);
    expect(p.netPaise).toBeLessThanOrEqual(honest);
    expect(p.grossPaise).not.toBe(inflated);
  });
});

describe('extractRsuVestsFromImage', () => {
  it('maps a valid {vests:[…]} payload, stripping JSON fences and deriving netUnits when omitted', async () => {
    const fetchImpl = vi.fn(async () => llmReply('```json\n' + JSON.stringify({ vests: [
      { grantId: '21RUIN4A1', vestOn: '2026-02-15', units: 120, priceUsd: 12.345, withholdingPct: 30 },
      { grantId: '21RUIN4A3', vestOn: '2026-05-15', units: 7.125, priceUsd: 185.47, withholdingPct: 30, netUnits: 4.9875 },
    ] }) + '\n```'));
    const out = await extractRsuVestsFromImage({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiKey: 'test-key',
      images: [{ base64: 'aGVsbG8=', mimeType: 'image/png' }],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      grantId: '21RUIN4A1', vestOn: '2026-02-15', units: 120, priceUsd: 12.345,
      withholdingPct: 30, netUnits: 84,
    });
    expect(out[1]!.netUnits).toBe(4.9875);
  });

  it('drops vests with any unreadable field (FR-02 — never guess), netUnits fallback on bad value', async () => {
    const fetchImpl = vi.fn(async () => llmReply(JSON.stringify({ vests: [
      { grantId: '', vestOn: '2026-02-15', units: 120, priceUsd: 10, withholdingPct: 30 },
      { grantId: 'G', vestOn: '15-02-2026', units: 120, priceUsd: 10, withholdingPct: 30 },
      { grantId: 'G', vestOn: '2026-02-15', units: 0, priceUsd: 10, withholdingPct: 30 },
      { grantId: 'G', vestOn: '2026-02-15', units: 120, priceUsd: -1, withholdingPct: 30 },
      { grantId: 'G', vestOn: '2026-02-15', units: 120, priceUsd: 10, withholdingPct: 130 },
      { grantId: 'G', vestOn: '2026-02-15', units: Number.NaN, priceUsd: 10, withholdingPct: 30 },
      { grantId: 'G', vestOn: '2026-02-15', units: 120, priceUsd: 10, withholdingPct: 30, netUnits: -1 },
    ] })));
    const out = await extractRsuVestsFromImage({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      apiKey: 'test-key',
      images: [{ base64: 'aGVsbG8=', mimeType: 'image/png' }],
    });
    expect(out).toHaveLength(1);
    // The only survivor is the last vest: only its netUnits is bad, so it derives.
    expect(out[0]!.grantId).toBe('G');
    expect(out[0]!.netUnits).toBe(84);
  });

  it('returns [] for shapes that carry no vests array', async () => {
    for (const content of ['null', '{"items":[]}', '{"vests":"nope"}', '{"vests":[42]}']) {
      const fetchImpl = vi.fn(async () => llmReply(content));
      const out = await extractRsuVestsFromImage({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        apiKey: 'test-key',
        images: [{ base64: 'aGVsbG8=', mimeType: 'image/png' }],
      });
      expect(out).toEqual([]);
    }
  });
});

describe('checkFidelityVestExists (real PGlite)', () => {
  let db: Db;
  let dir: string;

  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
    dir = await mkdtemp(path.join(os.tmpdir(), 'sentinel-'));
  });

  afterEach(async () => {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('reports only ACTUAL rows as duplicates', async () => {
    expect(await checkFidelityVestExists(db, '26RSU', '2026-08-15')).toBe(false);
    // Persist a PROJECTED row — the queue filter must NOT skip on it.
    const gross = rupees(100_000);
    await persistVests(db, [{
      grantId: '26RSU', vestOn: '2026-08-15', units: 5, status: 'PROJECTED',
      grossPaise: gross, netPaise: mulP(gross, 0.7),
    }], { asOf: '2026-09-01T00:00:00Z' });
    expect(await checkFidelityVestExists(db, '26RSU', '2026-08-15')).toBe(false);
  });
});