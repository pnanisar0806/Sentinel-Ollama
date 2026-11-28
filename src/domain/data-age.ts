import type { Db } from '../db/client.js';
import { istDate } from './sips.js';

/**
 * Open list #29 (owner, 2026-11-20): how old INDmoney's data really is.
 *
 * INDmoney sends no per-row "last refreshed" time, and refreshes bank balances and EPF only when
 * the owner opens its app (or, for EPF, refreshes it there). Sentinel fetches daily, so the fetch
 * time says nothing; the date a value last changed does. Mutual fund values move daily with the
 * NAV, so for funds the test is whether the units rose after a SIP instalment.
 *
 * Warn only: nothing here blocks a plan or changes a value.
 */

/** Owner thresholds, 2026-11-20. */
export const BANK_STALE_DAYS = 2;
export const EPF_STALE_DAYS = 45;
export const SIP_UNITS_GRACE_DAYS = 5;

export interface BalanceAge {
  amountPaise: bigint;
  /** IST date INDmoney first reported this amount, after a different one. */
  lastChangedOn: string;
  /** IST date of the latest fetch. */
  fetchedOn: string;
  daysUnchanged: number;
  stale: boolean;
}

export interface SipUnitsAge {
  instrumentId: string;
  fundName: string;
  /** The latest monthly instalment at least the grace period old. */
  instalmentOn: string;
  /** Units in the last snapshot before the instalment day ('0' with none). */
  unitsBefore: string;
  /** Units in the latest snapshot ('0' with none). */
  unitsNow: string;
  stale: boolean;
}

export interface DataAge {
  banks: { label: string; age: BalanceAge }[];
  epf: BalanceAge | null;
  sipUnits: SipUnitsAge[];
}

const DAY = 86_400_000;
const days = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const asIso = (v: string | Date): string => (v instanceof Date ? v : new Date(v)).toISOString();

/** Pure: a newest-first series of fetched amounts, dated by its last change. */
export function seriesAge(rows: { at: string | Date; amountPaise: string }[], now: string, staleDays: number): BalanceAge | null {
  if (rows.length === 0) return null;
  const amount = rows[0]!.amountPaise;
  let since = rows[0]!.at;
  for (const r of rows) {
    if (r.amountPaise !== amount) break;
    since = r.at;
  }
  const lastChangedOn = istDate(asIso(since));
  const daysUnchanged = days(lastChangedOn, istDate(now));
  return { amountPaise: BigInt(amount), lastChangedOn, fetchedOn: istDate(asIso(rows[0]!.at)), daysUnchanged, stale: daysUnchanged >= staleDays };
}

/** One savings account's balance age, or null with no rows. */
export async function bankAge(db: Db, label: string, now: string): Promise<BalanceAge | null> {
  const rows = await db.query<{ at: string | Date; amountPaise: string }>(
    `select as_of at, amount_paise::text "amountPaise" from balance_snapshots where kind = 'savings' and label = $1 order by as_of desc`, [label]);
  return seriesAge(rows, now, BANK_STALE_DAYS);
}

/** `YYYY-MM-DD` for day `d` of month `ym`, or the month's last day when it has fewer days. */
function dayIn(ym: string, d: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${ym}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
const prevMonth = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};
const plain = (n: string): string => (n.includes('.') ? n.replace(/0+$/, '').replace(/\.$/, '') : n);

export async function loadDataAge(db: Db, now: string): Promise<DataAge> {
  const labels = await db.query<{ label: string }>(`select distinct label from balance_snapshots where kind = 'savings' order by label`);
  const banks: DataAge['banks'] = [];
  for (const { label } of labels) {
    const age = await bankAge(db, label, now);
    if (age) banks.push({ label, age });
  }

  // EPF summed per INDmoney snapshot: INDmoney has given the same EPF four different ids.
  const epfRows = await db.query<{ at: string | Date; amountPaise: string }>(
    `select s.taken_at at, sum(h.value_paise)::text "amountPaise"
       from snapshots s join holdings h on h.snapshot_id = s.id join instruments i on i.id = h.instrument_id
      where s.source = 'indmoney' and i.kind = 'EPF' group by s.id, s.taken_at order by s.taken_at desc`);
  const epf = seriesAge(epfRows, now, EPF_STALE_DAYS);

  // Live monthly SIPs, from the latest SIP snapshot; the first instalment a SIP is known from is
  // the earliest start date the feed ever gave it.
  const sips = await db.query<{ instrument_id: string; fund_name: string; day: number; first_on: string }>(
    `select x.instrument_id, x.fund_name, extract(day from x.start_date)::int as day,
            (select min(y.start_date) from sips y where y.sip_id = x.sip_id)::text first_on
       from sips x where x.snapshot_id = (select id from sip_snapshots order by as_of desc, id desc limit 1)
        and x.frequency = 'MONTHLY' order by x.fund_name`);
  const today = istDate(now);
  const sipUnits: SipUnitsAge[] = [];
  for (const s of sips) {
    let on = dayIn(today.slice(0, 7), s.day);
    if (days(on, today) < SIP_UNITS_GRACE_DAYS) on = dayIn(prevMonth(today.slice(0, 7)), s.day);
    if (on < s.first_on) continue;
    const [u] = await db.query<{ before: string; now: string; rose: boolean }>(
      `with snaps as (select s.id, s.taken_at, coalesce((select sum(h.quantity) from holdings h where h.snapshot_id = s.id and h.instrument_id = $1), 0) units
                        from snapshots s where s.source = 'indmoney'),
            b as (select units from snaps where (taken_at at time zone 'Asia/Kolkata')::date < $2::date order by taken_at desc limit 1),
            n as (select units from snaps order by taken_at desc limit 1)
       select coalesce((select units from b), 0)::text before, coalesce((select units from n), 0)::text now,
              coalesce((select units from n), 0) > coalesce((select units from b), 0) rose`,
      [s.instrument_id, on]);
    sipUnits.push({ instrumentId: s.instrument_id, fundName: s.fund_name, instalmentOn: on, unitsBefore: plain(u!.before), unitsNow: plain(u!.now), stale: !u!.rose });
  }
  return { banks, epf, sipUnits };
}
