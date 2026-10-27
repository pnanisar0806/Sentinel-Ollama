import type { Db } from '../db/client.js';
import { attachmentUrl, bseResolver, fetchBseAnnouncements, fetchBseScrips, type BseRow, type BseScrip } from './bse.js';

/**
 * Material corporate events for held and watched companies (Phase 2.5 Task 2).
 *
 * Owner policy 2026-09-27: long-term investing acts only on material events; headlines
 * are noise. News may defer a BUY or flag a thesis for review — it never starts a BUY and
 * never sells on a headline (enforced where the advisor consumes it, Task 6).
 */

type EventType =
  'results' | 'rating' | 'governance' | 'management' | 'mna' | 'corporate_action' | 'business' | 'unknown';

/** Coverage older than this blocks advice on the company (owner, 2026-09-27: 7 days). */
const NEWS_SLA_DAYS = 7;

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
async function coveredInstruments(db: Db): Promise<Instrument[]> {
  return db.query<Instrument>(
    `select distinct i.id, i.name, coalesce(i.isin, case when i.id like 'ISIN:%' then substr(i.id, 6) end) as isin
       from instruments i
      where i.kind = 'EQUITY' and coalesce(i.currency, 'INR') = 'INR'  -- US listings file nothing with BSE
        and (i.id in (select instrument_id from watchlist_effective where removed_on is null)
             or i.id in (select h.instrument_id from holdings h
                          where h.snapshot_id in (select distinct on (source) id from snapshots
                                                   order by source, business_date desc, id desc)))
      order by i.id`,
  );
}

interface NewsRunResult { companies: number; stored: number; failed: number; unresolved: number }
type RunState = 'success' | 'success_empty' | 'failed' | 'unresolved';
type Instrument = { id: string; isin: string | null; name: string };

const day = (d: Date) => d.toISOString().slice(0, 10);

/** The news_events columns read from a BSE row — what is stored, and what the classifiers see. */
export const bseEventFields = (r: BseRow) => ({
  headline: String(r['HEADLINE'] ?? r['NEWSSUB'] ?? '').slice(0, 500),
  snippet: String(r['NEWSSUB'] ?? '').slice(0, 1000) || null,
  rawCategory: r['CATEGORYNAME'] == null ? null : String(r['CATEGORYNAME']),
  rawSubcategory: r['SUBCATNAME'] == null ? null : String(r['SUBCATNAME']),
});

/**
 * Fetches one company's filings over [from, now], stores the material ones and writes the
 * news_fetch_runs row. Shared by the daily news run and the three-year governance backfill.
 * A governance event BSE files under a category the material list calls noise (a fraud
 * disclosed as "General") is still stored, as 'governance', so the governance check sees it.
 */
async function fetchAndStore(
  db: Db, inst: Instrument, resolve: ReturnType<typeof bseResolver>, from: Date, now: Date, fetchImpl?: typeof fetch,
): Promise<{ state: RunState; stored: number }> {
  const started = new Date();
  const symbol = inst.id.startsWith('NSE:') || inst.id.startsWith('BSE:') ? inst.id.slice(4) : null;
  const scrip = resolve({ isin: inst.isin, symbol, name: inst.name });
  const run = async (state: RunState, seen: number | null, stored: number | null, error: string | null) => {
    await db.query(
      `insert into news_fetch_runs (instrument_id, scope_key, window_from, window_to, state, seen, stored, error, started_at, completed_at, as_of)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
      [inst.id, scrip, day(from), day(now), state, seen, stored, error, started.toISOString(), now.toISOString()],
    );
    return { state, stored: stored ?? 0 };
  };
  if (scrip === null) {
    return run('unresolved', null, null, `no active BSE equity matches ISIN ${inst.isin ?? 'none'}, symbol ${symbol ?? 'none'} or name "${inst.name}"`);
  }
  try {
    const rows = await fetchBseAnnouncements(scrip, from, now, fetchImpl);
    let stored = 0;
    for (const r of rows) {
      const f = bseEventFields(r);
      const type = classifyBseEvent(r) ?? (isGovernanceEvent(f) ? 'governance' : null);
      if (type === null) continue;
      const inserted = await db.query(
        `insert into news_events (dedupe_key, instrument_id, scope, event_type, headline, snippet, url,
           raw_category, raw_subcategory, critical, published_at, received_at, as_of, source)
         values ($1, $2, 'instrument', $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, 'bse')
         on conflict (dedupe_key) do nothing returning id`,
        [`bse:${String(r['NEWSID'])}`, inst.id, type, f.headline, f.snippet, attachmentUrl(r),
         f.rawCategory, f.rawSubcategory, Number(r['CRITICALNEWS'] ?? 0) === 1,
         `${String(r['NEWS_DT'])}+05:30`, now.toISOString()],
      );
      stored += inserted.length;
    }
    return run(rows.length === 0 ? 'success_empty' : 'success', rows.length, stored, null);
  } catch (e) {
    return run('failed', null, null, e instanceof Error ? e.message : String(e));
  }
}

export async function recordNews(
  db: Db,
  opts: { now?: Date; days?: number; fetchImpl?: typeof fetch; scrips?: BseScrip[] } = {},
): Promise<NewsRunResult> {
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - (opts.days ?? 14) * 86_400_000);
  const resolve = bseResolver(opts.scrips ?? await fetchBseScrips(opts.fetchImpl));
  const result: NewsRunResult = { companies: 0, stored: 0, failed: 0, unresolved: 0 };
  for (const inst of await coveredInstruments(db)) {
    result.companies++;
    const r = await fetchAndStore(db, inst, resolve, from, now, opts.fetchImpl);
    result.stored += r.stored;
    if (r.state === 'failed') result.failed++;
    if (r.state === 'unresolved') result.unresolved++;
  }
  return result;
}

type CoverageState = 'fresh' | 'stale' | 'missing' | 'unresolved';

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

/* ── Governance events: the management check's leg (a), Piece 3 Task 1 ── */

export type GovernanceKind =
  'auditor_resignation' | 'sebi_order' | 'fraud' | 'default_insolvency' | 'pledge_invocation' | 'rating_downgrade';

const GOVERNANCE_YEARS = 3;
/** A clean governance record is trusted for this long after the backfill that proved it. */
const GOVERNANCE_FRESH_DAYS = 35;

// Never an event by itself, whatever the text says: the exchange asking for a
// clarification, a strike or lockout, Reg 29 / SAST holding disclosures, and SEBI's periodic
// quarterly default return (often filed NIL; the event-based 24-hour disclosure is the default).
const NEVER = /\b(clarifications?|strikes?|lockouts?|sast)\b|reg\.? ?29|quarterly disclosures by listed entities of defaults/i;
const SEBI = String.raw`(?:sebi|securities and exchange board of india)`;
// Checked in order; first match wins. Built against the real filings in tests/fixtures/bse.
// "SEBI" alone is useless: nearly every filing cites "Regulation 30 of SEBI (LODR)", often
// next to "order" (a purchase order). So a SEBI order needs SEBI as the actor.
const GOVERNANCE: [GovernanceKind, (label: string, text: string) => boolean][] = [
  // The statutory auditor; an internal, secretarial or cost auditor leaving is not the red flag.
  ['auditor_resignation', (_, t) => (/statutory auditor/i.test(t) || !/(internal|secretarial|cost) auditor/i.test(t))
    && /(resignation|cessation)\W+of\W+(the\W+)?(\w+\W+){0,2}auditors?\b|auditors?\b[^.]{0,30}\b(resign|ceas)/i.test(t)],
  ['fraud', (_, t) => /\bfrauds?\b(?!\s+(control|risk|prevention|detection|monitoring|management))/i.test(t)],
  ['sebi_order', (_, t) => new RegExp(String.raw`\b${SEBI}\W+((adjudication|settlement|interim|final|confirmatory)\W+)?order|\b(order|penalty|adjudication)\b[^.]{0,40}?\b(by|from)\W+(the\W+)?(adjudicating officer\W+(of\W+|,\W*)?)?${SEBI}\b(?!\s*\()`, 'i').test(t)],
  ['default_insolvency', (l, t) =>
    // BSE's own CIRP labels; in free text only an admission *into insolvency* counts — NCLT
    // also "admits" scheme-of-arrangement petitions (Sammaan Capital, 2026-09).
    /corporate insolvency resolution process|\bcirp\b|resolution professional|committee of creditors|admission of application by tribunal/i.test(l)
    || /(admitted|admission)[^.]{0,60}\b(cirp|insolvency)|defaults? on payment|default(ed)? (in|on) (the )?(re)?payment/i.test(t)],
  ['pledge_invocation', (_, t) => /invocation of (the )?pledge|pledge[^.]{0,40}invok|invok\w*[^.]{0,40}pledge/i.test(t)],
  ['rating_downgrade', (l, t) => /credit rating/i.test(l) && /downgrad/i.test(t)],
];

/**
 * The governance red flag a filing reports, or null. Narrow by design (spec Decision 5):
 * litigation, a tax penalty or show-cause, a clarification, a strike, a SAST disclosure and
 * a pledge *creation* are never events. A rating filing counts only when its headline or
 * subject says "downgrade" — BSE filings rarely do; the direction is in the PDF, which is
 * not parsed (owner, 2026-10-26).
 */
export function isGovernanceEvent(r: {
  rawCategory: string | null; rawSubcategory: string | null; headline: string; snippet: string | null;
}): GovernanceKind | null {
  // The label is BSE's own classification: category, subcategory and the subject line
  // (NEWSSUB, stored as snippet), which BSE prefixes with the category for CIRP filings.
  const label = [r.rawCategory, r.rawSubcategory, r.snippet].filter(Boolean).join(' | ');
  if (NEVER.test([r.rawCategory, r.rawSubcategory].filter(Boolean).join(' | '))) return null;
  const text = `${label} | ${r.headline}`;
  for (const [kind, test] of GOVERNANCE) if (test(label, text)) return kind;
  return null;
}

const yearsBefore = (d: Date, years: number) => { const x = new Date(d); x.setUTCFullYear(x.getUTCFullYear() - years); return x; };

/** Fetches three years of one company's BSE filings into news_events (one run row). */
export async function backfillGovernance(
  db: Db, instrumentId: string, now: Date, opts: { fetchImpl?: typeof fetch; scrips?: BseScrip[] } = {},
): Promise<{ state: RunState; stored: number }> {
  const [inst] = await db.query<Instrument>(
    `select id, name, coalesce(isin, case when id like 'ISIN:%' then substr(id, 6) end) as isin from instruments where id = $1`,
    [instrumentId],
  );
  if (!inst) throw new Error(`backfillGovernance: unknown instrument ${instrumentId}`);
  const resolve = bseResolver(opts.scrips ?? await fetchBseScrips(opts.fetchImpl));
  return fetchAndStore(db, inst, resolve, yearsBefore(now, GOVERNANCE_YEARS), now, opts.fetchImpl);
}

/**
 * CLEAR only on proof: a successful run that covered three years and is at most 35 days
 * old. Without one the record is UNCHECKED — a failure for the caller, never a pass.
 * Events found in the stored filings are listed whatever the status.
 */
export async function governanceStatus(db: Db, instrumentId: string, now: Date): Promise<{
  status: 'CLEAR' | 'EVENT' | 'UNCHECKED';
  events: { on: string; kind: GovernanceKind; headline: string }[];
  checkedAt: string | null;
}> {
  const [run] = await db.query<{ completed_at: string | Date }>(
    `select completed_at from news_fetch_runs
      where instrument_id = $1 and state in ('success', 'success_empty')
        and window_from <= completed_at - interval '${GOVERNANCE_YEARS} years' + interval '1 day'
        and completed_at >= $2::timestamptz - interval '${GOVERNANCE_FRESH_DAYS} days'
      order by completed_at desc, id desc limit 1`,
    [instrumentId, now.toISOString()],
  );
  const rows = await db.query<{ on: string; headline: string; snippet: string | null; raw_category: string | null; raw_subcategory: string | null }>(
    `select (published_at at time zone 'Asia/Kolkata')::date::text as on, headline, snippet, raw_category, raw_subcategory
       from news_events
      where instrument_id = $1 and published_at > $2::timestamptz - interval '${GOVERNANCE_YEARS} years' and published_at <= $2::timestamptz
      order by published_at, id`,
    [instrumentId, now.toISOString()],
  );
  const events = rows.flatMap((e) => {
    const kind = isGovernanceEvent({ rawCategory: e.raw_category, rawSubcategory: e.raw_subcategory, headline: e.headline, snippet: e.snippet });
    return kind ? [{ on: e.on, kind, headline: e.headline }] : [];
  });
  if (!run) return { status: 'UNCHECKED', events, checkedAt: null };
  return { status: events.length > 0 ? 'EVENT' : 'CLEAR', events, checkedAt: new Date(run.completed_at).toISOString() };
}
