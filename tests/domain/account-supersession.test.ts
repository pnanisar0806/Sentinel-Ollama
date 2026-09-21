import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { loadPositions } from '../../src/domain/networth.js';

/**
 * Supersession is per ACCOUNT for a source that publishes a whole broker book.
 *
 * The rule it replaces matched identities, and a lump placeholder can never match a
 * constituent set — so `BASKET_PLACEHOLDERS` had to name the smallcase residue and the
 * INDmoney basket by hand, a list needing a new entry per invented placeholder. It also
 * missed `CASH:SAVINGS`, whose canonical `CASH:SAVINGS_HDFC_FEDERAL` matched neither
 * live bank row (both carry NULL canonical_id), double counting ₹1,63,000 of cash — the
 * figure the owner's 10% cash ceiling was judged against.
 *
 * The fixture is built here rather than from `seed()`, so the rule is tested directly
 * and does not drift when seed contents change.
 */
describe('per-account supersession', () => {
  let db: Db;
  let day = 0;

  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    day = 0;
  });

  interface Row {
    id: string; account: string; paise: bigint; kind?: string; canonical?: string | null;
  }

  /** One snapshot per source: loadPositions keeps only the LATEST snapshot per source,
   *  so a snapshot per row would silently drop everything but the last. */
  const put = async (source: string, rows: Row[]) => {
    for (const r of rows) {
      await db.query(
        `insert into instruments (id, kind, name, currency, canonical_id)
         values ($1, $2, $1, 'INR', $3) on conflict (id) do nothing`,
        [r.id, r.kind ?? 'CASH', r.canonical ?? null],
      );
    }
    day += 1;
    const [snap] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source)
       values (date '2026-09-01' + $1::int, $2) returning id`,
      [day, source],
    );
    for (const r of rows) {
      await db.query(
        `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
         values ($1, $2, $3, 1, $4, $5, timestamptz '2026-09-19T12:00:00Z')`,
        [snap!.id, r.id, r.account, r.paise.toString(), source],
      );
    }
  };

  const ids = async () => (await loadPositions(db)).map((p) => p.instrumentId);

  it('retires a seed row on an account indmoney owns, with no identity match', async () => {
    await put('manual-seed', [
      { id: 'CASH:SAVINGS', account: 'bank', paise: 16_300_000n,
        canonical: 'CASH:SAVINGS_HDFC_FEDERAL' },
    ]);
    expect(await ids()).toContain('CASH:SAVINGS');

    // Neither live bank row carries a canonical id, so NO identity match is possible.
    // Only account coverage can retire the seeded cash — this is the exact case the
    // previous rule missed.
    await put('indmoney', [
      { id: 'IND:HDFC-BANK', account: 'bank', paise: 12_647_172n },
      { id: 'IND:STATE-BANK-OF-INDIA', account: 'bank', paise: 11_987_703n },
    ]);

    expect(await ids()).not.toContain('CASH:SAVINGS');
    const cash = (await loadPositions(db)).filter((p) => p.assetClass === 'CASH');
    expect(cash.reduce((a, p) => a + p.valuePaise, 0n)).toBe(24_634_875n);
  });

  it('retires a lump placeholder without naming it in any list', async () => {
    await put('manual-seed', [{ id: 'NSE:SMALLCASE-RESIDUE', account: 'zerodha',
      paise: 65_540_000n, kind: 'EQUITY', canonical: 'NSE:SMALLCASE-RESIDUE' }]);
    await put('indmoney', [{ id: 'IND:INDS19182', account: 'zerodha',
      paise: 9_141_979n, kind: 'ETF' }]);

    // A lump can never match a constituent set by identity. Account coverage needs no
    // hardcoded BASKET_PLACEHOLDERS entry, so a future placeholder is handled too.
    expect(await ids()).not.toContain('NSE:SMALLCASE-RESIDUE');
  });

  it('keeps a seed row on an account no live source reports', async () => {
    await put('manual-seed', [{ id: 'US:NOW', account: 'fidelity',
      paise: 107_297_400n, kind: 'RSU' }]);
    await put('indmoney', [{ id: 'IND:HDFC-BANK', account: 'bank', paise: 12_647_172n }]);

    // The Fidelity RSU is the real gap-fill: INDmoney never serves it.
    expect(await ids()).toContain('US:NOW');
  });

  it('does NOT let a non-authoritative source retire a whole account', async () => {
    await put('manual-seed', [
      { id: 'NSE:NIFTYBEES', account: 'zerodha', paise: 9_500_000n, kind: 'ETF' },
      { id: 'NSE:GOLDBEES', account: 'zerodha', paise: 6_300_000n, kind: 'GOLD' },
    ]);
    // `composite` emits ONE zerodha row. That does not make it authoritative for the
    // account: inferring authority from a row would delete both seed holdings above and
    // the money would vanish with nothing live replacing it.
    await put('composite', [{ id: 'NSE:SOMETHING-ELSE', account: 'zerodha',
      paise: 100n, kind: 'EQUITY' }]);

    const after = await ids();
    expect(after).toContain('NSE:NIFTYBEES');
    expect(after).toContain('NSE:GOLDBEES');
  });

  it('still retires on identity when the source is not account-authoritative', async () => {
    await put('manual-seed', [{ id: 'NSE:NIFTYBEES', account: 'zerodha',
      paise: 9_500_000n, kind: 'ETF', canonical: 'NSE:INDS19182' }]);
    await put('composite', [{ id: 'X:BEES', account: 'zerodha',
      paise: 9_141_979n, kind: 'ETF', canonical: 'NSE:INDS19182' }]);

    // The canonical/key fallback is intact, so the old behaviour is not lost.
    expect(await ids()).not.toContain('NSE:NIFTYBEES');
  });
});
