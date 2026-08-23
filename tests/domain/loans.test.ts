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

  /**
   * These were a year prefix and a 12-month-wide window, so a one-month redirect error
   * passed the whole suite. Every input is owner-verified from a lender portal and the
   * cascade is fully determined, so the output is too — there is no band to be inside.
   *
   * MEMORY.md warns against hard-coding a month DOWNSTREAM of the cascade (a consumer
   * must derive stub months from `closures.values()`, and this file already does that
   * below). This is the cascade's OWN characterisation test: pinning its output is the
   * point, and a stale literal here fails loudly rather than silently — the same
   * deliberate exception `surplus.test.ts` makes for Rs 82,124.
   *
   * If one of these moves, the seed moved. Re-derive from the lender portal, do not
   * widen the assertion.
   */
  it('closes car loan 1 in Feb 2028, ahead of its natural Jan 2028 end', () => {
    expect(closures.get('car1')).toBe('2028-02-01');
  });

  it('closes car loan 2 in Sep 2028, ahead of its natural Mar 2029 end', () => {
    expect(closures.get('car2')).toBe('2028-09-01');
  });

  it('closes the home loan in Dec 2033, not its natural Dec 2046', () => {
    expect(closures.get('home')).toBe('2033-12-01');
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

  // A +/-10% band on a fully determined figure tolerated a Rs 2 lakh modelling error.
  // The PRD independently states ~Rs 19.3L and the model never saw that number, so the
  // agreement is corroboration rather than a fit.
  it('saves exactly the home-loan interest the cascade implies', () => {
    const natural = amortize(inputs.find((l) => l.id === 'home')!, { from: '2026-09-01' });
    const saved = interestPaid(natural) - interestPaid(rows, 'home');
    expect(saved).toBe(192_262_980n); // Rs 19,22,629.80, home loan alone
  });

  /**
   * The figure MEMORY records and the PRD independently states as ~Rs 19.3L is the
   * ALL-LOANS saving, not the home loan's alone. The two differ by the car loans'
   * small contribution, and conflating them is how a "close enough" band hides a real
   * discrepancy. Both are pinned so neither can drift into the other.
   */
  it('saves exactly the total interest across all three loans', () => {
    const naturalAll = inputs.reduce(
      (acc, l) => acc + interestPaid(amortize(l, { from: '2026-09-01' })), 0n,
    );
    expect(naturalAll).toBe(310_114_511n);              // Rs 31,01,145.11
    expect(interestPaid(rows)).toBe(117_483_712n);      // Rs 11,74,837.12
    expect(naturalAll - interestPaid(rows)).toBe(192_630_799n); // Rs 19,26,307.99
  });
});
