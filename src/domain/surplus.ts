import { ASSUMPTIONS } from '../config/assumptions.js';
import { addP, formatInr, mulP, rupees, subP, type Paise } from '../money/paise.js';
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
 * The epoch `BASE_TAKE_HOME` is stated as of. PRD §2.1 quotes ₹2,15,000 for 2026, so the
 * April step-up ladder must be anchored here and NOT to whatever `from` a caller passes:
 * anchoring to `from` made the same calendar month yield a different take-home depending
 * on when the projection started (Apr-2027 read ₹2,36,500 from a 2026-09 start but
 * ₹2,15,000 from a 2027-04 start), silently rebasing salary to a stale figure for any
 * caller re-running from a later month. Same rule as every externally-sourced row
 * carrying its own `as_of`.
 */
export const BASE_TAKE_HOME_AS_OF = '2026-09-01';

/**
 * PRD §2.2: the Hyderabad rent converts to an equivalent EMI at the purchase. No purchase
 * date exists in `ASSUMPTIONS`, so the annual view carries this caveat on every row rather
 * than inventing a date or modelling a mortgage. When the owner supplies a purchase date,
 * narrow the flag to the years at or after it and move `FIXED_OUTFLOWS.rent` into the loan
 * cascade as a real EMI.
 */
export const RENT_TO_EMI_FLAG =
  'rent modelled as rent; converts to an EMI at the Hyderabad purchase (no date set)';

/**
 * The child dent has no end condition (see `childDentFor`). That is a real, signed
 * understatement of late-horizon surplus — up to ₹1.2L/year on every year from the child's
 * arrival onward — and it must ride on `flags` beside the rent caveat. A consumer that
 * sees only `RENT_TO_EMI_FLAG` would reasonably conclude it is the only caveat on the row.
 */
export const CHILD_DENT_NO_END_FLAG =
  `child dent (${formatInr(rupees(ASSUMPTIONS.childMonthlyDentInr))}/mo) has no end ` +
  'condition; PRD §2.2 ends it at bucket B4 activation, which does not exist until Task 10 ' +
  '— surplus from the child\'s arrival onward is understated by up to ₹1.2L/year';

/**
 * A year at the head or tail of the projection window can hold fewer than 12 rows, and its
 * total is then not comparable with a full year's. Unflagged, the real seed projection reads
 * as a 3.5x jump from 2026 (4 months) to 2027 and a 27% collapse from 2050 to 2051
 * (8 months) — both pure windowing artifacts. `monthCount` carries the exact figure.
 */
export const PARTIAL_YEAR_FLAG =
  'partial year: fewer than 12 months of this year fall inside the projection window';

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
  /** Months of this year that fell inside the projection window. < 12 ⇒ not comparable. */
  monthCount: number;
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

/**
 * Take-home steps up once per April (fiscal-year boundary) at `ASSUMPTIONS.salaryStepUp`,
 * counted from `asOf` — the epoch the base figure was quoted at — never from the caller's
 * projection start. See `BASE_TAKE_HOME_AS_OF`.
 */
function takeHomeFor(month: string, base: Paise, asOf: string): Paise {
  const steps = fiscalYear(month) - fiscalYear(asOf);
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
  // cover it — which would silently inflate investable surplus by a whole EMI block
  // (₹55,526/month at seed). The guard must therefore not be defeatable by its own
  // arguments: an earlier draft keyed coverage solely off `closures`, so an EMPTY closures
  // map silently no-op'd it. That is reachable in production, not hypothetical — `closures`
  // is produced only by `runCascade` and persisted nowhere (`loan_schedule` carries no
  // closure column), so any consumer reading a schedule back from Postgres holds an outflow
  // map and no closures at all.
  //
  // Coverage is therefore derived primarily from the outflow map's OWN key range: every
  // month at or before its last key must be present, so a window that starts before the
  // cascade (or straddles a hole in it) is always an error. `closures` stays as an
  // ADDITIONAL tail signal — it can reach past the last row a caller happened to pass in —
  // but nothing depends on it being populated. The release month is always a consequence of
  // one of these two, never a date literal.
  const outflowMonths = [...opts.loanOutflowByMonth.keys()].sort();
  const lastOutflow = outflowMonths.at(-1);
  const lastClosure = [...opts.closures.values()].sort().at(-1);

  // Defense in depth: asking for months with no schedule at all is always a mispairing.
  if (opts.months > 0 && lastOutflow === undefined) {
    throw new Error(
      'loan outflow missing for the whole window: the loan outflow map is empty, so the ' +
      'cascade does not cover this projection window',
    );
  }
  const coveredThrough =
    [lastOutflow, lastClosure].filter((m): m is string => m !== undefined).sort().at(-1) ?? '';

  const out: SurplusMonth[] = [];
  let month = opts.from;
  for (let i = 0; i < opts.months; i++) {
    const takeHome = takeHomeFor(month, BASE_TAKE_HOME, BASE_TAKE_HOME_AS_OF);
    const known = opts.loanOutflowByMonth.get(month);
    if (known === undefined && month <= coveredThrough) {
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
  interface Bucket { total: Paise; monthCount: number; dented: boolean }
  const byYear = new Map<number, Bucket>();
  for (const m of opts.monthly) {
    const year = Number(m.month.slice(0, 4));
    if (year < opts.fromYear || year > opts.toYear) continue;
    const b = byYear.get(year) ?? { total: 0n as Paise, monthCount: 0, dented: false };
    byYear.set(year, {
      total: addP(b.total, m.investablePaise),
      monthCount: b.monthCount + 1,
      // Read off the rows rather than re-deriving the arrival condition, so the caveat can
      // never disagree with the dent it is warning about.
      dented: b.dented || m.childDentPaise > 0n,
    });
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, b]) => ({
      year,
      investablePaise: b.total,
      monthCount: b.monthCount,
      flags: [
        RENT_TO_EMI_FLAG,
        ...(b.dented ? [CHILD_DENT_NO_END_FLAG] : []),
        ...(b.monthCount < 12 ? [PARTIAL_YEAR_FLAG] : []),
      ],
    }));
}
