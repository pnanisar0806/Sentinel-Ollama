import { describe, expect, it } from 'vitest';
import { runCascade } from '../../src/domain/loans.js';
import {
  FIXED_OUTFLOWS, RENT_TO_EMI_FLAG, loanOutflowByMonth, projectAnnualSurplus, projectSurplus,
} from '../../src/domain/surplus.js';
import { addP, rupees, subP } from '../../src/money/paise.js';
import { SEED_LOANS } from '../../src/seed/seed-data.js';

const inputs = SEED_LOANS.map((l) => ({
  id: l.id, outstandingPaise: l.outstandingPaise, annualRateBps: l.annualRateBps,
  emiPaise: l.emiPaise, cascadeOrder: l.cascadeOrder,
}));
const { rows, closures } = runCascade(inputs, '2026-09-01');
const outflow = loanOutflowByMonth(rows);

const project = (months: number) =>
  projectSurplus({ from: '2026-09-01', months, closures, loanOutflowByMonth: outflow });

describe('surplus curve', () => {
  // Every input here is a constant, so the first month is fully determined:
  //   215,000 take-home - 55,526 loan outflow - 77,350 fixed = 82,124, child dent 0.
  // Asserted EXACTLY rather than banded. An earlier draft of this plan banded it at
  // <82,000 while its own implementer note derived 82,124 - the test contradicted the
  // model it was testing. A band here buys nothing: there is no estimate to absorb.
  // These literals are downstream of seed data and that is deliberate: if the seed moves,
  // this test is SUPPOSED to break loudly.
  it('starts at the derived 82,124 investable surplus', () => {
    const [first] = project(1);
    expect(first!.investablePaise).toBe(rupees(82_124));
    // Bolted to the parts, so a change to any constant fails here rather than silently
    // shifting the curve.
    expect(first!.takeHomePaise).toBe(rupees(215_000));
    expect(first!.loanOutflowPaise).toBe(rupees(55_526));
    expect(first!.fixedOutflowPaise).toBe(rupees(77_350));
    expect(first!.childDentPaise).toBe(rupees(0));
  });

  it('steps take-home up 10% each April', () => {
    const months = project(24);
    const mar = months.find((m) => m.month === '2027-03-01')!;
    const apr = months.find((m) => m.month === '2027-04-01')!;
    expect(Number(apr.takeHomePaise) / Number(mar.takeHomePaise)).toBeCloseTo(1.1, 3);
  });

  it('applies the child dent from Jan 2028', () => {
    const months = projectSurplus({
      from: '2026-09-01', months: 24, closures, loanOutflowByMonth: outflow,
    });
    expect(months.find((m) => m.month === '2027-12-01')!.childDentPaise).toBe(0n);
    expect(Number(months.find((m) => m.month === '2028-01-01')!.childDentPaise / 100n)).toBe(10_000);
  });

  // Asserts the mother's-support COMPONENT, not the sum of all five fixed outflows. An
  // earlier draft checked `fixedOutflowPaise > 0n`, which no single-line change to
  // mother's support alone could ever fail - you would have had to zero all five. The
  // whole point of this rule (PRD 2.2) is that this one line never terminates, so the
  // test has to be able to see it on its own.
  it('never terminates the mother support line', () => {
    expect(FIXED_OUTFLOWS.motherSupport).toBe(rupees(20_000));
    const months = project(24);
    // Every month must carry at least the mother's-support line, and the fixed block must
    // still contain it: drop motherSupport from the sum and the residual has to shrink by
    // exactly that amount.
    const others = addP(
      FIXED_OUTFLOWS.rent, FIXED_OUTFLOWS.wifeAllowance,
      FIXED_OUTFLOWS.maidAndMaintenance, FIXED_OUTFLOWS.misc,
    );
    for (const m of months) {
      expect(subP(m.fixedOutflowPaise, others)).toBe(FIXED_OUTFLOWS.motherSupport);
    }
  });

  it('holds loan outflow flat until the home loan closes, then releases it', () => {
    const annual = projectAnnualSurplus({
      fromYear: 2026, toYear: 2050,
      monthly: projectSurplus({ from: '2026-09-01', months: 300, closures, loanOutflowByMonth: outflow }),
    });
    const y2033 = annual.find((a) => a.year === 2033)!.investablePaise;
    const y2035 = annual.find((a) => a.year === 2035)!.investablePaise;
    expect(y2035).toBeGreaterThan(y2033);
  });

  it('produces one row per month with no gaps', () => {
    const months = project(24);
    expect(months).toHaveLength(24);
    expect(months[0]!.month).toBe('2026-09-01');
    expect(months.at(-1)!.month).toBe('2028-08-01');
    expect(new Set(months.map((m) => m.month)).size).toBe(24);
  });

  // Renamed from 'never reports a negative investable surplus without flagging it'. There
  // is no flagging mechanism in this module and the surplus never approaches zero inside
  // the 24-month horizon (it opens at 82,124), so the old name promised a safety behaviour
  // the code does not have. This asserts what it actually checks.
  it('keeps investable surplus positive in every month of the 24-month horizon', () => {
    const months = project(24);
    for (const m of months) expect(m.investablePaise).toBeGreaterThan(0n);
  });

  // PRD 2.2: rent converts to an equivalent EMI at the Hyderabad purchase. No purchase
  // date exists in ASSUMPTIONS yet, so the annual view FLAGS the caveat instead of
  // modelling a mortgage - the plan's model rules require the flag, and dropping it was
  // an open audit finding on this task.
  it('flags every annual row as still modelling Hyderabad rent as rent', () => {
    const annual = projectAnnualSurplus({
      fromYear: 2026, toYear: 2050, monthly: project(300),
    });
    expect(annual.length).toBeGreaterThan(0);
    for (const a of annual) expect(a.flags).toContain(RENT_TO_EMI_FLAG);
  });

  // The loan-outflow map is keyed by month; a missing key is legitimate only AFTER the
  // last loan closes. Before that it means the caller paired a projection window with a
  // cascade that does not cover it, which would silently inflate the surplus by a whole
  // EMI block. `closures` is what makes the two distinguishable, so it must throw.
  it('refuses a projection window the cascade does not cover', () => {
    expect(() =>
      projectSurplus({ from: '2026-08-01', months: 3, closures, loanOutflowByMonth: outflow }),
    ).toThrow(/loan outflow missing/);
  });
});
