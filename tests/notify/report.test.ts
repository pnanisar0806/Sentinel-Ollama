import { readFile } from 'node:fs/promises';
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
import { MAX_THESIS_WORDS, buildRecommendation, persistRecommendation, thesisWordCount } from '../../src/domain/recommendations.js';
import { IPS_V1_TEXT, getIpsClauseIndex } from '../../src/domain/ips.js';
import { parseMfSips } from '../../src/sources/indmoney.js';
import { loadFreeEnvelope, persistSipSnapshot } from '../../src/domain/sips.js';
import { logPurchase } from '../../src/domain/owner-log.js';
import { IPS_BANDS } from '../../src/domain/allocation.js';
import { monthlyReviewDone } from '../../src/domain/cadence.js';
import { classify } from '../../src/domain/networth.js';
import { railPaise } from '../../src/domain/rail-values.js';

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
    // A known, empty SIP book keeps the free envelope at the ₹50k budget, so the GOLD BUY is
    // sized rather than suppressed as unknown (spec 2026-10-14).
    await persistSipSnapshot(db, [], NOW);
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
    // Stock ideas now reach recommendations only through signed advice (Phase 2.5). Stand
    // in for one the owner signed while the data was fresh.
    await persistRecommendation(db, buildRecommendation({
      kind: 'satellite', createdOn: SEED_DATE,
      primary: { intent: 'add satellite equity exposure', instrumentId: 'NSE:RPOWER', action: 'BUY', amountPaise: '5000000',
        thesis: 'Signed advice.', ipsClauseRefs: ['3.4'], falsification: { metric: 'roce_pct', op: 'lt', value: 15 } },
    }));
    expect((await build()).pipeline.recommendations.some((r) => r.primary.instrumentId === 'NSE:RPOWER')).toBe(true);
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

const live = parseMfSips({
  result: JSON.stringify(JSON.parse(await readFile('tests/fixtures/indmoney-mf-sips-2026-10-14.json', 'utf8')).payload),
});

describe('rebalance sizing reads live SIPs (spec 2026-10-14)', () => {
  // The seeded book is GOLD under its floor by ~₹2.17L, so the rebalance wants a GOLD BUY.
  const goldBuys = (input: ReportInput) => input.pipeline.recommendations
    .filter((r) => r.primary.action === 'BUY' && /GOLD/.test(r.intent));

  it('sizes the rebalance tranche at budget minus live SIPs', async () => {
    await persistSipSnapshot(db, live, NOW);
    const input = await build();
    const env = await loadFreeEnvelope(db, NOW);
    expect(env.envelopePaise).not.toBeNull();
    const [gold] = goldBuys(input);
    expect(gold).toBeDefined();
    expect(BigInt(gold!.primary.amountPaise!)).toBeLessThanOrEqual(env.envelopePaise!);
  });

  it("sizes the tranche at what remains after this month's logged purchases (SIP gaps Task 2)", async () => {
    await persistSipSnapshot(db, live, NOW);
    await logPurchase(db, { boughtOn: '2026-08-10', description: 'Zerodha Gold ETF', amountPaise: 500_000n }, NOW);
    const env = await loadFreeEnvelope(db, NOW);
    expect(env.remainingPaise! < env.envelopePaise!).toBe(true);
    const [gold] = goldBuys(await build());
    expect(BigInt(gold!.primary.amountPaise!)).toBe(env.remainingPaise!);
  });

  it('a fully deployed month is a known ₹0: the BUY is suppressed with that reason, and the month is consumed', async () => {
    await persistSipSnapshot(db, live, NOW);
    const envelope = (await loadFreeEnvelope(db, NOW)).envelopePaise!;
    await logPurchase(db, { boughtOn: '2026-08-10', description: 'Zerodha Gold ETF', amountPaise: envelope }, NOW);
    const input = await build();
    expect(goldBuys(input)).toEqual([]);
    expect(input.pipeline.suppressed.find((x) => x.action === 'rebalance:BUY:GOLD')?.reason).toMatch(/already deployed/);
    expect(await monthlyReviewDone(db, 'recommendations', SEED_DATE.slice(0, 7))).toBe(true);
  });

  it('with no SIP data it suppresses the BUY and says why', async () => {
    const input = await build();
    expect(goldBuys(input)).toEqual([]);
    expect(input.pipeline.suppressed.some((s) => s.suppressedBy === 'SIP_ENVELOPE')).toBe(true);
  });

  // Withheld counts as proposed: this book has no price history, so FR-31 withholds a TRIM
  // on a stale name — the engine still proposed it, which is what these tests are about.
  const proposed = (input: ReportInput) => [...input.pipeline.recommendations, ...input.pipeline.withheld]
    .map((r) => r.primary.action);

  /** A book of NIFTYBEES (equity), a liquid fund (debt) and GOLDBEES, in rupees. */
  async function bookOf(equity: number, debt: number, gold: number): Promise<Db> {
    const book = await openDb();
    await runMigrations(book);
    await book.query(`insert into instruments (id, kind, name, currency) values
      ('NSE:NIFTYBEES', 'EQUITY', 'Nifty BeES', 'INR'), ('MF:LIQ', 'MF', 'Liquid Fund', 'INR'),
      ('NSE:GOLDBEES', 'GOLD', 'Gold BeES', 'INR')`);
    const [snap] = await book.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ($1, 'indmoney') returning id`, [SEED_DATE]);
    await book.query(
      `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
       values ($1, 'NSE:NIFTYBEES', 'zerodha', 1, $3, 'indmoney', $2::timestamptz),
              ($1, 'MF:LIQ', 'zerodha', 1, $4, 'indmoney', $2::timestamptz),
              ($1, 'NSE:GOLDBEES', 'zerodha', 1, $5, 'indmoney', $2::timestamptz)`,
      [snap!.id, `${SEED_DATE}T12:00:00Z`, equity * 100, debt * 100, gold * 100]);
    return book;
  }
  /** EQUITY 70% against a 60% ceiling: 10 points over, beyond SELL_TOLERANCE, so flow-vs-trim is live. */
  const overweightEquityBook = (scale = 1): Promise<Db> => bookOf(70_000 * scale, 22_000 * scale, 8_000 * scale);

  it('an unknown envelope never proposes a SALE: it proposes nothing, says why, and keeps the month open', async () => {
    // Fix round 2: this used to assert a REDIRECT and no TRIM from an unknown run. An unknown
    // run now proposes no rebalance action at all, so the stronger claim is that nothing — a
    // sale least of all — is proposed on missing data, and the run explains itself.
    const book = await overweightEquityBook(10);
    const input = await buildReportInput(book, SEED_DATE, { now: NOW });
    expect(proposed(input)).toEqual([]);
    const held = input.pipeline.suppressed.find((x) => x.action === 'rebalance:ALL');
    expect(held?.suppressedBy).toBe('SIP_ENVELOPE');
    expect(held?.reason).toBe((await loadFreeEnvelope(book, NOW)).reason);
    expect(await monthlyReviewDone(book, 'recommendations', SEED_DATE.slice(0, 7))).toBe(false);
    // Not vacuous: the same book, once its SIPs are known, does get a rebalance proposal.
    await persistSipSnapshot(book, live, NOW);
    expect(proposed(await buildReportInput(book, SEED_DATE, { now: NOW }))).toContain('TRIM');
    await book.close();
  });

  it('live equity SIPs reach the engine and count against diluting an equity overweight', async () => {
    // Each month moves the overshoot by inflow·(1−max) − max·dilution, so equity SIPs cancel
    // inflow·(1−max)/max of the free envelope's dilution. With the owner's live SIPs (all
    // equity) the net capacity is small but positive; the book is sized so that 12 months
    // of it cannot close the drift, while 12 months of the envelope alone could — so the
    // answer is TRIM only if the SIP routes reached the engine.
    const book = await overweightEquityBook(10);
    await persistSipSnapshot(book, live, NOW);
    const env = await loadFreeEnvelope(book, NOW);
    const maxBp = BigInt(Math.round(IPS_BANDS.EQUITY.max * 10_000));
    const drag = (env.sipTotalPaise! * (10_000n - maxBp) + maxBp - 1n) / maxBp;
    const net = env.envelopePaise! - drag;
    const drift = 700_000_00n - (1_000_000_00n * maxBp) / 10_000n; // equity − max·NW
    expect(net > 0n).toBe(true); // the corrected model: equity takes < 60% of new money
    expect(drift > 12n * net).toBe(true);
    expect(drift <= 12n * env.envelopePaise!).toBe(true);
    const input = await buildReportInput(book, SEED_DATE, { now: NOW });
    const actions = proposed(input);
    expect(actions).toContain('TRIM');
    expect(actions).not.toContain('REDIRECT');
    await book.close();
  });

  it('a SIP is classed by its INDmoney category before its name: a money-market SIP dilutes equity', async () => {
    // The same live SIPs, but categorised Money Market. Their names read as EQUITY to
    // classify(), which would make them equity inflow and (as the test above shows) a TRIM.
    // As DEBT they are dilution on top of the envelope, so new money closes the gap.
    const book = await overweightEquityBook(10);
    const mm = live.map((r) => ({ ...r, fundType: null, category: 'Money Market' }));
    expect(mm.every((r) => classify('MF', r.instrumentId, r.fundName) === 'EQUITY')).toBe(true);
    await persistSipSnapshot(book, mm, NOW);
    const actions = proposed(await buildReportInput(book, SEED_DATE, { now: NOW }));
    expect(actions).toContain('REDIRECT');
    expect(actions).not.toContain('TRIM');
    await book.close();
  });

  it('a suppressed BUY does not also silence the redirect into that class', async () => {
    // GOLD 3% (under its 5% floor) and EQUITY 61% (1 point over 60%, inside SELL_TOLERANCE, so
    // a redirect even with no money): the engine wants a GOLD BUY and a redirect into GOLD.
    // With a known ₹0 envelope the BUY is suppressed, so the redirect is the only thing said
    // about GOLD and must be proposed. (Round 1 used an unknown envelope; that now holds the
    // whole rebalance, so the case lives on the known-₹0 path.)
    const book = await bookOf(61_000, 36_000, 3_000);
    await book.query(`insert into settings_rails (key, value) values ('monthly_budget_paise', '0'::jsonb)
                      on conflict (key) do update set value = excluded.value`);
    await persistSipSnapshot(book, [], NOW);
    expect((await loadFreeEnvelope(book, NOW)).envelopePaise).toBe(0n);
    const input = await buildReportInput(book, SEED_DATE, { now: NOW });
    expect(input.pipeline.suppressed.map((x) => x.action)).toContain('rebalance:BUY:GOLD');
    const redirects = [...input.pipeline.recommendations, ...input.pipeline.withheld]
      .filter((r) => r.primary.action === 'REDIRECT' && /GOLD/.test(r.intent));
    expect(redirects).toHaveLength(1);
    // No money this month: "put this month's tranche straight into X" has nothing to put.
    expect(redirects[0]!.alternates.filter((a) => a.action === 'BUY')).toEqual([]);
    await book.close();
  });

  it("a redirect's direct-buy alternate is this month's tranche, never the full drift", async () => {
    // The money-market case: the engine redirects new money (drift-sized) rather than selling.
    const book = await overweightEquityBook(10);
    await persistSipSnapshot(book, live.map((r) => ({ ...r, fundType: null, category: 'Money Market' })), NOW);
    const env = await loadFreeEnvelope(book, NOW);
    const maxOrder = await railPaise(book, 'max_order_paise');
    const tranche = env.remainingPaise! < maxOrder ? env.remainingPaise! : maxOrder;
    expect(tranche > 0n).toBe(true);
    const input = await buildReportInput(book, SEED_DATE, { now: NOW });
    const redirect = [...input.pipeline.recommendations, ...input.pipeline.withheld]
      .find((r) => r.primary.action === 'REDIRECT')!;
    expect(BigInt(redirect.primary.amountPaise!) > tranche).toBe(true); // premise: the drift exceeds one tranche
    const buys = redirect.alternates.filter((a) => a.action === 'BUY');
    expect(buys).toHaveLength(1);
    expect(BigInt(buys[0]!.amountPaise!)).toBe(tranche);
    await book.close();
  });

  describe('an unknown envelope leaves the month open for a retry (owner, 2026-10-15)', () => {
    // EQUITY 90% of ₹1Cr: ₹30L over, more than 12 months of any surplus can dilute, so a TRIM;
    // GOLD 3%, under its floor, so a BUY that the envelope decides.
    const book = () => bookOf(9_000_000, 700_000, 300_000);
    const rebalanceRows = async (b: Db) => (await b.query<{ primary_rec: string }>(
      `select primary_rec from recommendations where kind = 'rebalance' order by id`))
      .map((r) => JSON.parse(r.primary_rec) as { action: string; amountPaise: string; instrumentId: string | null });

    // A dated maturity goes out on every run, known envelope or not.
    const maturity = buildRecommendation({
      kind: 'maturity_routing', createdOn: SEED_DATE,
      primary: { intent: 'route the TESTBOND redemption', instrumentId: 'BOND:TESTBOND', action: 'REDEEM',
        amountPaise: '10000000', thesis: 'Matures this month.', ipsClauseRefs: ['3.8'], falsification: null },
    });
    const maturityCount = async (b: Db) => Number((await b.query<{ n: string }>(
      `select count(*) as n from recommendations where kind = 'maturity_routing'`))[0]!.n);

    it('run 1 without SIPs persists no rebalance action and leaves the month open; run 2 proposes the whole set once', async () => {
      const b = await book();
      await buildReportInput(b, SEED_DATE, { now: NOW, maturityRecommendations: [maturity] });
      expect(await monthlyReviewDone(b, 'recommendations', SEED_DATE.slice(0, 7))).toBe(false);
      expect(await rebalanceRows(b)).toEqual([]); // no TRIM, no REDIRECT, no BUY on unknown SIPs
      expect(await maturityCount(b)).toBe(1); // the maturity still went out

      await persistSipSnapshot(b, live, NOW);
      const env = await loadFreeEnvelope(b, NOW);
      await buildReportInput(b, SEED_DATE, { now: NOW, maturityRecommendations: [maturity] });
      expect(await monthlyReviewDone(b, 'recommendations', SEED_DATE.slice(0, 7))).toBe(true);
      // The retry re-sends the maturity; persistRecommendation's duplicate guard keeps one.
      expect(await maturityCount(b)).toBe(1);
      const run2 = await rebalanceRows(b);
      expect(run2.filter((r) => r.action === 'TRIM')).toHaveLength(1);
      const buys = run2.filter((r) => r.action === 'BUY');
      expect(buys).toHaveLength(1);
      expect(BigInt(buys[0]!.amountPaise)).toBe(env.envelopePaise!);
      await b.close();
    });

    it('a retry never leaves a redirect into GOLD beside a BUY of GOLD in the same month', async () => {
      // The book where the engine wants both a GOLD BUY and a redirect into GOLD. Run 1 used to
      // persist the redirect, and run 2 then added the BUY: the same money twice.
      const b = await bookOf(70_000, 27_000, 3_000);
      await buildReportInput(b, SEED_DATE, { now: NOW });
      expect(await rebalanceRows(b)).toEqual([]);
      await persistSipSnapshot(b, live, NOW);
      await buildReportInput(b, SEED_DATE, { now: NOW });
      const rows = (await b.query<{ intent: string; primary_rec: string }>(
        `select intent, primary_rec from recommendations where kind = 'rebalance'`))
        .map((r) => ({ intent: r.intent, action: (JSON.parse(r.primary_rec) as { action: string }).action }));
      expect(rows.some((r) => r.action === 'BUY' && /GOLD/.test(r.intent))).toBe(true);
      expect(rows.some((r) => r.action === 'REDIRECT' && /GOLD/.test(r.intent))).toBe(false);
      await b.close();
    });

    it('a known ₹0 envelope is an answer: the BUY is suppressed and the month is closed', async () => {
      const b = await book();
      await b.query(`insert into settings_rails (key, value) values ('monthly_budget_paise', '0'::jsonb)
                     on conflict (key) do update set value = excluded.value`);
      await persistSipSnapshot(b, [], NOW);
      expect((await loadFreeEnvelope(b, NOW)).envelopePaise).toBe(0n);
      const input = await buildReportInput(b, SEED_DATE, { now: NOW });
      expect(input.pipeline.suppressed.map((x) => x.action)).toContain('rebalance:BUY:GOLD');
      expect(await monthlyReviewDone(b, 'recommendations', SEED_DATE.slice(0, 7))).toBe(true);
      await b.close();
    });
  });

  it('a same-day re-run does not log the suppression twice, or fail on it', async () => {
    // A same-day row already exists, as after an earlier run today. With unknown SIPs the
    // month stays open (fix round 2), so both builds reach the insert of the one
    // `rebalance:ALL` row and must hit the (logged_on, action) key, not fail on it.
    await db.query(
      `insert into suppressed_actions (logged_on, action, reason, suppressed_by)
       values ($1, 'rebalance:ALL', 'earlier run', 'SIP_ENVELOPE')`, [SEED_DATE]);
    await build();
    await build();
    const [n] = await db.query<{ n: string }>(
      `select count(*) as n from suppressed_actions where suppressed_by = 'SIP_ENVELOPE'`);
    expect(Number(n!.n)).toBe(1);
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
