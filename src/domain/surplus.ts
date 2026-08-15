import { ASSUMPTIONS } from '../config/assumptions.js';
import { addP, mulP, rupees, subP, type Paise } from '../money/paise.js';
import { nextMonth, type ScheduleRow } from './loans.js';

/** PRD §2.2 non-loan fixed outflows. Mother's support is permanent. */
export const FIXED_OUTFLOWS = {
  rent: rupees(31_500),
  motherSupport: rupees(20_000),
  wifeAllowance: rupees(10_000),
  maidAndMaintenance: rupees(5_850),
  misc: rupees(10_000),
} as const;

export const BASE_TAKE_HOME = rupees(215_000);

/**
 * PRD §2.2: the Hyderabad rent converts to an equivalent EMI at the purchase. No purchase
 * date exists in `ASSUMPTIONS`, so the annual view carries this caveat on every row rather
 * than inventing a date or modelling a mortgage. When the owner supplies a purchase date,
 * narrow the flag to the years at or after it and move `FIXED_OUTFLOWS.rent` into the loan
 * cascade as a real EMI.
 */
export const RENT_TO_EMI_FLAG =
  'rent modelled as rent; converts to an EMI at the Hyderabad purchase (no date set)';

export interface SurplusMonth {
  month: string;
  takeHomePaise: Paise;
  loanOutflowPaise: Paise;
  fixedOutflowPaise: Paise;
  childDentPaise: Paise;
  investablePaise: Paise;
}

export interface AnnualSurplus {
  year: number;
  investablePaise: Paise;
  /** Caveats that apply to this year's figure. See `RENT_TO_EMI_FLAG`. */
  flags: readonly string[];
}

export function loanOutflowByMonth(rows: ScheduleRow[]): Map<string, Paise> {
  const map = new Map<string, Paise>();
  for (const r of rows) {
    map.set(r.month, ((map.get(r.month) ?? 0n) + r.paymentPaise) as Paise);
  }
  return map;
}

/** Take-home steps up once per April (fiscal-year boundary) at `ASSUMPTIONS.salaryStepUp`. */
function takeHomeFor(month: string, base: Paise, from: string): Paise {
  const steps = fiscalYear(month) - fiscalYear(from);
  return steps <= 0 ? base : mulP(base, (1 + ASSUMPTIONS.salaryStepUp) ** steps);
}

function fiscalYear(month: string): number {
  const [y, mm] = month.split('-').map(Number) as [number, number];
  return mm >= 4 ? y : y - 1;
}

/**
 * ₹10k/month from the child's arrival.
 *
 * TODO(Task 10 — buckets): this dent has NO end condition. PRD §2.2 ends it when bucket
 * B4 activates, but B4 does not exist until Task 10, and inventing an end date here would
 * be fabricating a number. Harmless over the 24-month monthly horizon; in the ANNUAL view
 * (the tests project 300 months to 2050) it runs for 22 years and materially understates
 * late-horizon surplus. When B4 lands, gate this on B4 activation.
 */
function childDentFor(month: string): Paise {
  return month >= `${ASSUMPTIONS.childArrivalYear}-01-01`
    ? rupees(ASSUMPTIONS.childMonthlyDentInr)
    : (0n as Paise);
}

export function projectSurplus(opts: {
  from: string;
  months: number;
  closures: Map<string, string>;
  loanOutflowByMonth: Map<string, Paise>;
}): SurplusMonth[] {
  const fixed = addP(
    FIXED_OUTFLOWS.rent, FIXED_OUTFLOWS.motherSupport, FIXED_OUTFLOWS.wifeAllowance,
    FIXED_OUTFLOWS.maidAndMaintenance, FIXED_OUTFLOWS.misc,
  );

  // A month absent from the outflow map is genuinely zero only once every loan has closed.
  // Before that, absence means the caller paired this window with a cascade that does not
  // cover it — which would silently inflate investable surplus by a whole EMI block. The
  // closure dates are the only thing that tells the two apart, which is what `closures` is
  // for. The release month itself is a consequence of the cascade, never a literal.
  const lastClosure = [...opts.closures.values()].sort().at(-1);

  const out: SurplusMonth[] = [];
  let month = opts.from;
  for (let i = 0; i < opts.months; i++) {
    const takeHome = takeHomeFor(month, BASE_TAKE_HOME, opts.from);
    const known = opts.loanOutflowByMonth.get(month);
    if (known === undefined && lastClosure !== undefined && month <= lastClosure) {
      throw new Error(
        `loan outflow missing for ${month}: the cascade does not cover this projection window`,
      );
    }
    const loanOutflow = known ?? (0n as Paise);
    const childDent = childDentFor(month);
    const investable = subP(subP(subP(takeHome, loanOutflow), fixed), childDent);

    out.push({
      month, takeHomePaise: takeHome, loanOutflowPaise: loanOutflow,
      fixedOutflowPaise: fixed, childDentPaise: childDent, investablePaise: investable,
    });
    month = nextMonth(month);
  }
  return out;
}

export function projectAnnualSurplus(opts: {
  fromYear: number;
  toYear: number;
  monthly: SurplusMonth[];
}): AnnualSurplus[] {
  const byYear = new Map<number, Paise>();
  for (const m of opts.monthly) {
    const year = Number(m.month.slice(0, 4));
    if (year < opts.fromYear || year > opts.toYear) continue;
    byYear.set(year, addP(byYear.get(year) ?? (0n as Paise), m.investablePaise));
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, investablePaise]) => ({ year, investablePaise, flags: [RENT_TO_EMI_FLAG] }));
}
