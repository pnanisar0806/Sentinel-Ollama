import type { Db } from '../db/client.js';

/**
 * Portfolio drawdown, peak to trough, for the FR-34 and FR-35 rails.
 *
 * `portfolio_drawdown` existed and `checkRails` read it, but nothing ever wrote a row,
 * so the 15% no-loosening rail and the 20% §3.10 protocol could never fire. This writes
 * it.
 *
 * **Flow-neutral**, which is the whole difficulty. A simple peak-to-current on the
 * rupee value would count every salary SIP, every surplus deployment and the Sammaan
 * redemption as a gain — and a portfolio falling 20% while ₹50k a month flows in reads
 * as flat. Understating a drawdown is the unsafe direction for a guard whose job is to
 * refuse rail loosening during one. So the value is chained as a unit index instead:
 * each day's return is measured on the quantities held the day BEFORE, which is a price
 * effect only. A holding bought today does not move today's return; a holding sold
 * today drops out of both sides.
 *
 * Instruments whose "price" is really a balance — bank cash and EPF, reported as
 * quantity 0 — are held at a return of zero: a deposit is a flow, not a gain.
 *
 * **The ServiceNow RSU is priced from its own daily close.** It has no daily snapshot
 * history (three `manual-seed` rows at quantity 1), so it is added as a separate leg:
 * the units implied by today's RSU value at today's NOW close, priced each day from
 * `prices_eod` `US:NOW` (source `yahoo`, converted at that day's USD/INR). Units are held
 * constant between days, which is exactly the price-only return a vest (a flow) should
 * not disturb. Until 2026-09-24 the RSU — ~23% of the book — was left out entirely.
 *
 * Built from the `indmoney` snapshot stream alone: chaining across sources would mix
 * two different books.
 */

export const SOURCE = 'indmoney';

/** Balances, not prices: their day-over-day change is a flow. */
const BALANCE_KINDS = new Set(['CASH', 'EPF']);

export interface DrawdownPoint {
  asOf: string;
  /** Base 100 on the first day of history. */
  index: number;
  peakIndex: number;
  peakDate: string;
  /** Percent below the peak. 0 at a new high. */
  drawdownPct: number;
}

interface Holding { instrumentId: string; kind: string; quantity: number; valuePaise: number }

async function booksByDay(db: Db): Promise<Map<string, Map<string, Holding>>> {
  const rows = await db.query<{
    d: string; instrument_id: string; kind: string; quantity: string | number | null; value_paise: string | number;
  }>(
    `select s.business_date::text as d, h.instrument_id, i.kind, h.quantity, h.value_paise
       from snapshots s
       join holdings h on h.snapshot_id = s.id
       join instruments i on i.id = h.instrument_id
      where s.source = $1
        and s.id = (select s2.id from snapshots s2
                     where s2.source = s.source and s2.business_date = s.business_date
                     order by s2.id desc limit 1)
      order by 1`,
    [SOURCE],
  );
  const out = new Map<string, Map<string, Holding>>();
  for (const r of rows) {
    const book = out.get(r.d) ?? new Map<string, Holding>();
    // One instrument can sit in two accounts; sum it.
    const prior = book.get(r.instrument_id);
    const quantity = Number(r.quantity ?? 0) + (prior?.quantity ?? 0);
    const valuePaise = Number(r.value_paise) + (prior?.valuePaise ?? 0);
    book.set(r.instrument_id, { instrumentId: r.instrument_id, kind: r.kind, quantity, valuePaise });
    out.set(r.d, book);
  }
  return out;
}

/**
 * One day's price-only return, measured on yesterday's quantities.
 *
 * Null when the two days share nothing measurable, which would otherwise read as 0% and
 * look like a calm day.
 */
export function dayReturn(prev: Map<string, Holding>, next: Map<string, Holding>): number | null {
  let before = 0;
  let after = 0;
  for (const [id, p] of prev) {
    const n = next.get(id);
    if (n === undefined || p.valuePaise <= 0) continue; // sold: out of both sides
    if (BALANCE_KINDS.has(p.kind) || p.quantity <= 0 || n.quantity <= 0) {
      before += p.valuePaise;
      after += p.valuePaise; // a balance: its change is a flow, held flat
      continue;
    }
    before += p.valuePaise;
    after += p.quantity * (n.valuePaise / n.quantity); // yesterday's units at today's price
  }
  return before > 0 ? after / before - 1 : null;
}

/**
 * The RSU as one more holding in each day's book: constant units, that day's NOW close.
 * Nothing is added when there is no RSU position or no NOW price history, so the series
 * degrades to the INDmoney book rather than failing.
 */
async function addRsuLeg(db: Db, books: Map<string, Map<string, Holding>>): Promise<void> {
  const [pos] = await db.query<{ value_paise: string | number }>(
    `select h.value_paise from holdings h join snapshots s on s.id = h.snapshot_id
      where h.instrument_id = 'US:NOW' order by s.business_date desc, s.id desc limit 1`,
  );
  const closes = await db.query<{ d: string; close_paise: string | number }>(
    `select trade_date::text as d, close_paise from prices_eod
      where instrument_id = 'US:NOW' and source = 'yahoo' order by trade_date`,
  );
  if (!pos || closes.length === 0) return;
  const latest = Number(closes[closes.length - 1]!.close_paise);
  if (latest <= 0) return;
  const units = Number(pos.value_paise) / latest;

  for (const [day, book] of books) {
    // The last US close on or before this Indian date: US sessions and NSE sessions
    // do not line up, and a missing US day is not a price of zero.
    let price: number | null = null;
    for (const c of closes) { if (c.d <= day) price = Number(c.close_paise); else break; }
    if (price === null) continue;
    book.set('US:NOW', { instrumentId: 'US:NOW', kind: 'RSU', quantity: units, valuePaise: units * price });
  }
}

export async function drawdownSeries(db: Db): Promise<DrawdownPoint[]> {
  const books = await booksByDay(db);
  await addRsuLeg(db, books);
  const days = [...books.keys()].sort();
  const out: DrawdownPoint[] = [];
  let index = 100;
  let peakIndex = 100;
  let peakDate = days[0] ?? '';
  for (let i = 0; i < days.length; i++) {
    if (i > 0) {
      const r = dayReturn(books.get(days[i - 1]!)!, books.get(days[i]!)!);
      if (r !== null) index *= 1 + r;
    }
    if (index >= peakIndex) { peakIndex = index; peakDate = days[i]!; }
    out.push({
      asOf: days[i]!,
      index: Math.round(index * 100) / 100,
      peakIndex: Math.round(peakIndex * 100) / 100,
      peakDate,
      drawdownPct: Math.round((1 - index / peakIndex) * 10_000) / 100,
    });
  }
  return out;
}

/** Writes each day not yet recorded. Idempotent: an existing day is left alone. */
export async function recordDrawdown(db: Db): Promise<{ written: number; latest: DrawdownPoint | null }> {
  const series = await drawdownSeries(db);
  const have = new Set((await db.query<{ d: string }>(
    `select as_of::text as d from portfolio_drawdown`,
  )).map((r) => r.d));
  let written = 0;
  for (const p of series) {
    if (have.has(p.asOf)) continue;
    await db.query(
      `insert into portfolio_drawdown (as_of, current_pct, peak_date, peak_value)
       values ($1, $2, $3, $4)`,
      [p.asOf, p.drawdownPct, p.peakDate, p.peakIndex],
    );
    written += 1;
  }
  return { written, latest: series[series.length - 1] ?? null };
}

/** How old drawdown evidence may be before it no longer counts as evidence. */
export const DRAWDOWN_EVIDENCE_MAX_AGE_DAYS = 7;

/**
 * The latest drawdown, or null when there is no recent evidence.
 *
 * "Missing peak/drawdown evidence cannot approve a loosening" — so a caller that gets
 * null must refuse, not assume zero.
 */
export async function currentDrawdown(db: Db, now: Date = new Date()): Promise<number | null> {
  const [row] = await db.query<{ as_of: string; current_pct: string | number }>(
    `select as_of::text, current_pct from portfolio_drawdown order by as_of desc limit 1`,
  );
  if (!row) return null;
  const ageDays = (now.getTime() - new Date(`${row.as_of}T00:00:00Z`).getTime()) / 86_400_000;
  return ageDays > DRAWDOWN_EVIDENCE_MAX_AGE_DAYS ? null : Number(row.current_pct);
}
