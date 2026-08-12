import { describe, expect, it } from 'vitest';
import { addP, rupees } from '../../src/money/paise.js';
import {
  SEED_BUCKETS, SEED_HOLDINGS, SEED_INSTRUMENTS, SEED_LOANS,
  SEED_MILESTONES, SEED_RSU_GRANTS,
} from '../../src/seed/seed-data.js';

describe('seed data matches the PRD balance sheet', () => {
  const sumOf = (ids: string[]) =>
    addP(...SEED_HOLDINGS.filter((h) => ids.includes(h.instrumentId)).map((h) => h.valuePaise));

  it('totals exactly 47.69L of assets (within ±5,000 rupees)', () => {
    const total = addP(...SEED_HOLDINGS.map((h) => h.valuePaise));
    const totalRupees = Number(total / 100n);
    // EPF 1,354,000 + MF 1,183,000 + stocks/ETFs 832,000 + bonds 600,000 + savings 163,000 + US basket 137,000 + Fidelity 500,000 = 4,769,000
    expect(totalRupees).toBeGreaterThan(4_764_000); // 4,769,000 - 5,000
    expect(totalRupees).toBeLessThan(4_774_000); // 4,769,000 + 5,000
  });

  it('carries EPF and Fidelity at their stated values', () => {
    const byAccount = (account: string) =>
      addP(...SEED_HOLDINGS.filter((h) => h.account === account).map((h) => h.valuePaise));
    expect(byAccount('epf')).toBe(rupees(1_354_000));
    expect(byAccount('fidelity')).toBe(rupees(500_000));
  });

  it('references only declared instruments', () => {
    const ids = new Set(SEED_INSTRUMENTS.map((i) => i.id));
    for (const h of SEED_HOLDINGS) expect(ids.has(h.instrumentId)).toBe(true);
  });

  it('marks NOW as the employer instrument for the 10% cap', () => {
    expect(SEED_INSTRUMENTS.find((i) => i.id === 'US:NOW')?.isEmployer).toBe(true);
  });

  it('records unknown cost as null, never zero (FR-02)', () => {
    expect(SEED_HOLDINGS.some((h) => h.avgCostPaise === null)).toBe(true);
    expect(SEED_HOLDINGS.some((h) => h.avgCostPaise === 0n)).toBe(false);
  });

  it('carries three loans totalling ~36.7L outstanding with a cascade order', () => {
    const outstanding = addP(...SEED_LOANS.map((l) => l.outstandingPaise));
    expect(Number(outstanding / 100n)).toBeGreaterThan(3_500_000);
    expect(Number(outstanding / 100n)).toBeLessThan(3_800_000);
    expect(SEED_LOANS.map((l) => l.cascadeOrder).sort()).toEqual([1, 2, 3]);
  });

  it('declares four buckets and two incomplete milestones', () => {
    expect(SEED_BUCKETS.map((b) => b.id)).toEqual(['B1', 'B2', 'B3', 'B4']);
    expect(SEED_MILESTONES.map((m) => m.id)).toEqual(['M1', 'M2']);
    expect(SEED_MILESTONES.every((m) => m.completedOn === null)).toBe(true);
  });

  it('carries six RSU grants totalling 1105 units', () => {
    expect(SEED_RSU_GRANTS).toHaveLength(6);
    expect(SEED_RSU_GRANTS.reduce((a, g) => a + g.units, 0)).toBe(1105);
  });

  it('Indian stocks and ETFs sum to exactly 8.32L', () => {
    expect(sumOf([
      'NSE:NIFTYBEES', 'NSE:GOLDBEES', 'NSE:LIQUIDBEES',
      'NSE:SMALLCASE-RESIDUE', 'NSE:RPOWER',
    ])).toBe(rupees(832_000));
  });

  it('mutual funds sum to exactly 1.83L', () => {
    expect(sumOf([
      'MF:ICICI-NIFTY50-IDX', 'MF:PPFC', 'MF:ICICI-LARGECAP',
      'MF:HDFC-MIDCAP', 'MF:MOTILAL-MIDCAP', 'MF:BANDHAN-SMALLCAP',
    ])).toBe(rupees(1_183_000));
  });

  it('bond line items sum to exactly 6.00L (source document states 6.33L for this bucket)', () => {
    expect(sumOf(['BOND:SAMMAAN-2026', 'BOND:SAMMAAN-2029', 'BOND:EDELWEISS-2033']))
      .toBe(rupees(600_000));
  });
});
