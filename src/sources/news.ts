import type { Db } from '../db/client.js';
import { attachmentUrl, bseResolver, fetchBseAnnouncements, fetchBseScrips, type BseRow, type BseScrip } from './bse.js';

/**
 * Material corporate events for held and watched companies (Phase 2.5 Task 2).
 *
 * Owner policy 2026-09-27: long-term investing acts only on material events; headlines
 * are noise. News may defer a BUY or flag a thesis for review — it never starts a BUY and
 * never sells on a headline (enforced where the advisor consumes it, Task 6).
 */

export type EventType =
  'results' | 'rating' | 'governance' | 'management' | 'mna' | 'corporate_action' | 'business' | 'unknown';

/** Coverage older than this blocks advice on the company (owner, 2026-09-27: 7 days). */
export const NEWS_SLA_DAYS = 7;

// Built from the categories BSE actually returned for the held and watched companies,
// Jun–Sep 2026 (100 companies, 322 material filings). Order matters: first match wins.
const MATERIAL: [RegExp, EventType][] = [
  [/financial result|earnings call|^result/i, 'results'],
  [/credit rating/i, 'rating'],
  [/auditor|pledge|encumbrance|default|fraud|insolvency|penalt|sebi order|litigation|clarification|reg\. ?29|sast|strike|lockout|disturbance|deviation/i, 'governance'],
  [/change in management|directorate|resignation|appointment|cessation|retirement/i, 'management'],
  [/acquisition|amalgamation|merger|demerger|restructuring|scheme of arrangement|divest|disinvest|diversification|joint venture|sale of shares|court convened/i, 'mna'],
  [/buy ?back|dividend|bonus|split|rights|allotment of equity|issue of securities|raising of funds/i, 'corporate_action'],
  [/award order|receipt order|monthly business update/i, 'business'],
];

const NOISE = /newspaper|analyst|investor meet|investor presentation|trading window|^agm$|^egm$|postal ballot|esop|esps|reg\. ?74|record date|book closure|brsr|annual report|memorandum|^board meeting$|^general$|press release|intimation|pit\) regulations|monitoring agency|meeting updates|registered office/i;

/**
 * The event type of a filing, or null when it is procedural noise. A category never
 * seen before is kept as 'unknown' — dropping it could hide exactly the event that mattered.
 */
export function classifyBseEvent(r: BseRow): EventType | null {
  const sub = String(r['SUBCATNAME'] ?? '').trim();
  const cat = String(r['CATEGORYNAME'] ?? '').trim();
  const label = sub || cat;
  for (const [re, type] of MATERIAL) if (re.test(label)) return type;
  if (/^Outcome of Board Meeting$/i.test(label)) return 'results';
  if (NOISE.test(label)) return null;
  return 'unknown';
}

/** Held and watched equities with their ISIN. Funds and ETFs file nothing corporate. */
async function coveredInstruments(db: Db): Promise<{ id: string; isin: string | null; name: string }[]> {
  return db.query<{ id: string; isin: string | null; name: string }>(
    `select distinct i.id, i.name, coalesce(i.isin, case when i.id like 'ISIN:%' then substr(i.id, 6) end) as isin
       from instruments i
      where i.kind = 'EQUITY' and coalesce(i.currency, 'INR') = 'INR'  -- US listings file nothing with BSE
        and (i.id in (select instrument_id from watchlist where removed_on is null)
             or i.id in (select h.instrument_id from holdings h
                          where h.snapshot_id in (select distinct on (source) id from snapshots
                                                   order by source, business_date desc, id desc)))
      order by i.id`,
  );
}

export interface NewsRunResult { companies: number; stored: number; failed: number; unresolved: number }

export async function recordNews(
  db: Db,
  opts: { now?: Date; days?: number; fetchImpl?: typeof fetch; scrips?: BseScrip[] } = {},
): Promise<NewsRunResult> {
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - (opts.days ?? 14) * 86_400_000);
  const resolve = bseResolver(opts.scrips ?? await fetchBseScrips(opts.fetchImpl));
  const result: NewsRunResult = { companies: 0, stored: 0, failed: 0, unresolved: 0 };
  const day = (d: Date) => d.toISOString().slice(0, 10);

  for (const inst of await coveredInstruments(db)) {
    result.companies++;
    const started = new Date();
    const symbol = inst.id.startsWith('NSE:') || inst.id.startsWith('BSE:') ? inst.id.slice(4) : null;
    const scrip = resolve({ isin: inst.isin, symbol, name: inst.name });
    const run = async (state: string, seen: number | null, stored: number | null, error: string | null) => db.query(
      `insert into news_fetch_runs (instrument_id, scope_key, window_from, window_to, state, seen, stored, error, started_at, completed_at, as_of)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [inst.id, scrip, day(from), day(now), state, seen, stored, error, started.toISOString(), now.toISOString()],
    );
    if (scrip === null) {
      result.unresolved++;
      await run('unresolved', null, null, `no active BSE equity matches ISIN ${inst.isin ?? 'none'}, symbol ${symbol ?? 'none'} or name "${inst.name}"`);
      continue;
    }
    try {
      const rows = await fetchBseAnnouncements(scrip, from, now, opts.fetchImpl);
      let stored = 0;
      for (const r of rows) {
        const type = classifyBseEvent(r);
        if (type === null) continue;
        const inserted = await db.query(
          `insert into news_events (dedupe_key, instrument_id, scope, event_type, headline, snippet, url,
             raw_category, raw_subcategory, critical, published_at, received_at, as_of, source)
           values ($1, $2, 'instrument', $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, 'bse')
           on conflict (dedupe_key) do nothing returning id`,
          [`bse:${String(r['NEWSID'])}`, inst.id, type, String(r['HEADLINE'] ?? r['NEWSSUB'] ?? '').slice(0, 500),
           String(r['NEWSSUB'] ?? '').slice(0, 1000) || null, attachmentUrl(r),
           r['CATEGORYNAME'] ?? null, r['SUBCATNAME'] ?? null, Number(r['CRITICALNEWS'] ?? 0) === 1,
           `${String(r['NEWS_DT'])}+05:30`, now.toISOString()],
        );
        stored += inserted.length;
      }
      result.stored += stored;
      await run(rows.length === 0 ? 'success_empty' : 'success', rows.length, stored, null);
    } catch (e) {
      result.failed++;
      await run('failed', null, null, e instanceof Error ? e.message : String(e));
    }
  }
  return result;
}

export type CoverageState = 'fresh' | 'stale' | 'missing' | 'unresolved';

/**
 * Whether the advisor may rely on this company's news being checked. Freshness is the
 * last SUCCESSFUL check (empty or not), never the newest article; a later failure keeps
 * the earlier success and its age and is reported alongside it.
 */
export async function newsCoverage(
  db: Db, instrumentId: string, now = new Date(),
): Promise<{ state: CoverageState; lastSuccessAt: string | null; lastFailure: boolean }> {
  const runs = await db.query<{ state: string; completed_at: string | Date }>(
    `select state, completed_at from news_fetch_runs where instrument_id = $1 order by completed_at desc, id desc limit 20`,
    [instrumentId],
  );
  if (runs.length === 0) return { state: 'missing', lastSuccessAt: null, lastFailure: false };
  const lastFailure = runs[0]!.state === 'failed';
  const success = runs.find((r) => r.state === 'success' || r.state === 'success_empty');
  if (!success) {
    return { state: runs[0]!.state === 'unresolved' ? 'unresolved' : 'missing', lastSuccessAt: null, lastFailure };
  }
  const at = new Date(success.completed_at);
  const fresh = now.getTime() - at.getTime() <= NEWS_SLA_DAYS * 86_400_000;
  return { state: fresh ? 'fresh' : 'stale', lastSuccessAt: at.toISOString(), lastFailure };
}
