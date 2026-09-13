import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import {
  MAX_LIST_ITEMS,
  buildReportInput,
  composeReport,
  reportBullets,
  type ReportInput,
} from '../../src/notify/report.js';
import { narrate } from '../../src/sources/llm-narration.js';
import { parseAsOf, parseGsecYield } from '../../src/jobs/report.js';
import { MAX_THESIS_WORDS, thesisWordCount } from '../../src/domain/recommendations.js';
import { IPS_V1_TEXT, getIpsClauseIndex } from '../../src/domain/ips.js';

const SEED_DATE = '2026-08-12';
/** Inside every freshness limit for SEED_DATE's data. */
const NOW = '2026-08-12T18:00:00+05:30';
const GSEC = 6.9;

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: SEED_DATE });
});

/** Makes every market source fresh: prices, NAVs, fundamentals, FX. */
async function makeEverythingFresh(priceAsOf = `${SEED_DATE}T12:00:00Z`): Promise<void> {
  await db.query(
    `insert into fx_rates (pair, as_of, rate_micros, source) values ('USD/INR', $1, 95300000, 'frankfurter')`,
    [SEED_DATE],
  );
  await db.query(
    `insert into navs (instrument_id, nav_date, nav_micros, source, as_of)
     values ('MF:PPFC', $1, 52850000, 'amfi', $2)`,
    [SEED_DATE, `${SEED_DATE}T12:00:00Z`],
  );
  const [upload] = await db.query<{ id: number }>(
    `insert into screener_uploads (as_of, filename, source) values ($1, 'fresh.csv', 'screener-in') returning id`,
    [SEED_DATE],
  );
  // A watchlist name that clears the quality gate, plus its price history.
  await db.query(
    `insert into watchlist (instrument_id, added_on, source, reason)
     values ('NSE:RPOWER', $1, 'advisor', 'starter watchlist')`,
    [SEED_DATE],
  );
  await db.query(
    `insert into fundamentals (upload_id, instrument_id, data, roce_pct, de_ratio, fcf_pos_5y, red_flags, as_of)
     values ($1, 'NSE:RPOWER', $2, 28, 0.2, true, 0, $3)`,
    [upload!.id, JSON.stringify({ 'P/E': '12', 'Profit 5Y CAGR %': '24', 'Sales 5Y CAGR %': '19' }), `${SEED_DATE}T12:00:00Z`],
  );

  let price = 100_000n;
  let bench = 2_000_000n;
  const end = new Date(`${SEED_DATE}T00:00:00Z`);
  for (let i = 299; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    await db.query(
      `insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of)
       values ('NSE:RPOWER', $1, $2, 'nse-bhavcopy', $3)
       on conflict (instrument_id, trade_date) do update set close_paise = excluded.close_paise, as_of = excluded.as_of`,
      [day, price.toString(), priceAsOf],
    );
    await db.query(
      `insert into index_prices_eod (series_code, trade_date, close_paise, as_of)
       values ('NIFTY 500', $1, $2, $3)
       on conflict (series_code, trade_date) do update set close_paise = excluded.close_paise`,
      [day, bench.toString(), priceAsOf],
    );
    price += price / 500n;
    bench += bench / 2000n;
  }
}

const build = (opts = {}): Promise<ReportInput> =>
  buildReportInput(db, SEED_DATE, { now: NOW, gsecYieldPct: GSEC, ...opts });

describe('FR-51 weekly report — the Phase 1 DoD', () => {
  it('produces at least one fully-formed paper recommendation with every timestamp shown', async () => {
    await makeEverythingFresh();
    const input = await build();
    const text = composeReport(input);

    expect(input.pipeline.recommendations.length).toBeGreaterThan(0);
    const validClauses = new Set(getIpsClauseIndex(IPS_V1_TEXT).map((c) => c.id));

    for (const rec of input.pipeline.recommendations) {
      // FR-11: primary + exactly two alternates, each a full payload.
      expect(rec.alternates).toHaveLength(2);
      for (const leg of [rec.primary, ...rec.alternates]) {
        expect(thesisWordCount(leg.thesis)).toBeGreaterThan(0);
        expect(thesisWordCount(leg.thesis)).toBeLessThanOrEqual(MAX_THESIS_WORDS);
        expect(leg.ipsClauseRefs.length).toBeGreaterThan(0);
        for (const ref of leg.ipsClauseRefs) expect(validClauses).toContain(ref);
      }
    }

    // Every data timestamp is on the page: the as-of, the generation time, and each
    // source's own freshness stamp.
    expect(text).toContain(SEED_DATE);
    expect(text).toContain(input.generatedAt);
    for (const row of input.staleness.rows) expect(text).toContain(row.asOf);
    expect(text).toContain('PAPER MODE');
  });

  it('a deliberately stale price blocks the name from every recommendation, and says why', async () => {
    await makeEverythingFresh();
    const fresh = await build();
    const freshText = composeReport(fresh);
    const scoredFresh = fresh.signalReview.scored.map((s) => s.instrumentId);
    expect(scoredFresh).toContain('NSE:RPOWER');
    expect(
      fresh.pipeline.recommendations.some((r) => r.primary.instrumentId === 'NSE:RPOWER'),
    ).toBe(true);
    expect(fresh.staleness.blocked.map((b) => b.instrumentId)).not.toContain('NSE:RPOWER');

    // The ONLY change: the price feed ages past its limit.
    await db.query(`update prices_eod set as_of = $1`, ['2026-08-01T12:00:00Z']);

    const stale = await build();
    const staleText = composeReport(stale);

    // (a) the name is listed under staleness, with the reason
    const blocked = stale.staleness.blocked.find((b) => b.instrumentId === 'NSE:RPOWER');
    expect(blocked, 'the stale name must be listed as blocked').toBeDefined();
    expect(blocked!.reason).toMatch(/bhavcopy/);
    expect(staleText).toContain('Blocked from recommendations');

    // (b) it is in no live recommendation, and was not scored at all. The one raised last
    // run does not vanish — it moves to `withheld`, which is the honest state.
    expect(stale.signalReview.scored.map((s) => s.instrumentId)).not.toContain('NSE:RPOWER');
    expect(stale.pipeline.recommendations.some((r) => r.primary.instrumentId === 'NSE:RPOWER')).toBe(false);
    expect(stale.pipeline.withheld.some((r) => r.primary.instrumentId === 'NSE:RPOWER')).toBe(true);
    expect(staleText).toContain('withheld until their data is fresh');

    // The diff between the two reports is the proof.
    expect(freshText).not.toBe(staleText);
    expect(freshText.includes('Blocked from recommendations')).toBe(false);
  });
});

describe('report sections', () => {
  it('states why the signal review did not run rather than scoring without a risk-free rate', async () => {
    await makeEverythingFresh();
    const input = await buildReportInput(db, SEED_DATE, { now: NOW });
    expect(input.signalReview.skippedReason).toMatch(/G-sec/);
    expect(input.signalReview.scored).toEqual([]);
    expect(composeReport(input)).toMatch(/Not run:/);
  });

  it('renders advisor watchlist additions as proposals awaiting sign-off', async () => {
    await makeEverythingFresh();
    const text = composeReport(await build());
    expect(text).toContain('awaiting your sign-off');
  });

  it('shows FR-12 suppressions instead of hiding them', async () => {
    await db.query(
      `insert into suppressed_actions (logged_on, action, reason, suppressed_by)
       values ($1, 'satellite:BUY:NSE:X', 'FR-12: cap reached', 'FR-12')`,
      [SEED_DATE],
    );
    const text = composeReport(await build());
    expect(text).toContain('Suppressed by FR-12');
    expect(text).toContain('cap reached');
  });

  it('collapses a long list instead of printing all of it', async () => {
    const many = Array.from({ length: MAX_LIST_ITEMS + 5 }, (_, i) => ({
      instrumentId: `NSE:B${i}`,
      reason: 'bhavcopy never delivered',
    }));
    const input = await build();
    const text = composeReport({ ...input, staleness: { ...input.staleness, blocked: many } });
    expect(text).toContain(`…and ${many.length - MAX_LIST_ITEMS} more`);
    expect(text).not.toContain(`NSE:B${MAX_LIST_ITEMS + 1}`);
  });

  it('renders the §13 calibration as "insufficient data", never as a zero percentage', async () => {
    await makeEverythingFresh();
    const input = await build();
    const text = composeReport(input);

    // The week's recommendations are benchmarked at creation, but nothing is due yet.
    expect(input.scoring.evaluated).toEqual([]);
    expect(input.scoring.calibration.insufficient).toBe(true);
    expect(text).toContain('No evaluations came due this week');
    expect(text).toContain('insufficient data');
    expect(text).not.toMatch(/0% hit-rate/);
  });

  it('captures a benchmark for each recommendation it raises', async () => {
    await makeEverythingFresh();
    const input = await build();
    const [count] = await db.query<{ n: string }>(`select count(*) as n from benchmarks`);
    expect(Number(count!.n)).toBe(
      input.pipeline.recommendations.filter((r) => r.createdOn === SEED_DATE).length,
    );
  });

  it('keeps each Telegram chunk inside the 4096-character limit', async () => {
    await makeEverythingFresh();
    const text = composeReport(await build());
    for (const line of text.split('\n')) expect(line.length).toBeLessThan(4096);
  });
});

describe('§6.7 narration', () => {
  const transport = (content: string): typeof fetch =>
    (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as unknown as typeof fetch;

  it('returns the model prose verbatim', async () => {
    const prose = 'The portfolio drifted below its gold floor this week.';
    expect(
      await narrate({ apiKey: 'k', fetchImpl: transport(prose), bullets: ['b'], engineJson: '{}' }),
    ).toBe(prose);
  });

  it('returns null without a key, and never calls the network', async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    expect(await narrate({ fetchImpl: spy, bullets: ['b'], engineJson: '{}' })).toBeNull();
    expect(called).toBe(false);
  });

  it('falls back to the deterministic bullets rather than failing the report', async () => {
    const failing = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await narrate({ apiKey: 'k', fetchImpl: failing, bullets: ['b'], engineJson: '{}' })).toBeNull();

    await makeEverythingFresh();
    const input = await build();
    expect(input.narrative).toBeNull();
    const text = composeReport(input);
    for (const bullet of reportBullets(input)) {
      expect(text).toContain(bullet.slice(0, 20));
    }
  });

  it('never sends a network request from the report build in tests', async () => {
    await makeEverythingFresh();
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    await build({ narration: { fetchImpl: spy } });
    expect(called).toBe(false);
  });
});

describe('report CLI arguments', () => {
  it('defaults to today and accepts --as-of', () => {
    expect(parseAsOf([], new Date('2026-09-13T00:00:00Z'))).toBe('2026-09-13');
    expect(parseAsOf(['--as-of', '2026-08-12'])).toBe('2026-08-12');
    expect(() => parseAsOf(['--as-of', 'last-tuesday'])).toThrow(/YYYY-MM-DD/);
  });

  it('treats a blank G-sec yield as unconfigured, never as 0%', () => {
    // An unset GitHub Actions secret interpolates to '', and Number('') is 0 — a 0%
    // risk-free rate would make every name look cheap.
    expect(parseGsecYield('')).toBeUndefined();
    expect(parseGsecYield(undefined)).toBeUndefined();
    expect(parseGsecYield('not-a-number')).toBeUndefined();
    expect(parseGsecYield('6.9')).toBe(6.9);
  });
});
