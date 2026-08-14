import { describe, expect, it } from 'vitest';
import { amortize, interestPaid, runCascade } from '../../src/domain/loans.js';
import { rupees } from '../../src/money/paise.js';
import { SEED_LOANS } from '../../src/seed/seed-data.js';

const inputs = SEED_LOANS.map((l) => ({
  id: l.id, outstandingPaise: l.outstandingPaise, annualRateBps: l.annualRateBps,
  emiPaise: l.emiPaise, cascadeOrder: l.cascadeOrder,
}));

describe('amortize', () => {
  it('reduces the balance to zero without overpaying the final instalment', () => {
    const rows = amortize(
      { id: 'x', outstandingPaise: rupees(100_000), annualRateBps: 795, emiPaise: rupees(10_000), cascadeOrder: 1 },
      { from: '2026-09-01' },
    );
    expect(rows.at(-1)!.closingPaise).toBe(0n);
    expect(rows.at(-1)!.paymentPaise).toBeLessThanOrEqual(rupees(10_000));
    expect(rows.every((r) => r.interestPaise >= 0n)).toBe(true);
  });

  it('charges interest on the opening balance at the monthly rate', () => {
    const [first] = amortize(
      { id: 'x', outstandingPaise: rupees(100_000), annualRateBps: 1200, emiPaise: rupees(10_000), cascadeOrder: 1 },
      { from: '2026-09-01' },
    );
    expect(first!.interestPaise).toBe(rupees(1_000)); // 12%/12 = 1% of 1,00,000
    expect(first!.principalPaise).toBe(rupees(9_000));
  });

  it('applies extra principal in the month it is supplied', () => {
    const rows = amortize(
      { id: 'x', outstandingPaise: rupees(100_000), annualRateBps: 1200, emiPaise: rupees(10_000), cascadeOrder: 1 },
      { from: '2026-09-01', extraByMonth: new Map([['2026-10-01', rupees(20_000)]]) },
    );
    expect(rows.find((r) => r.month === '2026-10-01')!.paymentPaise).toBe(rupees(30_000));
  });

  it('throws rather than looping forever when the EMI never amortises', () => {
    expect(() =>
      amortize(
        { id: 'bad', outstandingPaise: rupees(1_000_000), annualRateBps: 1200, emiPaise: rupees(100), cascadeOrder: 1 },
        { from: '2026-09-01' },
      ),
    ).toThrow(/never amortis/i);
  });
});

describe('the committed prepayment cascade', () => {
  const { rows, closures } = runCascade(inputs, '2026-09-01');

  it('closes car loan 1 in early 2028', () => {
    expect(closures.get('car1')!.slice(0, 4)).toBe('2028');
    expect(Number(closures.get('car1')!.slice(5, 7))).toBeLessThanOrEqual(3);
  });

  it('closes car loan 2 in 2028, ahead of its natural Mar 2029 end', () => {
    expect(closures.get('car2')!.slice(0, 4)).toBe('2028');
  });

  it('closes the home loan around Dec 2033, not its natural Dec 2046', () => {
    const home = closures.get('home')!;
    expect(home >= '2033-06-01' && home <= '2034-06-01').toBe(true);
  });

  // Boundary months where a loan closes with a partial stub instalment are excluded: the
  // stub is real (a closing loan needs less than a full EMI+extra to zero out) and must
  // not be smeared across the model. The excluded months are DERIVED from the closures
  // map, never hard-coded - hard-coded literals silently go stale the moment a seed value
  // is corrected, which is precisely what happened when the real loan figures landed.
  it('keeps total monthly loan outflow flat at ~55,526 through the steady state', () => {
    const stubMonths = new Set(closures.values());
    const byMonth = new Map<string, bigint>();
    for (const r of rows) byMonth.set(r.month, (byMonth.get(r.month) ?? 0n) + r.paymentPaise);
    let checked = 0;
    for (const [month, total] of byMonth) {
      if (month < '2026-10-01' || month > '2033-01-01') continue;
      if (stubMonths.has(month)) continue;
      expect(Number(total / 100n), `month ${month}`).toBeGreaterThan(55_000);
      expect(Number(total / 100n), `month ${month}`).toBeLessThan(56_100);
      checked += 1;
    }
    // Guard the guard: if the range or the closure set ever collapses, the loop above
    // would vacuously pass. 2026-10..2033-01 is 76 months less at most 3 closure stubs.
    expect(checked).toBeGreaterThan(70);
  });

  it('saves roughly 17-21 lakh of home-loan interest versus the natural schedule', () => {
    const natural = amortize(inputs.find((l) => l.id === 'home')!, { from: '2026-09-01' });
    const saved = interestPaid(natural) - interestPaid(rows, 'home');
    expect(Number(saved / 100n)).toBeGreaterThan(1_700_000);
    expect(Number(saved / 100n)).toBeLessThan(2_100_000);
  });
});
