import type { Db } from '../db/client.js';
import { OPERATING_SAVINGS_BANK } from '../sources/balances.js';
import { istDate, istMonth, loadSipCommitment, ORDER_PAISE_SQL, SIP_MAX_AGE_DAYS } from './sips.js';
import { assertRealDate } from './owner-log.js';
import { auditPayload } from './owner-sales.js';
import { loadRedemptions } from './bond-redemptions.js';

/**
 * Open list #10/#29 (owner, 2026-11-12): the payday entry and the payday-to-payday cash flow.
 *
 * INDmoney refreshes the HDFC balance only when the owner opens its app (prod: three changes in
 * 53 days), so the balance the cash flow needs is entered by hand on /log, right after the salary
 * lands. Only HDFC counts. Nothing here is modelled: every figure is an entry or a recorded fact,
 * and an input that is not known makes the result unknown, never 0.
 */

export const PAYDAY_ACCOUNT = OPERATING_SAVINGS_BANK;
/** Two payday entries closer than this are one cycle entered twice. */
const MIN_CYCLE_DAYS = 10;
/** The SIP commitment is frozen only if the payday is entered within this many days of it. */
const SIP_FREEZE_DAYS = 10;
/** The HDFC balance is stale once INDmoney has not changed it for this many days. */
export const BANK_STALE_DAYS = 7;

const DAY = 86_400_000;
const days = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const shift = (on: string, n: number): string => new Date(Date.parse(`${on}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const asIso = (v: string | Date): string => (v instanceof Date ? v : new Date(v)).toISOString();

/** The n-th last weekday (Mon–Fri) of a `YYYY-MM` month; n = 1 is the last. Bank holidays are not known. */
function nthLastWeekday(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  let d = new Date(Date.UTC(y, m, 0)); // last day of the month
  let seen = 0;
  for (;;) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && ++seen === n) return d.toISOString().slice(0, 10);
    d = new Date(d.getTime() - DAY);
  }
}
/** The owner's salary usually lands on the 2nd-last working day (owner, 2026-11-12). */
export const secondLastWeekday = (month: string): string => nthLastWeekday(month, 2);
const prevMonth = (month: string): string => new Date(Date.parse(`${month}-01T00:00:00Z`) - DAY).toISOString().slice(0, 7);

export interface Payday {
  id: string; on: string; account: string; salaryPaise: bigint; balancePaise: bigint;
  sipsPaise: bigint | null; sipsMonth: string | null; note: string;
}

/** Live (not reversed) payday entries, oldest first. */
export async function loadPaydays(db: Db): Promise<Payday[]> {
  const rows = await db.query<{ id: string; paid_on: string; account: string; salary_paise: string; balance_paise: string; sips_paise: string | null; sips_month: string | null; note: string }>(
    `select p.id::text, p.paid_on::text, p.account, p.salary_paise::text, p.balance_paise::text, p.sips_paise::text, p.sips_month, p.note
       from paydays p
      where not exists (select 1 from log_reversals r where r.entity = 'payday' and r.entity_id = p.id::text)
      order by p.paid_on, p.as_of`);
  return rows.map((r) => ({
    id: r.id, on: r.paid_on, account: r.account, salaryPaise: BigInt(r.salary_paise), balancePaise: BigInt(r.balance_paise),
    sipsPaise: r.sips_paise === null ? null : BigInt(r.sips_paise), sipsMonth: r.sips_month, note: r.note,
  }));
}

/**
 * The month whose SIPs the cycle ending on `on` paid: the payday's month, or the month before
 * when the salary landed in the first days of a month.
 */
const sipMonthOf = (on: string): string => shift(on, -7).slice(0, 7);

/**
 * Saves a payday: salary credited and the HDFC balance right after it. Also freezes the SIP
 * commitment of the month the cycle covers, because the SIP feed only knows today's SIPs; a
 * stale feed or a late (backfilled) entry leaves it NULL rather than guessing.
 */
export async function logPayday(
  db: Db, p: { on: string; salaryPaise: bigint; balancePaise: bigint; note?: string }, now = new Date().toISOString(),
): Promise<{ id: string }> {
  assertRealDate(p.on);
  if (p.on > istDate(now)) throw new Error(`${p.on} is in the future`);
  if (p.salaryPaise <= 0n) throw new Error('the salary credited must be positive');
  if (p.balancePaise < 0n) throw new Error('the HDFC balance cannot be negative');
  const note = (p.note ?? '').trim();
  if (note.length > 500) throw new Error('a note is limited to 500 characters');

  let sipsPaise: bigint | null = null;
  let sipsMonth: string | null = null;
  if (days(p.on, istDate(now)) <= SIP_FREEZE_DAYS) {
    sipsMonth = sipMonthOf(p.on);
    // The commitment as of the middle of that month; the feed behind it must be fresh NOW.
    const c = await loadSipCommitment(db, istMonth(now) === sipsMonth ? now : `${sipsMonth}-28T06:30:00Z`);
    const fresh = c.asOf !== null && Math.abs(Date.parse(now) - Date.parse(c.asOf)) <= SIP_MAX_AGE_DAYS * DAY;
    sipsPaise = fresh ? c.totalPaise : null;
    if (sipsPaise === null) sipsMonth = null;
  }

  return db.withTransaction(async (tx) => {
    // Serialise payday writes (a reversal of one takes no lock; single owner, one form).
    await tx.query(`lock table paydays in share row exclusive mode`);
    const near = (await loadPaydays(tx)).find((x) => Math.abs(days(x.on, p.on)) < MIN_CYCLE_DAYS);
    if (near) throw new Error(`a payday is already entered for ${near.on}; reverse it on the timeline first to change it`);
    const [row] = await tx.query<{ id: string }>(
      `insert into paydays (paid_on, account, salary_paise, balance_paise, sips_paise, sips_month, note, as_of, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'owner-web') returning id::text`,
      [p.on, PAYDAY_ACCOUNT, p.salaryPaise.toString(), p.balancePaise.toString(), sipsPaise?.toString() ?? null, sipsMonth, note, now]);
    await tx.query(
      `insert into audit_log (entity, entity_id, action, actor, payload) values ('payday', $1, 'LOGGED', 'owner', $2::jsonb)`,
      [row!.id, {
        on: p.on, account: PAYDAY_ACCOUNT, salaryPaise: p.salaryPaise.toString(), balancePaise: p.balancePaise.toString(),
        sipsPaise: sipsPaise?.toString() ?? null, sipsMonth, note, rowId: row!.id, source: 'owner-web',
      }]);
    return { id: row!.id };
  });
}

export interface PaydayDue {
  due: boolean;
  /** The month whose payday is (or will next be) due. */
  month: string;
  /** The day the reminder starts: that month's 2nd-last weekday. */
  from: string;
  lastOn: string | null;
}

/**
 * Whether the Overview asks for a payday entry. Due from the month's 2nd-last weekday until an
 * entry dated from its 3rd-last weekday (a day early) to 10 days into the next month exists. A
 * missed payday stays due until the next month's window opens. With no entry ever, only the
 * current month's window counts: the record starts from scratch.
 */
export async function paydayDue(db: Db, now: string): Promise<PaydayDue> {
  const today = istDate(now);
  const paydays = await loadPaydays(db);
  const lastOn = paydays.at(-1)?.on ?? null;
  const entered = (month: string) => {
    const lo = nthLastWeekday(month, 3);
    const hi = shift(nthLastWeekday(month, 1), MIN_CYCLE_DAYS);
    return paydays.some((p) => p.on >= lo && p.on <= hi);
  };
  const month = today.slice(0, 7);
  const from = secondLastWeekday(month);
  if (today >= from) return { due: !entered(month), month, from, lastOn };
  const prev = prevMonth(month);
  if (paydays.length > 0 && !entered(prev)) return { due: true, month: prev, from: secondLastWeekday(prev), lastOn };
  return { due: false, month, from, lastOn };
}

export interface BalanceAge {
  amountPaise: bigint;
  /** IST date INDmoney first reported this amount, after a different one. */
  lastChangedOn: string;
  /** IST date of the latest fetch. */
  fetchedOn: string;
  daysUnchanged: number;
  stale: boolean;
}

/**
 * How old the HDFC balance really is (#29). Sentinel fetches it daily, but INDmoney refreshes it
 * only when the owner opens its app, so the fetch date says nothing; the date the amount last
 * changed does. A balance that genuinely did not move for a week reads stale too: for a salary
 * account that is rare, and the warning only asks the owner to look.
 */
export async function bankBalanceAge(db: Db, now: string): Promise<BalanceAge | null> {
  const rows = await db.query<{ as_of: string | Date; amount_paise: string }>(
    `select as_of, amount_paise::text from balance_snapshots where kind = 'savings' and label = $1 order by as_of desc`,
    [PAYDAY_ACCOUNT]);
  if (rows.length === 0) return null;
  const amount = rows[0]!.amount_paise;
  let since = rows[0]!.as_of;
  for (const r of rows) {
    if (r.amount_paise !== amount) break;
    since = r.as_of;
  }
  const lastChangedOn = istDate(asIso(since));
  const daysUnchanged = days(lastChangedOn, istDate(now));
  return {
    amountPaise: BigInt(amount), lastChangedOn, fetchedOn: istDate(asIso(rows[0]!.as_of)),
    daysUnchanged, stale: daysUnchanged >= BANK_STALE_DAYS,
  };
}

export interface Cycle {
  /** Start payday (exclusive: its own day's entries came before the balance was taken). */
  from: string;
  /** End payday (inclusive). */
  to: string;
  /** The salary that funded the cycle: the start payday's. */
  salaryPaise: bigint;
  /** HDFC right after the start salary. */
  startBalancePaise: bigint;
  /** HDFC just before the end salary: the end entry's balance minus its salary. */
  endBalancePaise: bigint;
  /** Logged money in: money received (not from a sale or redemption), sales kept in the bank, bond redemptions. */
  otherInPaise: bigint;
  /** start + other in − end. */
  moneyOutPaise: bigint;
  sipsPaise: bigint | null;
  purchasesPaise: bigint;
  ordersPaise: bigint;
  investedPaise: bigint | null;
  /** Goal deposits logged as a transfer ("Money into a goal", monthly surplus / transfer). */
  setAsidePaise: bigint;
  loanPrincipalPaise: bigint | null;
  spendPaise: bigint | null;
  surplusPaise: bigint | null;
  /** Why a null is null. */
  unknown: string[];
}

const sum = async (db: Db, sql: string, params: unknown[]): Promise<bigint> =>
  BigInt((await db.query<{ n: string | null }>(sql, params))[0]?.n ?? '0');

/** Loan balances (INDmoney) as of the latest fetch on or before an IST date, by label; null if none. */
async function loansAsOf(db: Db, on: string): Promise<Map<string, bigint> | null> {
  const rows = await db.query<{ label: string; amount_paise: string }>(
    `select distinct on (label) label, amount_paise::text from balance_snapshots
      where kind = 'loan' and (as_of at time zone 'Asia/Kolkata')::date <= $1::date
      order by label, as_of desc`, [on]);
  const anyRow = await db.query(`select 1 from balance_snapshots where kind = 'loan' and (as_of at time zone 'Asia/Kolkata')::date <= $1::date limit 1`, [on]);
  return anyRow.length === 0 ? null : new Map(rows.map((r) => [r.label, BigInt(r.amount_paise)]));
}

/** Payday-to-payday cycles from consecutive live paydays, newest first. */
export async function loadCashflowCycles(db: Db): Promise<Cycle[]> {
  const paydays = await loadPaydays(db);
  const redemptions = [...(await loadRedemptions(db)).values()];
  const anyLoans = (await db.query(`select 1 from balance_snapshots where kind = 'loan' limit 1`)).length > 0;
  const out: Cycle[] = [];
  for (let i = 1; i < paydays.length; i++) {
    const a = paydays[i - 1]!;
    const b = paydays[i]!;
    const w = [a.on, b.on];
    const unknown: string[] = [];

    const otherIn =
      await sum(db, `select sum(l.amount_paise)::text n from lump_sums l
        where l.origin is null and l.received_on > $1::date and l.received_on <= $2::date
          and not exists (select 1 from log_reversals r where r.entity = 'lump_sum' and r.entity_id = l.id::text)`, w)
      + await sum(db, `select sum(s.proceeds_paise)::text n from owner_sales s
        where s.destination is null and s.sold_on > $1::date and s.sold_on <= $2::date
          and not exists (select 1 from audit_log x join log_reversals r on r.entity = 'owner_sale' and r.entity_id = x.id::text
                           where x.entity = 'owner_sale' and ${auditPayload('x')}->>'rowId' = s.id::text)`, w)
      + redemptions.filter((r) => r.amountPaise !== null && r.receivedOn > a.on && r.receivedOn <= b.on)
        .reduce((s, r) => s + r.amountPaise!, 0n);

    const purchasesPaise = await sum(db, `select sum(p.amount_paise)::text n from owner_purchases p
      where p.bought_on > $1::date and p.bought_on <= $2::date
        and not exists (select 1 from log_reversals r where r.entity = 'owner_purchase' and r.entity_id = p.id::text)`, w);
    // A BUY Sentinel proposed counts on the day it was first marked executed (FILLED or VERIFIED).
    const ordersPaise = await sum(db, `select round(sum(${ORDER_PAISE_SQL}))::bigint::text n from order_intents o
      where o.intent = 'BUY' and (select (min(t.at) at time zone 'Asia/Kolkata')::date from order_transitions t
                                   where t.order_intent_id = o.id and t.to_status in ('FILLED', 'VERIFIED'))
            between ($1::date + 1) and $2::date`, w);
    const setAsidePaise = await sum(db, `select sum(f.amount_paise)::text n from bucket_flows f
      where f.kind = 'sip' and f.amount_paise > 0 and f.source like 'owner-%'
        and f.occurred_on > $1::date and f.occurred_on <= $2::date
        and not exists (select 1 from log_reversals r where r.entity = 'bucket_flow' and r.entity_id = f.id::text)`, w);

    const sipsPaise = b.sipsPaise;
    if (sipsPaise === null) unknown.push(`SIP instalments for this cycle are unknown: the SIP feed was stale or the ${b.on} payday was entered more than ${SIP_FREEZE_DAYS} days late`);
    const investedPaise = sipsPaise === null ? null : sipsPaise + purchasesPaise + ordersPaise;

    let loanPrincipalPaise: bigint | null = 0n;
    if (anyLoans) {
      const start = await loansAsOf(db, a.on);
      const end = await loansAsOf(db, b.on);
      const labels = new Set([...(start?.keys() ?? []), ...(end?.keys() ?? [])]);
      const missing = [...labels].filter((l) => start === null || !start.has(l));
      if (missing.length > 0) {
        loanPrincipalPaise = null;
        unknown.push(`loan principal is unknown: no balance on or before ${a.on} for ${missing.join(', ')}`);
      } else {
        // A loan missing at the end was closed: it fell to 0.
        loanPrincipalPaise = [...labels].reduce((s, l) => s + start!.get(l)! - (end?.get(l) ?? 0n), 0n);
      }
    }

    const endBalancePaise = b.balancePaise - b.salaryPaise;
    const moneyOutPaise = a.balancePaise + otherIn - endBalancePaise;
    const spendPaise = investedPaise === null || loanPrincipalPaise === null
      ? null : moneyOutPaise - investedPaise - setAsidePaise - loanPrincipalPaise;
    out.push({
      from: a.on, to: b.on, salaryPaise: a.salaryPaise, startBalancePaise: a.balancePaise, endBalancePaise,
      otherInPaise: otherIn, moneyOutPaise, sipsPaise, purchasesPaise, ordersPaise, investedPaise, setAsidePaise,
      loanPrincipalPaise, spendPaise, surplusPaise: spendPaise === null ? null : a.salaryPaise + otherIn - spendPaise, unknown,
    });
  }
  return out.reverse();
}
