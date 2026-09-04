import { beforeEach, describe, expect, it } from 'vitest';
import {
  allocationDrift, concentration, CAPS, IPS_BANDS, SECTOR_COVERAGE_CAVEAT,
} from '../../src/domain/allocation.js';
import { addP, paise, rupees, type Paise } from '../../src/money/paise.js';
import type { AssetClass, Position } from '../../src/domain/networth.js';
import { loadPositions, netWorth } from '../../src/domain/networth.js';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';

const pos = (
  o: Partial<Position> & { instrumentId: string; valuePaise: Paise; assetClass: AssetClass },
): Position => ({
  kind: 'EQUITY', account: 'zerodha', avgCostPaise: null, issuer: null, sector: null,
  isEmployer: false, asOf: '2026-08-12T00:00:00+05:30', source: 'test', ...o,
} as Position);

const classMap = (entries: [AssetClass, Paise][]) => new Map<AssetClass, Paise>(entries);

describe('IPS bands', () => {
  it('caps equity at 60% and bands gold 5-10% (PRD 3.3)', () => {
    expect(IPS_BANDS.EQUITY.max).toBe(0.60);
    expect(IPS_BANDS.GOLD.min).toBe(0.05);
    expect(IPS_BANDS.GOLD.max).toBe(0.10);
  });
});

describe('allocationDrift', () => {
  it('flags an equity overweight beyond the ceiling', () => {
    const byClass = classMap([['EQUITY', rupees(700_000)], ['DEBT', rupees(300_000)]]);
    const rows = allocationDrift(byClass, rupees(1_000_000));
    const equity = rows.find((r) => r.assetClass === 'EQUITY')!;
    expect(equity.actual).toBeCloseTo(0.70, 4);
    expect(equity.breach).toBe('OVER');
    expect(equity.driftPaise).toBe(rupees(100_000)); // 10% of 10L to sell
  });

  it('flags a gold underweight below the band', () => {
    const byClass = classMap([
      ['EQUITY', rupees(500_000)], ['GOLD', rupees(10_000)], ['DEBT', rupees(490_000)],
    ]);
    const rows = allocationDrift(byClass, rupees(1_000_000));
    const gold = rows.find((r) => r.assetClass === 'GOLD')!;
    expect(gold.breach).toBe('UNDER');
    expect(gold.driftPaise).toBe(rupees(40_000)); // buy up to the 5% floor
  });

  it('reports no breach inside the bands, and zero drift with it', () => {
    const byClass = classMap([
      ['EQUITY', rupees(550_000)], ['GOLD', rupees(70_000)], ['DEBT', rupees(380_000)],
    ]);
    const rows = allocationDrift(byClass, rupees(1_000_000));
    expect(rows.every((r) => r.breach === null)).toBe(true);
    expect(rows.every((r) => r.driftPaise === 0n)).toBe(true);
  });

  it('returns a row for every asset class even when unheld', () => {
    const rows = allocationDrift(classMap([['EQUITY', rupees(100_000)]]), rupees(100_000));
    expect(rows.map((r) => r.assetClass).sort()).toEqual(['CASH', 'DEBT', 'EQUITY', 'GOLD']);
  });

  it('derives the total from the map when none is supplied', () => {
    const byClass = classMap([['EQUITY', rupees(700_000)], ['DEBT', rupees(300_000)]]);
    expect(allocationDrift(byClass)).toEqual(allocationDrift(byClass, rupees(1_000_000)));
  });

  it('refuses a total that disagrees with the map it is given', () => {
    // Two independent arguments describing one portfolio: a caller passing an
    // inconsistent pair would otherwise get silently wrong percentages.
    const byClass = classMap([['EQUITY', rupees(700_000)], ['DEBT', rupees(300_000)]]);
    expect(() => allocationDrift(byClass, rupees(900_000))).toThrow(/total/i);
  });

  it('computes drift through integer money, not a float round-trip', () => {
    // Above 2^53 paise the float path (Math.round(pct * Number(total))) loses the low
    // digits. Nothing in the real portfolio is this large; the point is that the code
    // never converts money to a Number at all.
    const total = paise(1_000_000_000_000_000_003n);
    const byClass = classMap([
      ['EQUITY', paise(800_000_000_000_000_002n)],
      ['DEBT', paise(200_000_000_000_000_001n)],
    ]);
    const equity = allocationDrift(byClass, total).find((r) => r.assetClass === 'EQUITY')!;
    // target = total * 600000 / 1000000 = 600000000000000001 (truncated)
    expect(equity.driftPaise).toBe(200_000_000_000_000_001n);
  });
});

describe('concentration caps (PRD 3.5)', () => {
  it('breaches the 10% employer cap and names the employer instrument', () => {
    const positions = [
      pos({ instrumentId: 'US:ACME', valuePaise: rupees(200_000), assetClass: 'EQUITY', isEmployer: true, issuer: 'Acme', kind: 'RSU' }),
      pos({ instrumentId: 'MF:X', valuePaise: rupees(800_000), assetClass: 'EQUITY', kind: 'MF' }),
    ];
    const c = concentration(positions);
    expect(c.employerPct).toBeCloseTo(0.20, 4);
    const employer = c.breaches.filter((b) => /employer/i.test(b));
    expect(employer).toHaveLength(1);
    // The reference implementation hard-coded "NOW" in this message regardless of which
    // instrument actually breached.
    expect(employer[0]).toContain('US:ACME');
  });

  it('breaches the 10% single-issuer cap aggregated across equity and credit', () => {
    const positions = [
      pos({ instrumentId: 'BOND:SAMMAAN-2026', valuePaise: rupees(80_000), assetClass: 'DEBT', kind: 'BOND', issuer: 'Sammaan Capital' }),
      pos({ instrumentId: 'BOND:SAMMAAN-2029', valuePaise: rupees(40_000), assetClass: 'DEBT', kind: 'BOND', issuer: 'Sammaan Capital' }),
      pos({ instrumentId: 'MF:X', valuePaise: rupees(880_000), assetClass: 'EQUITY', kind: 'MF' }),
    ];
    const c = concentration(positions);
    expect(c.byIssuer.get('Sammaan Capital')).toBeCloseTo(0.12, 4);
    expect(c.breaches.some((b) => /Sammaan/.test(b))).toBe(true);
  });

  it('excludes index funds from the single-stock cap', () => {
    const positions = [
      pos({ instrumentId: 'MF:ICICI-NIFTY50-IDX', valuePaise: rupees(900_000), assetClass: 'EQUITY', kind: 'MF' }),
      pos({ instrumentId: 'NSE:TATASTEEL', valuePaise: rupees(100_000), assetClass: 'EQUITY' }),
    ];
    expect(concentration(positions).topStockPct).toBeCloseTo(0.10, 4);
  });

  it('aggregates one stock held in two accounts before applying the cap', () => {
    // 5% + 6% in separate accounts is 11% of one company. Mapping over positions
    // instead of instruments makes both rows sub-cap and the breach disappears.
    const positions = [
      pos({ instrumentId: 'NSE:TATASTEEL', valuePaise: rupees(50_000), assetClass: 'EQUITY', account: 'zerodha' }),
      pos({ instrumentId: 'NSE:TATASTEEL', valuePaise: rupees(60_000), assetClass: 'EQUITY', account: 'groww' }),
      pos({ instrumentId: 'MF:X', valuePaise: rupees(890_000), assetClass: 'EQUITY', kind: 'MF' }),
    ];
    const c = concentration(positions);
    expect(c.topStockPct).toBeCloseTo(0.11, 4);
    const stock = c.breaches.filter((b) => /single-stock/i.test(b));
    expect(stock).toHaveLength(1);
    expect(stock[0]).toContain('NSE:TATASTEEL');
  });

  it('enforces the 35% single-MF-scheme cap, aggregated across accounts', () => {
    const positions = [
      pos({ instrumentId: 'MF:PPFC', valuePaise: rupees(200_000), assetClass: 'EQUITY', kind: 'MF', account: 'zerodha' }),
      pos({ instrumentId: 'MF:PPFC', valuePaise: rupees(200_000), assetClass: 'EQUITY', kind: 'MF', account: 'indmoney' }),
      pos({ instrumentId: 'MF:Y', valuePaise: rupees(600_000), assetClass: 'EQUITY', kind: 'MF' }),
    ];
    const c = concentration(positions);
    expect(c.byMfScheme.get('MF:PPFC')).toBeCloseTo(0.40, 4);
    expect(c.byMfScheme.get('MF:Y')).toBeCloseTo(0.60, 4);
    expect(c.breaches.filter((b) => /MF-scheme/i.test(b))).toHaveLength(2);
    expect(CAPS.singleMfScheme).toBe(0.35);
  });

  it('enforces the 25% single-sector cap', () => {
    const positions = [
      pos({ instrumentId: 'NSE:INFY', valuePaise: rupees(200_000), assetClass: 'EQUITY', sector: 'Technology' }),
      pos({ instrumentId: 'NSE:TCS', valuePaise: rupees(100_000), assetClass: 'EQUITY', sector: 'Technology' }),
      pos({ instrumentId: 'NSE:HDFCBANK', valuePaise: rupees(700_000), assetClass: 'EQUITY', sector: 'Financials' }),
    ];
    const c = concentration(positions);
    expect(c.bySector.get('Technology')).toBeCloseTo(0.30, 4);
    expect(c.bySector.get('Financials')).toBeCloseTo(0.70, 4);
    expect(c.sectorCoveragePct).toBeCloseTo(1.0, 6);
    expect(c.caveats).toEqual([]);
    const sector = c.breaches.filter((b) => /sector/i.test(b));
    expect(sector).toHaveLength(2); // both sectors are over 25%
    expect(sector.some((b) => b.includes('Technology'))).toBe(true);
    expect(CAPS.singleSector).toBe(0.25);
  });

  it('caveats the sector cap when most of the portfolio carries no sector', () => {
    const positions = [
      pos({ instrumentId: 'NSE:INFY', valuePaise: rupees(100_000), assetClass: 'EQUITY', sector: 'Technology' }),
      pos({ instrumentId: 'EPF:ANIRBAN', valuePaise: rupees(900_000), assetClass: 'DEBT', kind: 'EPF' }),
    ];
    const c = concentration(positions);
    expect(c.sectorCoveragePct).toBeCloseTo(0.10, 6);
    expect(c.caveats).toContain(SECTOR_COVERAGE_CAVEAT);
  });

  it('reports zero rather than dividing by an empty portfolio', () => {
    const c = concentration([]);
    expect(c.topStockPct).toBe(0);
    expect(c.employerPct).toBe(0);
    expect(c.breaches).toEqual([]);
  });
});

describe('the real seeded portfolio', () => {
  let db: Db;
  let positions: Position[];

  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
    positions = await loadPositions(db);
  });

  it('has the employer over its cap and Sammaan comfortably under it', () => {
    const total = addP(...positions.map((p) => p.valuePaise));
    const employer = addP(...positions.filter((p) => p.isEmployer).map((p) => p.valuePaise));
    const sammaan = addP(
      ...positions.filter((p) => p.issuer === 'Sammaan Capital').map((p) => p.valuePaise),
    );
    const c = concentration(positions);

    // Derived side comes from the loaded positions; the literals are the seed's own
    // arithmetic, asserted exactly so a seed correction fails loudly.
    // Updated for current Fidelity reality (78 NOW shares @ $145.59, FX ~94.48)
    expect(employer).toBe(107_297_400n);
    expect(sammaan).toBe(379_999_61n);
    expect(total).toBe(534_197_361n);

    expect(c.employerPct).toBeCloseTo(Number(employer) / Number(total), 12);
    expect(c.employerPct).toBeCloseTo(0.20085723, 8);   // 20.0857% - OVER the 10% cap
    expect(c.employerPct).toBeGreaterThan(CAPS.employer);

    // Sammaan issuer % is now 7.11% (was 7.97% at old total) — well under 10% cap
    expect(c.byIssuer.get('Sammaan Capital')).toBeCloseTo(Number(sammaan) / Number(total), 12);
    expect(c.byIssuer.get('Sammaan Capital')).toBeCloseTo(0.07113468, 8);
    expect(c.byIssuer.get('Sammaan Capital')!).toBeLessThan(CAPS.singleIssuer);
    expect(c.breaches.filter((b) => /Sammaan/.test(b))).toEqual([]);

    // There IS a single-issuer breach in the seed, and it is not the one the plan
    // claimed: US:NOW carries issuer 'ServiceNow', so employer concentration is issuer
    // concentration too and both caps fire on the same 20.0857%.
    expect(c.byIssuer.get('ServiceNow')).toBeCloseTo(c.employerPct, 12);
    expect(c.breaches.filter((b) => /ServiceNow/.test(b))).toHaveLength(1);
  });

  it('reports exactly the breach set the real portfolio produces', () => {
    const c = concentration(positions);
    const kinds = c.breaches.map((b) => b.split(':')[0]).sort();

    // Breaches: Employer cap (20.09%), Single-issuer cap (ServiceNow 20.09%),
    // Single-stock cap (NOW 20.09%), Single-stock cap (Smallcase residue ~12.6%)
    // No Sammaan issuer breach, no MF-scheme breach, no sector breach.
    expect(kinds).toEqual([
      'Employer cap', 'Single-issuer cap', 'Single-stock cap', 'Single-stock cap',
    ]);
    expect(c.breaches.filter((b) => b.includes('NSE:SMALLCASE-RESIDUE'))).toHaveLength(1);
    expect(c.breaches.filter((b) => b.includes('US:NOW'))).toHaveLength(2); // stock + employer
    expect(c.topStockPct).toBeCloseTo(0.20085723, 8);

    // Only NOW and RPOWER carry a sector in the seed, so the sector cap sees ~20% of the portfolio
    expect(c.sectorCoveragePct).toBeCloseTo(0.20134394, 8);
    expect(c.caveats).toContain(SECTOR_COVERAGE_CAVEAT);
  });

  it('is inside every IPS band except gold, which is far under its floor', () => {
    const nw = netWorth(positions, 0n as Paise);
    const rows = allocationDrift(nw.byAssetClass, nw.assetsPaise);
    const by = new Map(rows.map((r) => [r.assetClass, r]));

    // EQUITY is 58.89% (NOW 20.13% + other equity) — under 60% cap
    expect(by.get('EQUITY')!.actual).toBeCloseTo(0.58891605, 8);
    expect(by.get('EQUITY')!.breach).toBeNull();
    // DEBT is 36.88% (EPF + bonds + liquid ETF)
    expect(by.get('DEBT')!.actual).toBeCloseTo(0.36877749, 8);
    expect(by.get('DEBT')!.breach).toBeNull();
    // CASH is 3.05%
    expect(by.get('CASH')!.actual).toBeCloseTo(0.03051307, 8);
    expect(by.get('CASH')!.breach).toBeNull();

    expect(by.get('GOLD')!.actual).toBeCloseTo(0.01179339, 8);
    expect(by.get('GOLD')!.breach).toBe('UNDER');
    // 5% of 53,41,97,361 paise = 26,709,868 less the 6,30,000 held = 20,409,868
    expect(by.get('GOLD')!.driftPaise).toBe(20_409_868n);
  });
});
