import type { Db } from '../db/client.js';

/**
 * NSE capital-market trading holidays.
 *
 * PROVENANCE — read this before trusting a date. NSE's own `/api/holiday-master` endpoint
 * blocks non-browser clients, so this list was cross-checked against two independent
 * broker mirrors (Groww and Upstox, fetched 2026-09-13) which agreed **exactly** on all
 * fifteen forward dates. It is second-hand and is an OWNER TRUE-UP ITEM: confirm against
 * NSE's "Trading Holidays — Capital Market Segment" circular.
 *
 * The asymmetry that makes a wrong entry expensive: a MISSING holiday costs one loud
 * failed sync step, while a WRONG holiday silently skips a real trading day and starves
 * every price-dependent engine. When in doubt, leave a date out.
 *
 * A `specialSession` row is the opposite case — the exchange is OPEN on a day the weekend
 * rule would skip.
 */
export interface HolidaySeed {
  date: string;
  note: string;
  specialSession?: boolean;
}

export const SEED_HOLIDAYS_2026: HolidaySeed[] = [
  { date: '2026-01-15', note: 'Municipal Corporation Election (Maharashtra)' },
  { date: '2026-01-26', note: 'Republic Day' },
  { date: '2026-03-03', note: 'Holi' },
  { date: '2026-03-26', note: 'Shri Ram Navami' },
  { date: '2026-03-31', note: 'Shri Mahavir Jayanti' },
  { date: '2026-04-03', note: 'Good Friday' },
  { date: '2026-04-14', note: 'Dr. Baba Saheb Ambedkar Jayanti' },
  { date: '2026-05-01', note: 'Maharashtra Day' },
  { date: '2026-05-28', note: 'Bakri Id' },
  { date: '2026-06-26', note: 'Muharram' },
  { date: '2026-09-14', note: 'Ganesh Chaturthi' },
  { date: '2026-10-02', note: 'Mahatma Gandhi Jayanti' },
  { date: '2026-10-20', note: 'Dussehra' },
  { date: '2026-11-10', note: 'Diwali-Balipratipada' },
  { date: '2026-11-24', note: 'Prakash Gurpurb Sri Guru Nanak Dev' },
  { date: '2026-12-25', note: 'Christmas' },
  // The exchange is OPEN here despite the weekend.
  { date: '2026-11-08', note: 'Muhurat trading (Diwali Laxmi Pujan) — timings per NSE circular', specialSession: true },
];

export async function seedHolidays(db: Db, holidays = SEED_HOLIDAYS_2026): Promise<number> {
  let written = 0;
  for (const h of holidays) {
    const rows = await db.query<{ holiday_date: string }>(
      `insert into holidays (holiday_date, note, is_special_session) values ($1, $2, $3)
       on conflict (holiday_date) do nothing
       returning holiday_date`,
      [h.date, h.note, h.specialSession ?? false],
    );
    written += rows.length;
  }
  return written;
}

/**
 * True when NSE publishes a bhavcopy for `date`. A weekday is a trading day unless the
 * calendar says otherwise; a weekend is not, unless the calendar says it is.
 *
 * With an EMPTY holidays table this degrades to the old weekend rule — wrong on about
 * fifteen days a year, but wrong in the loud direction.
 */
export async function isTradingDay(db: Db, date: string): Promise<boolean> {
  const [row] = await db.query<{ is_special_session: boolean }>(
    `select is_special_session from holidays where holiday_date = $1`,
    [date],
  );
  if (row !== undefined) return row.is_special_session;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
}
