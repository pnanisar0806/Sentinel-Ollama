import { describe, expect, it } from 'vitest';
import { runCascade } from '../../src/domain/loans.js';
import {
  CHILD_DENT_NO_END_FLAG, FIXED_OUTFLOWS, PARTIAL_YEAR_FLAG, RENT_TO_EMI_FLAG,
  loanOutflowByMonth, projectAnnualSurplus, projectSurplus,
} from '../../src/domain/surplus.js';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';
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

  // The model's headline behaviour, asserted on `loanOutflowPaise` ITSELF.
  //
  // An earlier draft compared ANNUAL INVESTABLE totals (y2035 > y2033) and was vacuous:
  // take-home compounds 10% per fiscal year, so by 2033 monthly take-home is ~4.19L and two
  // further years add ~1.5L/month - the 55,526 release is noise against it. Verified by
  // feeding projectSurplus a synthetic map holding 55,526 flat for all 300 months (release
  // NEVER happens) with closures pushed to 2060: y2033=319891218 y2035=423073227, and the
  // old assertion still passed. It tested neither flatness nor release.
  //
  // The closure month is derived from `closures`, never written as a date literal - Task 6
  // was already bitten by a hard-coded closure month.
  it('holds loan outflow flat until the home loan closes, then releases it', () => {
    const homeClosure = closures.get('home')!;
    // Closure months legitimately dip: the closing loan's final payment is capped at
    // balance + interest, and freedEmi is credited only after the month completes. See the
    // runCascade docstring.
    const closureMonths = new Set(closures.values());
    const fullBlock = addP(...SEED_LOANS.map((l) => l.emiPaise));
    const months = projectSurplus({
      from: '2026-09-01', months: 300, closures, loanOutflowByMonth: outflow,
    });

    let flatChecked = 0;
    let releasedChecked = 0;
    for (const m of months) {
      if (closureMonths.has(m.month)) continue;
      if (m.month < homeClosure) {
        expect(m.loanOutflowPaise).toBe(fullBlock);
        flatChecked++;
      } else if (m.month > homeClosure) {
        expect(m.loanOutflowPaise).toBe(0n);
        releasedChecked++;
      }
    }
    // Counters: without these an empty window would pass the loop vacuously.
    expect(flatChecked).toBeGreaterThan(80);
    expect(releasedChecked).toBeGreaterThan(200);
    expect(fullBlock).toBe(rupees(55_526));
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

  // ...and the guard must not be disablable by its own arguments. Keying coverage off
  // `closures` alone made it a silent no-op for an EMPTY closures map, which is reachable in
  // production rather than hypothetical: `closures` is returned only by runCascade and is
  // persisted NOWHERE (persistSchedules writes loan_schedule, which has no closure column),
  // so any Task 8+ consumer reading a schedule back from Postgres holds an outflow map and
  // no closures. The disabled guard returned two happy rows for a 2019 window with
  // investable 1,37,650 - inflated by exactly the 55,526 EMI block the guard exists to catch.
  it('still refuses an uncovered window when closures is empty', () => {
    expect(() => projectSurplus({
      from: '2019-01-01', months: 2, closures: new Map(), loanOutflowByMonth: outflow,
    })).toThrow(/loan outflow missing/);
  });

  it('refuses an empty outflow map outright, with or without closures', () => {
    expect(() => projectSurplus({
      from: '2019-01-01', months: 2, closures: new Map(), loanOutflowByMonth: new Map(),
    })).toThrow(/loan outflow missing/);
    expect(() => projectSurplus({
      from: '2026-09-01', months: 2, closures, loanOutflowByMonth: new Map(),
    })).toThrow(/loan outflow missing/);
    // months: 0 asks for nothing, so nothing can be uncovered.
    expect(projectSurplus({
      from: '2026-09-01', months: 0, closures: new Map(), loanOutflowByMonth: new Map(),
    })).toEqual([]);
  });

  // A hole INSIDE the map, with no closures at all: the map's own key range is what makes
  // this detectable. The victim month is picked out of the real map, never written down.
  it('refuses a hole in the middle of the outflow map with no closures supplied', () => {
    const holed = new Map(outflow);
    const victim = [...outflow.keys()].sort()[10]!;
    holed.delete(victim);
    expect(() => projectSurplus({
      from: '2026-09-01', months: 24, closures: new Map(), loanOutflowByMonth: holed,
    })).toThrow(new RegExp(`loan outflow missing for ${victim}`));
  });

  // BASE_TAKE_HOME is a PRD figure quoted as of BASE_TAKE_HOME_AS_OF. Anchoring the April
  // ladder to the caller's `from` made the same calendar month pay differently depending on
  // when the projection started (Apr-2027 read 2,36,500 from a 2026-09 start but 2,15,000
  // from a 2027-04 start), silently rebasing salary for any later caller.
  it('yields the same take-home for a calendar month from any projection start', () => {
    const early = projectSurplus({
      from: '2026-09-01', months: 120, closures, loanOutflowByMonth: outflow,
    });
    const late = projectSurplus({
      from: '2027-04-01', months: 120, closures, loanOutflowByMonth: outflow,
    });
    const earlyByMonth = new Map(early.map((m) => [m.month, m.takeHomePaise]));
    const shared = late.filter((m) => earlyByMonth.has(m.month));
    expect(shared.length).toBeGreaterThan(100);
    for (const m of shared) expect(m.takeHomePaise).toBe(earlyByMonth.get(m.month));
  });

  // A partial head or tail year is not comparable with a full one. Unflagged, this window
  // reads as a 3.5x jump from 2026 (4 months) to 2027 and a 27% collapse from 2050 to 2051
  // (8 months) - both pure windowing artifacts.
  it('flags partial years and carries the month count', () => {
    const annual = projectAnnualSurplus({
      fromYear: 2026, toYear: 2100, monthly: project(300),
    });
    const [first] = annual;
    const last = annual.at(-1)!;
    expect(first!.monthCount).toBeLessThan(12);
    expect(first!.flags).toContain(PARTIAL_YEAR_FLAG);
    expect(last.monthCount).toBeLessThan(12);
    expect(last.flags).toContain(PARTIAL_YEAR_FLAG);

    const middle = annual.slice(1, -1);
    expect(middle.length).toBeGreaterThan(20);
    for (const a of middle) {
      expect(a.monthCount).toBe(12);
      expect(a.flags).not.toContain(PARTIAL_YEAR_FLAG);
    }
    // Every projected month lands in exactly one bucket.
    expect(annual.reduce((n, a) => n + a.monthCount, 0)).toBe(300);
  });

  // The child dent has no end condition (TODO Task 10), which understates late-horizon
  // surplus by up to 1.2L/year. `flags` already carried the rent caveat, so a consumer
  // seeing one caveat would reasonably conclude it was the only one.
  it('flags the open-ended child dent on every year from the arrival onward', () => {
    const annual = projectAnnualSurplus({
      fromYear: 2026, toYear: 2100, monthly: project(300),
    });
    expect(annual.length).toBeGreaterThan(20);
    for (const a of annual) {
      expect(a.flags.includes(CHILD_DENT_NO_END_FLAG))
        .toBe(a.year >= ASSUMPTIONS.childArrivalYear);
    }
    // It must not fall off the far end: the understatement never stops.
    expect(annual.at(-1)!.flags).toContain(CHILD_DENT_NO_END_FLAG);
  });
});
