import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { loadPositions } from '../../src/domain/networth.js';
import { IPS_V1_TEXT, getIpsClauseIndex } from '../../src/domain/ips.js';
import { evaluateExits } from '../../src/domain/sell-triggers.js';
import type { Redemption } from '../../src/domain/redemptions.js';
import {
  INDEX_ROUTE_INSTRUMENT,
  MAX_RECS_PER_MONTH,
  MAX_THESIS_WORDS,
  MIN_HOLD_MONTHS,
  OVERRIDE_EVENTS,
  announceMaturity,
  buildRecommendation,
  gateRecommendation,
  isPaperMode,
  persistRecommendation,
  scanForExecutionPaths,
  thesisWordCount,
  validateRecommendation,
  type RecLeg,
} from '../../src/domain/recommendations.js';

const SEED_DATE = '2026-08-12';
let db: Db;

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: SEED_DATE });
});

const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

function leg(over: Partial<RecLeg> = {}): RecLeg {
  return {
    intent: 'add satellite exposure',
    instrumentId: 'NSE:RPOWER',
    action: 'BUY',
    amountPaise: '5000000',
    thesis: 'A short, testable thesis.',
    ipsClauseRefs: ['3.4'],
    falsification: null,
    ...over,
  };
}

describe('FR-11 contract', () => {
  it('fills A1 with the index route and A2 with do-nothing when the engine offers neither', () => {
    const rec = buildRecommendation({ kind: 'satellite', createdOn: SEED_DATE, primary: leg() });

    expect(rec.alternates).toHaveLength(2);
    const [a1, a2] = rec.alternates;
    expect(a1.intent).toBe(rec.primary.intent);
    expect(a1.instrumentId).toBe(INDEX_ROUTE_INSTRUMENT);
    expect(a2.intent).not.toBe(rec.primary.intent);
    expect(a2.action).toBe('HOLD');
    expect(validateRecommendation(rec)).toEqual([]);
  });

  it('prefers a real same-intent challenger over the index fallback', () => {
    const challenger = leg({ instrumentId: 'NSE:TCS', thesis: 'Challenger thesis.' });
    const rec = buildRecommendation({
      kind: 'satellite',
      createdOn: SEED_DATE,
      primary: leg(),
      sameIntentAlternates: [challenger],
    });
    expect(rec.alternates[0].instrumentId).toBe('NSE:TCS');
  });

  it('accepts a thesis at the word limit and rejects one word more', () => {
    const atLimit = buildRecommendation({
      kind: 'satellite',
      createdOn: SEED_DATE,
      primary: leg({ thesis: words(MAX_THESIS_WORDS) }),
    });
    expect(thesisWordCount(atLimit.primary.thesis)).toBe(MAX_THESIS_WORDS);
    expect(validateRecommendation(atLimit)).toEqual([]);

    expect(() =>
      buildRecommendation({
        kind: 'satellite',
        createdOn: SEED_DATE,
        primary: leg({ thesis: words(MAX_THESIS_WORDS + 1) }),
      }),
    ).toThrow(new RegExp(`${MAX_THESIS_WORDS + 1} words`));
  });

  it('rejects an object missing an alternate', () => {
    const rec = buildRecommendation({ kind: 'satellite', createdOn: SEED_DATE, primary: leg() });
    const missing = { ...rec, alternates: [rec.alternates[0]] as unknown as typeof rec.alternates };
    expect(validateRecommendation(missing).join(' ')).toMatch(/exactly 2 alternates/);
  });

  it('rejects an A1 that repeats the primary instrument, or an A2 that repeats its intent', () => {
    expect(() =>
      buildRecommendation({
        kind: 'satellite',
        createdOn: SEED_DATE,
        primary: leg(),
        sameIntentAlternates: [leg()],
      }),
    ).toThrow(/different instrument/);

    expect(() =>
      buildRecommendation({
        kind: 'satellite',
        createdOn: SEED_DATE,
        primary: leg(),
        differentIntent: leg({ instrumentId: 'NSE:TCS' }),
      }),
    ).toThrow(/different intent/);
  });

  it('rejects a citation that does not exist in the rendered IPS', () => {
    expect(() =>
      buildRecommendation({
        kind: 'satellite',
        createdOn: SEED_DATE,
        primary: leg({ ipsClauseRefs: ['9.9'] }),
      }),
    ).toThrow(/9\.9 does not exist/);
  });

  it('cites only clauses the IPS actually contains, checked against the rendered index', () => {
    const valid = new Set(getIpsClauseIndex(IPS_V1_TEXT).map((c) => c.id));
    expect(valid.size).toBeGreaterThan(0);
    const rec = buildRecommendation({ kind: 'satellite', createdOn: SEED_DATE, primary: leg() });
    for (const l of [rec.primary, ...rec.alternates]) {
      for (const ref of l.ipsClauseRefs) expect(valid).toContain(ref);
    }
  });
});

describe('FR-12 caps', () => {
  const rec = (over: Partial<RecLeg> = {}, createdOn = SEED_DATE) =>
    buildRecommendation({ kind: 'satellite', createdOn, primary: leg(over) });

  it('suppresses the fifth recommendation of a calendar month with a visible reason', async () => {
    for (let i = 0; i < MAX_RECS_PER_MONTH; i++) {
      const r = await persistRecommendation(db, rec({ instrumentId: `NSE:N${i}` }, `2026-08-0${i + 1}`));
      expect(r.suppressed).toBe(false);
    }

    const fifth = await persistRecommendation(db, rec({ instrumentId: 'NSE:FIFTH' }, '2026-08-20'));
    expect(fifth.suppressed).toBe(true);
    expect(fifth.id).toBeNull();
    expect(fifth.reason).toContain(String(MAX_RECS_PER_MONTH));

    const [logged] = await db.query<{ action: string; reason: string; suppressed_by: string }>(
      `select action, reason, suppressed_by from suppressed_actions`,
    );
    expect(logged!.action).toContain('NSE:FIFTH');
    expect(logged!.reason).toBe(fifth.reason);
    expect(logged!.suppressed_by).toBe('FR-12');
  });

  it('stores a proposal once per month, however many times the report runs', async () => {
    // The 2026-09-20 weekly report ran twice and stored both recommendations twice, which
    // doubled the page and spent the month's FR-12 cap on copies.
    const r = () => buildRecommendation({
      kind: 'rebalance', createdOn: '2026-09-20',
      primary: leg({ intent: 'restore GOLD toward its IPS band', instrumentId: 'NSE:GOLDBEES' }),
    });
    const first = await persistRecommendation(db, r());
    const again = await persistRecommendation(db, r());
    expect(again.id).toBe(first.id);
    expect(again.suppressed).toBe(false);
    expect(again.duplicate).toBe(true);
    const [row] = await db.query<{ n: string }>(`select count(*) as n from recommendations`);
    expect(Number(row!.n)).toBe(1);
  });

  it('does not count a maturity routing toward the monthly cap', async () => {
    // Owner decision 2026-09-26: a maturity is a dated event with pre-approved routing
    // (IPS §3.9), not a new idea, so it must not crowd out a real proposal.
    const routing = await persistRecommendation(db, buildRecommendation({
      kind: 'maturity_routing', createdOn: '2026-08-01',
      primary: leg({ intent: 'route the redemption', instrumentId: 'BOND:SAMMAAN-2026', action: 'REDEEM' }),
    }));
    expect(routing.suppressed).toBe(false);
    for (let i = 0; i < MAX_RECS_PER_MONTH; i++) {
      const r = await persistRecommendation(db, rec({ instrumentId: `NSE:N${i}` }, `2026-08-0${i + 2}`));
      expect(r.suppressed).toBe(false);
    }
    // And a maturity is never refused by the cap either.
    const late = await persistRecommendation(db, buildRecommendation({
      kind: 'maturity_routing', createdOn: '2026-08-20',
      primary: leg({ intent: 'route another redemption', instrumentId: 'BOND:EDELWEISS-2033', action: 'REDEEM' }),
    }));
    expect(late.suppressed).toBe(false);
  });

  it('counts the cap per calendar month, so the next month starts clean', async () => {
    for (let i = 0; i < MAX_RECS_PER_MONTH; i++) {
      await persistRecommendation(db, rec({ instrumentId: `NSE:N${i}` }, `2026-08-0${i + 1}`));
    }
    const september = await persistRecommendation(db, rec({ instrumentId: 'NSE:SEPT' }, '2026-09-02'));
    expect(september.suppressed).toBe(false);
  });

  it('blocks a repeat BUY inside the hold, and lets an override event through', async () => {
    const first = await persistRecommendation(db, rec({}, '2026-08-01'));
    expect(first.suppressed).toBe(false);

    // Derived from the stored recommendation's own date, not a restated literal.
    const [stored] = await db.query<{ created_on: string | Date }>(
      `select created_on from recommendations where id = $1`,
      [first.id],
    );
    const priorIso =
      stored!.created_on instanceof Date
        ? stored!.created_on.toISOString().slice(0, 10)
        : String(stored!.created_on).slice(0, 10);
    // Half the hold later — derived from the stored date so the arithmetic follows it.
    const prior = new Date(`${priorIso}T00:00:00Z`);
    prior.setUTCMonth(prior.getUTCMonth() + MIN_HOLD_MONTHS / 2);
    const insideHold = prior.toISOString().slice(0, 10);

    const blocked = await gateRecommendation(db, rec({}, insideHold));
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain(priorIso);
    expect(blocked.reason).toContain(String(MIN_HOLD_MONTHS));

    const overridden = await gateRecommendation(db, rec({}, insideHold), { override: 'owner-directive' });
    expect(overridden.allowed).toBe(true);
  });

  it('takes only the three listed override events', async () => {
    await persistRecommendation(db, rec({}, '2026-08-01'));
    for (const ev of OVERRIDE_EVENTS) {
      expect((await gateRecommendation(db, rec({}, '2026-09-01'), { override: ev })).allowed).toBe(true);
    }
    const bogus = await gateRecommendation(db, rec({}, '2026-09-01'), {
      override: 'because-i-feel-lucky' as (typeof OVERRIDE_EVENTS)[number],
    });
    expect(bogus.allowed).toBe(false);
    expect(bogus.reason).toMatch(/not an override event/);
  });

  it('lets the same name through once the hold has elapsed', async () => {
    await persistRecommendation(db, rec({}, '2025-01-15'));
    const later = await gateRecommendation(db, rec({}, '2026-02-15'));
    expect(later.allowed).toBe(true);
  });
});

describe('FR-55 paper mode', () => {
  it('defaults to paper when the rail is absent, and reads the rail when set', async () => {
    expect(await isPaperMode(db)).toBe(true);
    await db.query(`insert into settings_rails (key, value) values ('paper_mode', 'false'::jsonb)`);
    expect(await isPaperMode(db)).toBe(false);
  });

  it('carries the paper flag into what is stored', async () => {
    const rec = buildRecommendation({ kind: 'satellite', createdOn: SEED_DATE, primary: leg() });
    expect(rec.paperMode).toBe(true);
    const { id } = await persistRecommendation(db, rec);
    const [row] = await db.query<{ engine_evidence: string }>(
      `select engine_evidence from recommendations where id = $1`,
      [id],
    );
    expect(JSON.parse(row!.engine_evidence).paperMode).toBe(true);
  });

  it('finds no order-placing call anywhere in the domain or job layers', () => {
    expect(scanForExecutionPaths('src/domain')).toEqual([]);
    expect(scanForExecutionPaths('src/jobs')).toEqual([]);
  });
});

describe('the stored recommendation is live, not decorative', () => {
  it('round-trips a falsification condition that sell-triggers then fires on', async () => {
    const floor = 20_000n;
    const rec = buildRecommendation({
      kind: 'satellite',
      createdOn: SEED_DATE,
      primary: leg({
        falsification: { metric: 'price_paise', op: 'lt', value: floor.toString() },
      }),
    });
    const { id, suppressed } = await persistRecommendation(db, rec);
    expect(suppressed).toBe(false);
    expect(id).not.toBeNull();

    await db.query(
      `insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of)
       values ('NSE:RPOWER', $1, $2, 'nse-bhavcopy', $3)`,
      [SEED_DATE, (floor - 1n).toString(), `${SEED_DATE}T18:00:00Z`],
    );

    const exits = await evaluateExits(
      db,
      { positions: await loadPositions(db), blockedIds: [] },
      '2026-08',
    );
    const fired = exits.find((c) => c.trigger === 'falsification')!;
    expect(fired, 'Task 9 must be able to read what Task 10 writes').toBeDefined();
    expect(fired.instrumentId).toBe('NSE:RPOWER');
  });
});

describe('announceMaturity', () => {
  const redemption: Redemption = {
    instrumentId: 'NSE:SAMMAAN',
    symbol: 'Sammaan Capital Limited',
    isin: 'INE148I07GL3',
    maturityDate: '2026-09-26',
    facePaise: 30_000_000n as Redemption['facePaise'],
    couponDuePaise: 2_700_000n as Redemption['couponDuePaise'],
    daysUntil: 14,
  };

  it('builds a valid maturity_routing recommendation from a routing decision', () => {
    const rec = announceMaturity(
      redemption,
      { bucket: 'B3', thesis: 'Proceeds route to B3 per IPS 3.9.', ipsClauseRefs: ['3.3', '3.9'], note: 'B3 target noted.' },
      '2026-09-12',
    );
    expect(rec.kind).toBe('maturity_routing');
    expect(validateRecommendation(rec)).toEqual([]);
    // Face plus the final coupon, as an exact decimal string — never a float.
    expect(rec.primary.amountPaise).toBe(
      (redemption.facePaise + redemption.couponDuePaise!).toString(),
    );
    expect(rec.alternates[1].action).toBe('HOLD');
  });
});
