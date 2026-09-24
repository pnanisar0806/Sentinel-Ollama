import type { Db } from '../db/client.js';

/**
 * Daily ServiceNow (NOW) closes in rupees, so the drawdown can include the RSU.
 *
 * The RSU is ~23% of the book and had no daily history — three `manual-seed` rows at
 * quantity 1 — so the flow-neutral drawdown had to leave it out, under-reporting any fall
 * in NOW. This stores one close per US session, converted at that day's USD/INR.
 *
 * Sources: Yahoo's chart endpoint (already used for the live NOW price in `rsu-live.ts`)
 * and Frankfurter's dated FX series (already the FX source).
 *
 * Stored in `prices_eod` as `US:NOW` with source `yahoo`. The FR-31 bhavcopy staleness
 * check reads `prices_eod` too, and was changed to count only `nse-bhavcopy` rows —
 * otherwise a fresh NOW close would make a dead NSE feed read as current.
 */
export const NOW_INSTRUMENT = 'US:NOW';
export const NOW_SOURCE = 'yahoo';

export interface DailyClose { date: string; closeCents: bigint }

export async function fetchNowCloses(range = '1y', fetchImpl: typeof fetch = fetch): Promise<DailyClose[]> {
  const res = await fetchImpl(`https://query1.finance.yahoo.com/v8/finance/chart/NOW?interval=1d&range=${range}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Sentinel/1.0)', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Yahoo NOW history: HTTP ${res.status}`);
  const body = await res.json() as {
    chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] };
  };
  const r = body.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators?.quote?.[0]?.close ?? [];
  const out: DailyClose[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    // A null close is a half-built bar, not a price of zero.
    if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0) continue;
    out.push({
      date: new Date(ts[i]! * 1000).toISOString().slice(0, 10),
      closeCents: BigInt(Math.round(c * 100)),
    });
  }
  return out;
}

/** USD/INR by date, from Frankfurter. Rates as micros, the unit `fx_rates` stores. */
export async function fetchUsdInrSeries(
  from: string, to: string, fetchImpl: typeof fetch = fetch,
): Promise<Map<string, bigint>> {
  const res = await fetchImpl(`https://api.frankfurter.app/${from}..${to}?from=USD&to=INR`);
  if (!res.ok) throw new Error(`Frankfurter USDINR series: HTTP ${res.status}`);
  const body = await res.json() as { rates?: Record<string, { INR?: number }> };
  const out = new Map<string, bigint>();
  for (const [date, r] of Object.entries(body.rates ?? {})) {
    // Same sanity band as `fetchUsdInr`: a wrong rate misprices the largest position.
    if (typeof r.INR === 'number' && r.INR > 50 && r.INR < 200) {
      out.set(date, BigInt(Math.round(r.INR * 1_000_000)));
    }
  }
  return out;
}

/**
 * NOW's close in paise on each date, at that date's rate — or the latest rate before it,
 * because Frankfurter publishes ECB business days and a US session can fall on a
 * European holiday. Cents × (INR per USD) is paise: 1 cent × ₹/$ = ₹/100 = 1 paisa.
 */
export function toPaise(closes: DailyClose[], rates: Map<string, bigint>): { date: string; closePaise: bigint }[] {
  const days = [...rates.keys()].sort();
  const out: { date: string; closePaise: bigint }[] = [];
  for (const c of closes) {
    let rate: bigint | undefined;
    for (const d of days) { if (d <= c.date) rate = rates.get(d); else break; }
    if (rate === undefined) continue; // no rate on or before: skip rather than guess
    out.push({ date: c.date, closePaise: (c.closeCents * rate) / 1_000_000n });
  }
  return out;
}

/** Writes each close not yet stored. Idempotent. */
export async function recordNowCloses(
  db: Db, opts: { range?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ written: number; latest: string | null }> {
  const closes = await fetchNowCloses(opts.range ?? '1y', opts.fetchImpl);
  if (closes.length === 0) return { written: 0, latest: null };
  const rates = await fetchUsdInrSeries(
    // Start a fortnight early so the first close has a rate to carry forward.
    new Date(new Date(`${closes[0]!.date}T00:00:00Z`).getTime() - 14 * 86_400_000).toISOString().slice(0, 10),
    closes[closes.length - 1]!.date,
    opts.fetchImpl,
  );
  await db.query(
    `insert into instruments (id, kind, name, currency) values ($1, 'RSU', 'ServiceNow', 'USD')
     on conflict (id) do nothing`, [NOW_INSTRUMENT]);
  let written = 0;
  for (const p of toPaise(closes, rates)) {
    const rows = await db.query<{ trade_date: string }>(
      `insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of)
       values ($1, $2, $3, $4, $5::timestamptz)
       on conflict do nothing returning trade_date`,
      [NOW_INSTRUMENT, p.date, p.closePaise.toString(), NOW_SOURCE, `${p.date}T21:00:00Z`]);
    written += rows.length;
  }
  return { written, latest: closes[closes.length - 1]!.date };
}
