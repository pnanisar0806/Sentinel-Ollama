import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import type { SwitchCandidate } from '../../src/domain/mf-switch.js';
import { persistMfMetadata } from '../../src/domain/mf-metadata.js';

/**
 * Piece 3 Task 7 (Decisions 7–9): which held funds may take this month's money. Only a fund
 * of a type below its signed midpoint, that takes new money, is topped up, and — if active —
 * sits in the top half of its category with no switch pending.
 */
const switches: SwitchCandidate[] = [];
vi.mock('../../src/domain/mf-switch.js', () => ({ evaluateSwitches: vi.fn(async () => switches) }));

const { RANGE_TABLE, approveMix, loadFundCandidates, midBps } = await import('../../src/domain/fund-mix.js');

const MID = 'Equity Scheme - Mid Cap Fund';
const NOW = '2026-10-26T10:00:00+05:30';
const AS_OF = '2026-10-26';

/** One snapshot, total equity funds ₹10L, so every rupee figure below is also its share. */
const FUNDS = [
  { id: 'MF:IDX', kind: 'MF', name: 'ICICI Pru Nifty 50 Index Direct', isin: 'INF109K012M7', rupees: 300_000 },   // NIFTY50 30%
  { id: 'MF:PPFC', kind: 'MF', name: 'Parag Parikh Flexi Cap Direct', isin: 'INF879O01027', rupees: 250_000 },     // FLEXI 25%
  { id: 'MF:ICICI-LC', kind: 'MF', name: 'ICICI Pru Large Cap Direct', isin: 'INF109K016L0', rupees: 200_000 },    // LARGE_ACTIVE
  { id: 'MF:HDFC-MID', kind: 'MF', name: 'HDFC Mid Cap Direct', isin: 'INF179K01XQ0', rupees: 100_000 },           // MID 13%
  { id: 'MF:MOSL-MID', kind: 'MF', name: 'Motilal Oswal Midcap Direct', isin: 'INF247L01445', rupees: 30_000 },
  { id: 'MF:BANDHAN', kind: 'MF', name: 'Bandhan Small Cap Direct', isin: 'INF194KB1AL4', rupees: 50_000 },        // SMALL 5%
  { id: 'NSE:JUNIORBEES', kind: 'ETF', name: 'Nippon Junior BeES', isin: 'INF732E01045', rupees: 20_000 },         // NEXT50 2%
  { id: 'IND:MYSTERY', kind: 'MF', name: 'Mystery Equity Fund', isin: null, rupees: 50_000 },                      // untyped
] as const;
const TOTAL = FUNDS.reduce((s, f) => s + f.rupees, 0);
const shareBps = (...ids: string[]) => Math.floor(FUNDS.filter((f) => ids.includes(f.id)).reduce((s, f) => s + f.rupees, 0) * 10_000 / TOTAL);
const mid = (t: string) => midBps(RANGE_TABLE['15+'].find((r) => r.type === t)!);

const sw = (id: string, rank: number, cohortSize: number, challenger: string | null = null): SwitchCandidate => ({
  heldInstrumentId: id, heldName: id, heldComposite: 50, heldRank: rank, category: MID, cohortSize,
  challengerId: challenger === null ? null : 'MFU:BETTER', challengerName: challenger, challengerComposite: null, edge: null, reason: '',
});

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  const [snap] = await db.query<{ id: string }>(`insert into snapshots (business_date, source) values (date '2026-10-20', 'indmoney') returning id`);
  for (const f of FUNDS) {
    await db.query(`insert into instruments (id, kind, name, currency, isin) values ($1, $2, $3, 'INR', $4)`, [f.id, f.kind, f.name, f.isin]);
    await db.query(
      `insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
       values ($1, $2, 'indmoney', 1, $3, 'indmoney', timestamptz '2026-10-20T12:00:00Z')`,
      [snap!.id, f.id, BigInt(f.rupees) * 100n],
    );
  }
  switches.length = 0;
  switches.push(
    sw('MF:HDFC-MID', 2, 10),
    sw('MF:MOSL-MID', 1, 10, 'Better Mid Cap Fund'),
    sw('MF:BANDHAN', 7, 10),
    sw('MF:IDX', 9, 10), // an index fund ranked low is still a candidate
  );
});

describe('loadFundCandidates', () => {
  it('no signed mix: not approved and nothing to buy', async () => {
    const r = await loadFundCandidates(db, AS_OF);
    expect(r.approved).toBe(false);
    expect(r.buys).toEqual([]);
  });

  it('a signed 15+ mix: below-midpoint, top-uppable, top-half funds only', async () => {
    await approveMix(db, { band: '15+' }, NOW);
    const r = await loadFundCandidates(db, AS_OF);
    expect(r.approved).toBe(true);

    expect(r.buys).toEqual([
      { instrumentId: 'MF:IDX', name: 'ICICI Pru Nifty 50 Index Direct', kind: 'MF', fundType: 'NIFTY50',
        gapBps: mid('NIFTY50') - shareBps('MF:IDX'), actualBps: shareBps('MF:IDX'), midBps: mid('NIFTY50'), minBps: 3500, maxBps: 5000,
        heldPaise: 30_000_000n, quality: 'index fund — exempt' },
      { instrumentId: 'MF:HDFC-MID', name: 'HDFC Mid Cap Direct', kind: 'MF', fundType: 'MID',
        gapBps: mid('MID') - shareBps('MF:HDFC-MID', 'MF:MOSL-MID'), actualBps: shareBps('MF:HDFC-MID', 'MF:MOSL-MID'), midBps: mid('MID'), minBps: 1000, maxBps: 2000,
        heldPaise: 10_000_000n, quality: `rank 2 of 11 in ${MID}` },
    ]);

    const why = Object.fromEntries(r.excluded.map((e) => [e.instrumentId, e.reason]));
    expect(why).toEqual({
      'MF:PPFC': `at or above midpoint (${shareBps('MF:PPFC') / 100}% vs ${mid('FLEXI') / 100}%)`,
      'MF:ICICI-LC': '0% new money',
      'MF:MOSL-MID': 'flagged for a switch to Better Mid Cap Fund',
      'MF:BANDHAN': 'rank 7 of 11 — not in the top half',
      'NSE:JUNIORBEES': 'kept, not topped up',
      'IND:MYSTERY': 'type unknown',
    });

    // Every new-money type under its midpoint, including US with no holding at all.
    expect(r.typesBelowMidpoint).toEqual(['NIFTY50', 'NEXT50', 'MID', 'SMALL', 'US']);
  });

  it('an active fund with no category cohort is not a candidate', async () => {
    await approveMix(db, { band: '15+' }, NOW);
    switches.splice(0, 1, sw('MF:HDFC-MID', 1, 0));
    const r = await loadFundCandidates(db, AS_OF);
    expect(r.excluded.find((e) => e.instrumentId === 'MF:HDFC-MID')?.reason).toBe('no category cohort on record');
    expect(r.buys.map((b) => b.instrumentId)).toEqual(['MF:IDX']);
  });

  it('rank 6 of 11 is the top half: ceil((cohortSize + 1) / 2)', async () => {
    await approveMix(db, { band: '15+' }, NOW);
    switches.splice(2, 1, sw('MF:BANDHAN', 6, 10));
    const r = await loadFundCandidates(db, AS_OF);
    expect(r.buys.find((b) => b.instrumentId === 'MF:BANDHAN')?.quality).toBe(`rank 6 of 11 in ${MID}`);
  });

  it('a fund recommended last month is still a candidate: fund top-ups are exempt from the FR-12 hold (owner, 2026-10-27)', async () => {
    await approveMix(db, { band: '15+' }, NOW);
    await db.query(
      `insert into recommendations (created_on, kind, intent, primary_rec, alternates, ips_clause_refs, engine_evidence, source)
       values ('2026-09-26', 'rebalance', 'top up', $1, '[]', '[]', '{}', 'advisor')`,
      [JSON.stringify({ intent: 'top up', instrumentId: 'MF:IDX', action: 'BUY', amountPaise: '100', thesis: 't', ipsClauseRefs: ['3.4'], falsification: null })]);
    const r = await loadFundCandidates(db, AS_OF);
    expect(r.excluded.map((e) => e.instrumentId)).not.toContain('MF:IDX');
    expect(r.buys[0]!.instrumentId).toBe('MF:IDX');
  });

  // Fund switch §4.4: the index switch check's verdict reaches the advisor too.
  it('an index fund whose same-index peer clears the 0.10-point bar is excluded, naming the peer', async () => {
    await approveMix(db, { band: '15+' }, NOW);
    await persistMfMetadata(db, [{ instrumentId: 'MF:IDX', asOf: AS_OF, expenseRatioBps: 20, aumPaise: null, category: null, benchmarkName: null }]);
    await db.query(
      `insert into index_fund_candidates (fund_type, indmoney_fund_id, name, benchmark_name, amfi_scheme_code,
         expense_ratio_bps, aum_paise, sip_allowed, as_of, source)
       values ('NIFTY50', '1039539', 'Navi Nifty 50 Index Fund', 'Nifty 50 TR INR', '149999', 9, 1000000000000, true, $1, 'indmoney-mcp')`,
      [AS_OF]);
    const r = await loadFundCandidates(db, AS_OF);
    expect(r.excluded.find((e) => e.instrumentId === 'MF:IDX')?.reason).toBe('flagged for a switch to Navi Nifty 50 Index Fund');
    expect(r.buys.map((b) => b.instrumentId)).not.toContain('MF:IDX');
  });

  // Fund switch §3: a fund whose SIP the owner moved takes no new money from the advisor.
  const moveFrom = async (fromId: string) => {
    await db.query(`insert into instruments (id, kind, name, currency, isin) values ('MFU:120505', 'MF', 'Invesco India Mid Cap Fund', 'INR', 'INF205K01MN9')`);
    await db.query(`insert into sip_moves (from_instrument_id, to_instrument_id, amount_paise, first_month, occurred_on, as_of, source)
      values ($1, 'MFU:120505', 300100, '2026-11', '2026-10-18', '2026-10-18T06:00:00Z', 'owner-web')`, [fromId]);
  };

  it('a fund whose SIP was moved is excluded: SIP moved to <to>', async () => {
    await approveMix(db, { band: '15+' }, NOW);
    await moveFrom('MF:HDFC-MID');
    const r = await loadFundCandidates(db, AS_OF);
    expect(r.excluded.find((e) => e.instrumentId === 'MF:HDFC-MID')?.reason).toBe('SIP moved to Invesco India Mid Cap Fund');
    expect(r.buys.map((b) => b.instrumentId)).toEqual(['MF:IDX']);
  });

  it('a move from an ISIN alias of the holding excludes it too, not only the raw id', async () => {
    await approveMix(db, { band: '15+' }, NOW);
    await db.query(`insert into instruments (id, kind, name, currency, isin) values ('IND:3097', 'MF', 'HDFC Mid Cap (INDmoney)', 'INR', 'INF179K01XQ0')`);
    await moveFrom('IND:3097');
    const r = await loadFundCandidates(db, AS_OF);
    expect(r.excluded.find((e) => e.instrumentId === 'MF:HDFC-MID')?.reason).toBe('SIP moved to Invesco India Mid Cap Fund');
  });
});
