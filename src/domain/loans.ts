import { type Paise } from '../money/paise.js';
import type { Db } from '../db/client.js';

export interface LoanInput {
  id: string;
  outstandingPaise: Paise;
  annualRateBps: number;
  emiPaise: Paise;
  cascadeOrder: number;
}

export interface ScheduleRow {
  loanId: string;
  /** First of the month, 'YYYY-MM-01'. */
  month: string;
  openingPaise: Paise;
  paymentPaise: Paise;
  interestPaise: Paise;
  principalPaise: Paise;
  closingPaise: Paise;
}

const MAX_MONTHS = 600; // 50-year guard, not a business rule.

export function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

/** Monthly interest on the opening balance: bps / 12, truncated to paise. */
function monthlyInterest(balance: Paise, annualRateBps: number): Paise {
  return ((balance * BigInt(annualRateBps)) / 120_000n) as Paise;
}

/**
 * One month of a single loan: interest on the opening balance, the scheduled
 * payment (EMI + any extra principal redirected onto it), and the resulting
 * split. The final month is capped at `balance + interest` so a loan never
 * overpays itself.
 *
 * Shared by `amortize` and `runCascade` — the two differ only in where `extra`
 * comes from, never in the arithmetic.
 */
function stepLoan(loan: LoanInput, month: string, balance: Paise, extra: Paise): ScheduleRow {
  const interest = monthlyInterest(balance, loan.annualRateBps);
  const scheduled = (loan.emiPaise + extra) as Paise;
  if (scheduled <= interest) {
    throw new Error(`loan ${loan.id} never amortises: EMI does not exceed monthly interest`);
  }
  const payment = (scheduled > balance + interest ? balance + interest : scheduled) as Paise;
  const principal = (payment - interest) as Paise;
  const closing = (balance - principal) as Paise;

  return {
    loanId: loan.id, month,
    openingPaise: balance, paymentPaise: payment,
    interestPaise: interest, principalPaise: principal, closingPaise: closing,
  };
}

export function amortize(
  loan: LoanInput,
  opts: { from: string; extraByMonth?: Map<string, Paise> },
): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let balance = loan.outstandingPaise;
  let month = opts.from;

  while (balance > 0n) {
    if (rows.length >= MAX_MONTHS) {
      throw new Error(`loan ${loan.id} never amortises: EMI does not exceed monthly interest`);
    }
    const extra = opts.extraByMonth?.get(month) ?? (0n as Paise);
    const row = stepLoan(loan, month, balance, extra);
    rows.push(row);

    balance = row.closingPaise;
    month = nextMonth(month);
  }
  return rows;
}

/**
 * PRD §2.2 committed cascade: all loans amortise concurrently from `from`, each
 * paying its own EMI every month. Loans close in cascadeOrder; the moment one
 * closes, the sum of all EMIs freed so far is redirected in full as extra
 * principal onto whichever loan is earliest in cascadeOrder and still open, so
 * total household loan outflow stays flat until the last loan dies — EXCEPT in a
 * closure month itself, which dips below the flat block.
 *
 * That dip is deliberate, not a leak. A closing loan's final payment is capped at
 * `balance + interest` (see `stepLoan`) so it never overpays, and `freedEmi` is
 * credited only after the month completes, so redirection starts the FOLLOWING
 * month. With the seed cascade from 2026-09 the household total is ₹55,526 for 85
 * months and dips to ₹41,707 in 2028-02 (car1's stub) and ₹42,466 in 2028-09
 * (car2's stub); the last month, 2033-12, is the home loan's own stub at ₹24,307.
 * A consumer asserting flatness must exempt the months in `closures.values()`.
 *
 * (Running each loan's full amortization sequentially — one after another —
 * would leave later-order loans paying nothing until earlier ones close, which
 * both breaks the flat-outflow invariant and delays every closure. The loans
 * must be stepped month-by-month in lockstep.)
 */
export function runCascade(
  loans: LoanInput[],
  from: string,
): { rows: ScheduleRow[]; closures: Map<string, string> } {
  const ordered = [...loans].sort((a, b) => a.cascadeOrder - b.cascadeOrder);
  const rows: ScheduleRow[] = [];
  const closures = new Map<string, string>();
  const balances = new Map<string, Paise>(ordered.map((l) => [l.id, l.outstandingPaise]));
  let freedEmi = 0n as Paise;
  let month = from;

  for (let i = 0; i < MAX_MONTHS && closures.size < ordered.length; i++) {
    const openLoan = ordered.find((l) => !closures.has(l.id));
    for (const loan of ordered) {
      if (closures.has(loan.id)) continue;
      const balance = balances.get(loan.id)!;
      const extra = loan.id === openLoan!.id ? freedEmi : (0n as Paise);
      const row = stepLoan(loan, month, balance, extra);
      rows.push(row);

      const closing = row.closingPaise;
      balances.set(loan.id, closing);
      if (closing === 0n) {
        closures.set(loan.id, month);
        freedEmi = (freedEmi + loan.emiPaise) as Paise;
      }
    }
    month = nextMonth(month);
  }

  if (closures.size < ordered.length) {
    throw new Error('cascade did not close all loans within the horizon');
  }

  return { rows, closures };
}

export function interestPaid(rows: ScheduleRow[], loanId?: string): Paise {
  return rows
    .filter((r) => !loanId || r.loanId === loanId)
    .reduce((sum, r) => sum + r.interestPaise, 0n) as Paise;
}

interface LoanRow {
  id: string;
  outstanding_paise: string;
  annual_rate_bps: number;
  emi_paise: string;
  cascade_order: number;
}

/** Recomputes and replaces both scenarios. loan_schedule is derived state, not audit. */
export async function persistSchedules(db: Db, from: string): Promise<void> {
  const rows = await db.query<LoanRow>(
    'select id, outstanding_paise, annual_rate_bps, emi_paise, cascade_order from loans',
  );
  const loans: LoanInput[] = rows.map((r) => ({
    id: r.id,
    outstandingPaise: BigInt(r.outstanding_paise) as Paise,
    annualRateBps: Number(r.annual_rate_bps),
    emiPaise: BigInt(r.emi_paise) as Paise,
    cascadeOrder: Number(r.cascade_order),
  }));

  const natural = loans.flatMap((l) => amortize(l, { from }));
  const { rows: cascade } = runCascade(loans, from);

  await db.query('delete from loan_schedule');
  for (const [scenario, set] of [['NATURAL', natural], ['CASCADE', cascade]] as const) {
    for (const r of set) {
      await db.query(
        `insert into loan_schedule (loan_id, scenario, period_month, opening_paise,
           payment_paise, interest_paise, principal_paise, closing_paise)
         values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [r.loanId, scenario, r.month, r.openingPaise.toString(), r.paymentPaise.toString(),
         r.interestPaise.toString(), r.principalPaise.toString(), r.closingPaise.toString()],
      );
    }
  }
}
