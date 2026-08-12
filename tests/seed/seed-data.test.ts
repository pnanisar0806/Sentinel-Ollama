import { describe, expect, it } from 'vitest';
import { addP, rupees } from '../../src/money/paise.js';
import {
  SEED_BUCKETS, SEED_HOLDINGS, SEED_INSTRUMENTS, SEED_LOANS,
  SEED_MILESTONES, SEED_RSU_GRANTS,
} from '../../src/seed/seed-data.js';

describe('seed data matches the PRD balance sheet', () => {
  it('totals roughly 48L of assets including Fidelity', () => {
    const total = addP(...SEED_HOLDINGS.map((h) => h.valuePaise));
    expect(Number(total / 100n)).toBeGreaterThan(4_600_000);
    expect(Number(total / 100n)).toBeLessThan(5_000_000);
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
});
