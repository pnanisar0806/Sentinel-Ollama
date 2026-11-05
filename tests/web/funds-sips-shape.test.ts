import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { parseMfSips } from '../../src/sources/indmoney.js';
import { istDate, istMonth, loadFreeEnvelope, persistSipSnapshot } from '../../src/domain/sips.js';
import { approveMix, proposeMix } from '../../src/domain/fund-mix.js';
import { logSipMove } from '../../src/domain/owner-log.js';
import { reverseEntry } from '../../src/domain/reversals.js';
import { persistMfMetadata } from '../../src/domain/mf-metadata.js';
import { db, getSipSuggestions } from '../../web/lib/data.js';

const live = parseMfSips({
  result: JSON.stringify(JSON.parse(await readFile('tests/fixtures/indmoney-mf-sips-2026-10-14.json', 'utf8')).payload),
});

/** Piece 3 Task 9: /funds "Suggested SIPs". One web `db()` singleton: the cases run in order. */
describe('getSipSuggestions', () => {
  beforeAll(async () => {
    await runMigrations(await db());
    await persistSipSnapshot(await db(), live, new Date(Date.now() - 8 * 86_400_000).toISOString());
  });

  it('no signed mix: no suggestions', async () => {
    expect(await getSipSuggestions()).toEqual({ rows: null, reason: 'approve the fund mix first' });
  });

  it('a stale SIP snapshot withholds the suggestion with the envelope reason, never zeros', async () => {
    const now = new Date().toISOString();
    const p = proposeMix(now);
    if (p.band === null) throw new Error('fixture expects a proposal');
    await approveMix(await db(), { band: p.band }, now);
    const reason = (await loadFreeEnvelope(await db(), now)).reason;
    expect(reason).toMatch(/older than 7 days/);
    expect(await getSipSuggestions()).toEqual({ rows: null, reason });
  });

  it('fresh SIPs: rows carry the live total; no SIP is suggested below its current amount (owner, 2026-10-28)', async () => {
    await persistSipSnapshot(await db(), live, new Date().toISOString());
    const r = await getSipSuggestions();
    if (r.rows === null) throw new Error(r.reason);
    const total = live.reduce((a, s) => a + s.amountPaise, 0n);
    expect(r.currentPaise).toBe(total);
    for (const s of r.rows) expect(s.suggestedPaise >= s.currentPaise).toBe(true);
    expect(r.rows.reduce((a, s) => a + s.currentPaise, 0n)).toBe(total);
  });

  // Fund switch §3: HDFC Mid Cap → Invesco India Mid Cap, logged on /log. The move's "to" is the
  // universe row MFU:*; the feed lists the same fund as IND:* — matched by ISIN, never raw id.
  const INVESCO = 'MFU:120505';
  const MID = 'Equity Scheme - Mid Cap Fund';
  const feedRow = (sipId: string, instrumentId: string, isin: string, fundName: string, amountPaise: bigint) =>
    ({ ...live[0]!, sipId, instrumentId, isin, fundName, amountPaise });
  // The stopped HDFC SIP still listed (feed lag), at the moved amount: it is not counted again.
  const hdfcSip = feedRow('HDFC-1', 'IND:3097', 'INF179K01XQ0', 'HDFC Mid Cap Opportunities Direct Growth', 300_100n);
  const liveTotal = live.reduce((a, s) => a + s.amountPaise, 0n);
  let moveId = '';

  it('a logged move with no Invesco SIP in the feed: a logged MID row for Invesco; the stale HDFC SIP is dropped, ₹3,001 counted once', async () => {
    const d = await db();
    const now = new Date().toISOString();
    await d.query(`insert into instruments (id, kind, name, currency, isin, metadata) values
      ('MF:HDFC-MIDCAP', 'MF', 'HDFC Mid Cap Opportunities Direct', 'INR', 'INF179K01XQ0', jsonb_build_object('amfiCategory', $1::text)),
      ($2, 'MF', 'Invesco India Mid Cap Fund', 'INR', 'INF205K01MN9', jsonb_build_object('category', $1::text)),
      ('MF:ICICI-N50', 'MF', 'ICICI Pru Nifty 50 Index Direct', 'INR', 'INF109K012M7', '{}')`, [MID, INVESCO]);
    const [snap] = await d.query<{ id: string }>(`insert into snapshots (business_date, source) values ($1::date, 'indmoney') returning id`, [istDate(now)]);
    await d.query(`insert into holdings (snapshot_id, instrument_id, account, quantity, value_paise, source, as_of)
      values ($1, 'MF:HDFC-MIDCAP', 'indmoney', 1, 2626900, 'indmoney', $2), ($1, 'MF:ICICI-N50', 'indmoney', 1, 68843200, 'indmoney', $2)`, [snap!.id, now]);
    // Mid cap is far under its midpoint, so a stale HDFC SIP not left would visibly take new money.
    moveId = (await logSipMove(d, { on: istDate(now), fromInstrumentId: 'MF:HDFC-MIDCAP', toInstrumentId: INVESCO,
      amountPaise: 300_100n, firstMonth: istMonth(now), note: '' }, now)).id;
    await persistSipSnapshot(d, [...live, hdfcSip], now);

    const r = await getSipSuggestions();
    if (r.rows === null) throw new Error(r.reason);
    expect(r.rows.filter((s) => s.fundName.includes('Invesco'))).toEqual([
      expect.objectContaining({ fundType: 'MID', instrumentId: INVESCO, currentPaise: 300_100n, logged: true }),
    ]);
    expect(r.rows.filter((s) => s.instrumentId === 'IND:3097' || s.instrumentId === 'MF:HDFC-MIDCAP' || s.fundName.includes('HDFC'))).toEqual([]);
    expect(r.currentPaise).toBe(liveTotal + 300_100n);
    expect(r.rows.reduce((a, s) => a + s.currentPaise, 0n)).toBe(r.currentPaise);
    for (const s of r.rows.filter((x) => !x.fundName.includes('Invesco'))) expect(s.logged).toBe(false);
  });

  it('once the feed carries the Invesco SIP: one Invesco row, not logged, at the feed amount', async () => {
    await persistSipSnapshot(await db(), [...live, hdfcSip, feedRow('INV-1', 'IND:9999', 'INF205K01MN9', 'Invesco India Midcap Direct Growth', 350_000n)], new Date().toISOString());
    const r = await getSipSuggestions();
    if (r.rows === null) throw new Error(r.reason);
    expect(r.rows.filter((s) => s.fundName.includes('Invesco'))).toEqual([
      expect.objectContaining({ fundType: 'MID', instrumentId: 'IND:9999', currentPaise: 350_000n, logged: false }),
    ]);
    expect(r.rows.filter((s) => s.fundName.includes('HDFC'))).toEqual([]);
    expect(r.currentPaise).toBe(liveTotal + 350_000n);
  });

  it('after the move is reversed: no logged Invesco row', async () => {
    const d = await db();
    const now = new Date().toISOString();
    await persistSipSnapshot(d, live, now);
    await reverseEntry(d, { entity: 'sip_move', entityId: moveId, reason: 'test' }, now);
    const r = await getSipSuggestions();
    if (r.rows === null) throw new Error(r.reason);
    expect(r.rows.filter((s) => s.logged || s.fundName.includes('Invesco'))).toEqual([]);
  });

  // Fund switch §4.4: ICICI Nifty 50 at 0.20% against a 0.09% same-index peer clears the 0.10-point
  // bar. The card must not send it new money (nor the ₹100 remainder); the type's money names the peer.
  it('an index fund the switch check says to leave gets no new money; the Nifty 50 money names the peer', async () => {
    const d = await db();
    const now = new Date().toISOString();
    await persistMfMetadata(d, [{ instrumentId: 'MF:ICICI-N50', asOf: now.slice(0, 10), expenseRatioBps: 20, aumPaise: null, category: null, benchmarkName: null }]);
    await d.query(
      `insert into index_fund_candidates (fund_type, indmoney_fund_id, name, benchmark_name, amfi_scheme_code,
         expense_ratio_bps, aum_paise, sip_allowed, as_of, source)
       values ('NIFTY50', '1039539', 'Navi Nifty 50 Index Fund', 'Nifty 50 TR INR', '149999', 9, 1000000000000, true, $1, 'indmoney-mcp')`,
      [now.slice(0, 10)]);
    const r = await getSipSuggestions();
    if (r.rows === null) throw new Error(r.reason);
    const icici = r.rows.filter((s) => s.fundName.includes('ICICI'));
    expect(icici.length).toBe(1);
    expect(icici[0]!.suggestedPaise).toBe(icici[0]!.currentPaise);
    expect(icici[0]!.reason).not.toMatch(/remainder/);
    const navi = r.rows.filter((s) => s.fundName === 'Navi Nifty 50 Index Fund');
    expect(navi).toEqual([expect.objectContaining({ fundType: 'NIFTY50', instrumentId: null, currentPaise: 0n })]);
    expect(navi[0]!.suggestedPaise > 0n).toBe(true);
  });
});
