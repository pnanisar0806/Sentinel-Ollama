import { describe, expect, it } from 'vitest';
import { cagrPct, MF_WEIGHTS, rankMfs, RETURN_SPREAD_PP, type MfCandidate } from '../../src/domain/engine.js';

/**
 * Until 2026-09-22 nothing in the hundred points rewarded the SIZE of a return.
 * `consistency` counts the share of rolling windows that gained, so a fund up 0.1% a
 * month scored exactly as one up 2% — the model could not separate a steady laggard
 * from a steady compounder. Owner asked for the metric.
 */

/** A monthly series compounding at `pct` for `months`. */
const series = (pct: number, months = 30): bigint[] => {
  const out: bigint[] = [];
  let nav = 100_000_000;
  for (let m = 0; m < months; m++) { out.push(BigInt(Math.round(nav))); nav *= 1 + pct / 100; }
  return out;
};

const mf = (id: string, navMicros: bigint[]): MfCandidate => ({
  instrumentId: id, navMicros, expenseRatioBps: null, aumPaise: null,
  tenureMonths: null, styleDriftPct: null,
});

const ctx = { scoreDate: '2026-09-22', blockedIds: [] as string[], rollingWindow: 12 };

describe('cagrPct', () => {
  it('annualises a month-end series', () => {
    // 1%/month over 29 intervals is ~12.7% a year.
    const v = cagrPct(series(1.0));
    expect(v).toBeGreaterThan(12);
    expect(v).toBeLessThan(13.5);
  });

  it('is NULL below a year, not 0', () => {
    // Zero would rank a six-month-old fund beside one that genuinely went nowhere.
    expect(cagrPct(series(1.0, 12))).toBeNull();
    expect(cagrPct([])).toBeNull();
  });

  it('reads a fall as negative', () => {
    expect(cagrPct(series(-0.5))).toBeLessThan(0);
  });
});

describe('the returns component', () => {
  it('separates two funds that consistency scores identically', () => {
    // Both gain every single month, so both take full marks on consistency. Before
    // `returns` existed these two were indistinguishable.
    const [slow, fast] = rankMfs(
      [mf('MF:SLOW', series(0.1)), mf('MF:FAST', series(2.0))], ctx,
    ).sort((a, b) => a.instrumentId.localeCompare(b.instrumentId)).reverse();
    expect(slow!.instrumentId).toBe('MF:SLOW');
    expect(fast!.instrumentId).toBe('MF:FAST');
    expect(slow!.components.consistency).toBe(fast!.components.consistency);
    expect(fast!.components.returns).toBeGreaterThan(slow!.components.returns);
    expect(fast!.composite).toBeGreaterThan(slow!.composite);
  });

  it('scores against the cohort median, not an absolute bar', () => {
    // The SAME fund, in two cohorts. A small-cap median and a large-cap median are
    // different numbers in the same year; an absolute bar would rank whole categories
    // against each other by accident.
    const subject = mf('MF:SUBJECT', series(1.0));
    const weak = rankMfs([subject, mf('A', series(0.2)), mf('B', series(0.3))], ctx)
      .find((r) => r.instrumentId === 'MF:SUBJECT')!;
    const strong = rankMfs([subject, mf('A', series(2.0)), mf('B', series(2.2))], ctx)
      .find((r) => r.instrumentId === 'MF:SUBJECT')!;
    expect(weak.components.returns).toBeGreaterThan(strong.components.returns);
  });

  it('gives the median fund half the weight', () => {
    const ranked = rankMfs(
      [mf('LOW', series(0.2)), mf('MID', series(1.0)), mf('HIGH', series(1.8))], ctx,
    );
    const mid = ranked.find((r) => r.instrumentId === 'MID')!;
    // At the median the ramp sits exactly halfway between its bounds.
    expect(mid.components.returns).toBeCloseTo(MF_WEIGHTS.returns / 2, 1);
  });

  it('caps at the spread rather than rewarding an outlier without limit', () => {
    const ranked = rankMfs(
      [mf('MAD', series(20)), mf('A', series(0.5)), mf('B', series(0.6))], ctx,
    );
    const mad = ranked.find((r) => r.instrumentId === 'MAD')!;
    // A fund 10x past the band scores the same as one just outside it: the metric is
    // "clearly ahead of the cohort", not "how far ahead".
    expect(mad.components.returns).toBe(MF_WEIGHTS.returns);
    expect(mad.cagrPct!).toBeGreaterThan(RETURN_SPREAD_PP);
  });

  it('scores 0 without enough history, and says so on the row', () => {
    const ranked = rankMfs(
      [mf('YOUNG', series(1.0, 6)), mf('A', series(1.0)), mf('B', series(1.1))], ctx,
    );
    const young = ranked.find((r) => r.instrumentId === 'YOUNG')!;
    expect(young.components.returns).toBe(0);
    // NULL distinguishes "no history" from "returned nothing".
    expect(young.cagrPct).toBeNull();
  });

  it('is 0 for everyone when no fund has a year of history', () => {
    const ranked = rankMfs([mf('A', series(1, 6)), mf('B', series(2, 6))], ctx);
    for (const r of ranked) expect(r.components.returns).toBe(0);
  });
});
