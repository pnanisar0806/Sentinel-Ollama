import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { persistSchedules, runCascade, type LoanInput } from '../../src/domain/loans.js';
import { SEED_HOLDINGS, SEED_LOANS } from '../../src/seed/seed-data.js';
import { classify, loadPositions, netWorth, outstandingLiabilities } from '../../src/domain/networth.js';
import { addP, type Paise } from '../../src/money/paise.js';

/** The business date the suite seeds at. Every derived expectation hangs off this. */
const SEED_DATE = '2026-08-12';
const FROM_MONTH = '2026-09-01';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: SEED_DATE });
  await persistSchedules(db, FROM_MONTH);
});

/** Sum of the seed's own holding lines — the independent side of the assets assertion. */
const seedAssets = (): Paise => addP(...SEED_HOLDINGS.map((h) => h.valuePaise));

describe('net worth', () => {
  it('includes Fidelity NOW and EPF, which no other tool the owner has can see', async () => {
    const positions = await loadPositions(db);
    const nw = netWorth(positions, 0n as Paise);

    expect(nw.byAccount.get('fidelity')).toBe(107_297_400n);
    expect(nw.byAccount.get('epf')).toBe(1_354_000_00n);

    // Exact, not a band. Both figures are fully determined by seed data, so a wide
    // band would only hide a transcription slip (MEMORY.md).
    expect(nw.assetsPaise).toBe(seedAssets());
    expect(nw.assetsPaise).toBe(534_197_361n); // Rs 53,41,973.61 (updated for current Fidelity reality)
  });

  it('partitions assets across accounts and asset classes without loss', async () => {
    const positions = await loadPositions(db);
    const nw = netWorth(positions, 0n as Paise);
    const sum = (m: Map<string, Paise>) => [...m.values()].reduce((a, b) => a + b, 0n);

    expect(sum(nw.byAccount as Map<string, Paise>)).toBe(nw.assetsPaise);
    expect(sum(nw.byAssetClass as Map<string, Paise>)).toBe(nw.assetsPaise);
  });

  it('subtracts outstanding loans to give a true net figure', async () => {
    const positions = await loadPositions(db);
    const liabilities = await outstandingLiabilities(db, FROM_MONTH);
    const nw = netWorth(positions, liabilities);

    expect(nw.netPaise).toBe(nw.assetsPaise - nw.liabilitiesPaise);

    // Derived side: the cascade model's own closing balances for the same month.
    const loans: LoanInput[] = SEED_LOANS.map((l) => ({
      id: l.id, outstandingPaise: l.outstandingPaise, annualRateBps: l.annualRateBps,
      emiPaise: l.emiPaise, cascadeOrder: l.cascadeOrder,
    }));
    const { rows } = runCascade(loans, FROM_MONTH);
    const expected = addP(
      ...rows.filter((r) => r.month === FROM_MONTH).map((r) => r.closingPaise),
    );

    expect(liabilities).toBe(expected);
    expect(liabilities).toBe(362_197_595n); // Rs 36,21,975.95 after one month of EMIs
  });

  it('falls back to the loan balance for a month before its schedule begins', async () => {
    // The schedule starts at FROM_MONTH. A plain `period_month <= $1` lookup returns no
    // row for an earlier month and would silently report ZERO liabilities against a real
    // Rs 36.53L owed - a net-worth overstatement, not a rounding issue.
    const before = await outstandingLiabilities(db, '2026-08-01');
    expect(before).toBe(addP(...SEED_LOANS.map((l) => l.outstandingPaise)));
    expect(before).toBe(365_335_400n); // Rs 36,53,354
  });

  it('reports zero liabilities once the cascade has closed every loan', async () => {
    expect(await outstandingLiabilities(db, '2034-01-01')).toBe(0n);
  });

  it('classifies EPF and liquid ETF as debt, gold ETF as gold', async () => {
    const positions = await loadPositions(db);
    const byId = new Map(positions.map((p) => [p.instrumentId, p]));
    expect(byId.get('EPF:ANIRBAN')!.assetClass).toBe('DEBT');
    expect(byId.get('NSE:LIQUIDBEES')!.assetClass).toBe('DEBT');
    expect(byId.get('NSE:GOLDBEES')!.assetClass).toBe('GOLD');
    expect(byId.get('US:NOW')!.assetClass).toBe('EQUITY');
    expect(byId.get('CASH:SAVINGS')!.assetClass).toBe('CASH');
    expect(byId.get('BOND:SAMMAAN-2026')!.assetClass).toBe('DEBT');
    expect(byId.get('MF:PPFC')!.assetClass).toBe('EQUITY');
  });

  it('refuses to classify a LOAN instrument as an asset', () => {
    // instruments.kind admits 'LOAN' (schema check constraint) but a liability must
    // never be summed into assets. Silently classifying it EQUITY was the fallthrough.
    expect(() => classify('LOAN', 'LOAN:HOME', 'Home loan')).toThrow(/LOAN/);
  });

  it('carries as_of and source on every position for the staleness engine', async () => {
    const positions = await loadPositions(db);
    expect(positions.length).toBe(SEED_HOLDINGS.length);
    expect(positions.every((p) => p.asOf && p.source)).toBe(true);

    // Truthiness of two NOT NULL columns proves almost nothing. Pin the actual instant
    // and the actual source so a mapper reading the wrong column also goes red.
    const wanted = Date.parse(`${SEED_DATE}T00:00:00+05:30`);
    expect(positions.every((p) => Date.parse(p.asOf) === wanted)).toBe(true);
    expect(new Set(positions.map((p) => p.source))).toEqual(new Set(['manual-seed']));
  });

  it('carries the instrument sector through so the sector cap is computable', async () => {
    const positions = await loadPositions(db);
    const byId = new Map(positions.map((p) => [p.instrumentId, p]));
    expect(byId.get('US:NOW')!.sector).toBe('Technology');
    expect(byId.get('NSE:RPOWER')!.sector).toBe('Power');
    expect(byId.get('CASH:SAVINGS')!.sector).toBeNull();
  });

  it('preserves unknown cost as null rather than coercing to zero', async () => {
    const positions = await loadPositions(db);
    const byId = new Map(positions.map((p) => [p.instrumentId, p]));
    expect(byId.get('EPF:ANIRBAN')!.avgCostPaise).toBeNull();
    expect(byId.get('BOND:SAMMAAN-2026')!.avgCostPaise).toBe(284_057_70n);

    const unknown = positions.filter((p) => p.avgCostPaise === null).length;
    expect(unknown).toBe(SEED_HOLDINGS.filter((h) => h.avgCostPaise === null).length);
  });
});

describe('loadPositions snapshot selection', () => {
  /** Inserts a snapshot plus one holding, returning nothing the caller needs. */
  async function addSnapshot(
    source: string, businessDate: string, takenAt: string,
    instrumentId: string, valuePaise: bigint, account = 'zerodha',
  ): Promise<void> {
    const [row] = await db.query<{ id: string }>(
      `insert into snapshots (business_date, source, taken_at) values ($1,$2,$3) returning id`,
      [businessDate, source, takenAt],
    );
    await db.query(
      `insert into holdings (snapshot_id, instrument_id, quantity, avg_cost_paise,
         value_paise, account, as_of, source)
       values ($1,$2,1,null,$3,$4,$5,$6)`,
      [row!.id, instrumentId, valuePaise.toString(), account, `${businessDate}T00:00:00+05:30`, source],
    );
  }

  it('takes only the latest snapshot per source and merges across sources', async () => {
    await addSnapshot('manual-seed', '2026-07-01', '2026-07-01T00:00:00Z', 'NSE:NIFTYBEES', 111_11n);
    await addSnapshot('kite', '2026-08-10', '2026-08-10T00:00:00Z', 'NSE:RPOWER', 222_22n, 'zerodha');

    const positions = await loadPositions(db);
    const values = positions.map((p) => p.valuePaise);

    expect(values).not.toContain(111_11n);          // older same-source snapshot dropped
    expect(values.filter((v) => v === 222_22n)).toHaveLength(1); // other source merged in
    // The kite RPOWER shares the seed RPOWER's canonical id AND account, so the
    // seed placeholder retires (C-A): 20 seed rows - 1 retired + 1 live = 20.
    expect(positions.length).toBe(SEED_HOLDINGS.length);
    expect(new Set(positions.map((p) => p.source))).toEqual(new Set(['manual-seed', 'kite']));
  });

  /**
   * This used to assert that a SECOND same-day snapshot for the same source won on
   * `taken_at`. Migration 0003 makes that state impossible: `snapshots` now carries
   * `unique (business_date, source)`, because the select-then-insert in writeSnapshot
   * was check-then-act and two racing syncs could double-count the portfolio.
   * The stronger property is that the ambiguity cannot arise at all. The `order by
   * taken_at desc` in loadPositions stays as defence in depth.
   */
  it('cannot have a same-day tie to break: the schema refuses the duplicate', async () => {
    await expect(
      addSnapshot('manual-seed', SEED_DATE, '2999-01-01T00:00:00Z', 'NSE:NIFTYBEES', 333_33n),
    ).rejects.toThrow();

    const positions = await loadPositions(db);
    expect(positions.map((p) => p.valuePaise)).not.toContain(333_33n);
  });

  it('honours the businessDate cutoff', async () => {
    await addSnapshot('manual-seed', '2026-07-01', '2026-07-01T00:00:00Z', 'NSE:NIFTYBEES', 111_11n);
    await addSnapshot('kite', '2026-08-10', '2026-08-10T00:00:00Z', 'NSE:RPOWER', 222_22n);

    const positions = await loadPositions(db, '2026-07-15');
    expect(positions.map((p) => p.valuePaise)).toEqual([111_11n]);
  });
});
