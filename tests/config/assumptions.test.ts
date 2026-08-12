import { describe, expect, it } from 'vitest';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';

describe('planning assumptions', () => {
  it('encodes PRD 15.2 values exactly', () => {
    expect(ASSUMPTIONS.equityNominalCagr).toBe(0.12);
    expect(ASSUMPTIONS.sensitivityBand).toBe(0.03);
    expect(ASSUMPTIONS.inflation).toBe(0.06);
    expect(ASSUMPTIONS.swrFloor).toBe(0.035);
    expect(ASSUMPTIONS.swrOptimistic).toBe(0.04);
    expect(ASSUMPTIONS.sipStepUp).toBe(0.10);
    expect(ASSUMPTIONS.rsuRefresherUsdPerYear).toBe(20_000);
    expect(ASSUMPTIONS.rsuVestYears).toBe(4);
    expect(ASSUMPTIONS.rsuNetOfWithholding).toBe(0.70);
    expect(ASSUMPTIONS.seedUsdInr).toBe(95.3);
    expect(ASSUMPTIONS.seedNowPriceUsd).toBe(127.54);
    expect(ASSUMPTIONS.childArrivalYear).toBe(2028);
    expect(ASSUMPTIONS.fiTargetAge).toBe(55);
    expect(ASSUMPTIONS.ownerBirthYear).toBe(1995);
  });
});
