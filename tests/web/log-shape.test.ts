import { beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { BUCKETS } from '../../src/domain/buckets.js';
import { rupees } from '../../src/money/paise.js';
import { logEarmark, logGoalMove, logNote, logSipMove } from '../../src/domain/owner-log.js';
import { reverseEntry } from '../../src/domain/reversals.js';
import { db, getLog, getSipMoveOptions } from '../../web/lib/data.js';
import { balanceText } from '../../web/lib/goals.js';
import { canReverse, plannedSpendingLine } from '../../web/lib/log.js';

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** One web `db()` singleton per file: the /log getter over a manual-seed snapshot. */
describe('/log getter', () => {
  let snap: string;
  beforeAll(async () => {
    const d = await db();
    await runMigrations(d);
    for (const b of Object.values(BUCKETS)) {
      await d.query(`insert into buckets (id, name, mandate, target_paise, target_note) values ($1,$2,$3,$4,$5) on conflict do nothing`,
        [b.id, b.name, b.mandate, b.targetPaise?.toString() ?? null, b.targetNote]);
    }
    [{ id: snap }] = await d.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ($1, 'manual-seed') returning id::text`, [day(-1)]) as [{ id: string }];
    for (const [id, kind, qty, value] of [['NSE:EQ', 'EQUITY', '10', rupees(100_000)], ['MF:F', 'MF', '5', rupees(50_000)],
      ['US:NOW', 'RSU', '78', rupees(1_072_974)], ['BOND:X', 'BOND', '1', rupees(300_000)]] as const) {
      await d.query(`insert into instruments (id, kind, name, currency) values ($1,$2,$1,'INR') on conflict do nothing`, [id, kind]);
      await d.query(`insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
                     values ($1,$2,$3,$4,'x',now(),'manual-seed')`, [snap, id, qty, value.toString()]);
    }
  });

  it('with no bank balance known, idle cash is null and renders "unknown", never ₹0', async () => {
    const log = await getLog();
    expect(log.idleBankCashPaise).toBeNull();
    expect(balanceText({ balancePaise: log.idleBankCashPaise })).toBe('unknown');
    expect(log.spLabels).toEqual([]);
    expect(plannedSpendingLine(log.spLabels)).toBeNull();
  });

  it('offers sellable holdings (no bonds, no cash), open SP labels, pot balances and reversal flags', async () => {
    const d = await db();
    await d.query(`insert into instruments (id, kind, name, currency) values ('CASH:X', 'CASH', 'Bank', 'INR')`);
    await d.query(`insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
                   values ($1, 'CASH:X', '1', $2, 'x', now(), 'manual-seed')`, [snap, rupees(900_000).toString()]);
    await logGoalMove(d, { bucketId: 'B2', occurredOn: day(-1), amountPaise: rupees(100_000), kind: 'sip', note: 'typo' });
    await logEarmark(d, { on: day(-1), from: 'FI', to: 'SP', amountPaise: rupees(250_000), label: 'Himachal trip', note: '', fiCorpusPaise: 10n ** 12n });
    await logNote(d, { on: day(-1), text: 'hello' });
    const [flow] = await d.query<{ id: string }>(`select id::text from bucket_flows where bucket_id = 'B2'`);
    await reverseEntry(d, { entity: 'bucket_flow', entityId: flow!.id, reason: 'entered twice' }, new Date().toISOString());

    const log = await getLog();
    expect(log.sellable).toEqual([
      { id: 'MF:F', name: 'MF:F', kind: 'MF' }, { id: 'NSE:EQ', name: 'NSE:EQ', kind: 'EQUITY' }, { id: 'US:NOW', name: 'US:NOW', kind: 'RSU' },
    ]);
    expect(log.bonds.map((b) => b.id)).toEqual(['BOND:X']);
    expect(log.spLabels).toEqual([{ label: 'Himachal trip', balancePaise: rupees(250_000) }]);
    // B2's only flow is reversed: nothing live is logged there, so null, not ₹0.
    expect(log.pots).toEqual([
      { id: 'B2', name: 'House fund', balancePaise: null }, { id: 'B3', name: 'Emergency fund', balancePaise: null },
      { id: 'B4', name: 'Education corpus', balancePaise: null }, { id: 'SP', name: 'Planned spending', balancePaise: rupees(250_000) },
    ]);
    expect(log.idleBankCashPaise).toBe(rupees(900_000 - 250_000));

    const byKind = (k: string) => log.timeline.find((e) => e.kind === k)!;
    expect(byKind('Goal').reversible).toEqual({ entity: 'bucket_flow', entityId: flow!.id });
    expect(byKind('Goal').reversed).toEqual({ on: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), reason: 'entered twice' });
    expect(byKind('Earmark').reversible?.entity).toBe('earmark');
    expect(byKind('Earmark').reversed).toBeNull();
    expect(byKind('Note').reversible).toBeNull();
    expect(log.timeline.filter(canReverse).map((e) => e.kind)).toEqual(['Earmark']);   // reversed and notes: no control
    expect(canReverse({ reversible: { entity: 'bogus' as never, entityId: '1' }, reversed: null })).toBe(false);

    expect(plannedSpendingLine(log.spLabels)).toBe('Planned spending ₹2.50L (Himachal trip ₹2.50L)');
  });

  it('SIP move pickers: held funds one per fund, deduped across accounts; "to" by the category logSipMove checks', async () => {
    const d = await db();
    const MID = 'Equity Scheme - Mid Cap Fund';
    const FLEXI = 'Equity Scheme - Flexi Cap Fund';
    const inst = (id: string, name: string, canonical: string | null, meta: object) => d.query(
      `insert into instruments (id, kind, name, currency, canonical_id, metadata) values ($1, 'MF', $2, 'INR', $3, $4::jsonb)`,
      [id, name, canonical, JSON.stringify(meta)]);
    await inst('MF:HDFC-MID', 'HDFC Mid Cap', 'C-HDFC-MID', { amfiCategory: MID });
    await inst('IND:HDFC-MID', 'HDFC MID CAP OPP DIR GR', 'C-HDFC-MID', {});   // category only on its seed sibling
    await inst('MF:PPFAS', 'Parag Parikh Flexi Cap', null, { amfiCategory: FLEXI });
    await inst('MFU:1', 'Invesco India Mid Cap Fund - Direct Growth', null, { universe: true, category: MID });
    await inst('MFU:2', 'HDFC Flexi Cap Fund - Direct Growth', null, { universe: true, category: FLEXI });
    // The seed row retires behind its live sibling; the live fund in two accounts is two positions, one fund.
    const hold = (s: string, id: string, account: string, source: string) => d.query(
      `insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
       values ($1, $2, '1', $3, $4, now(), $5)`, [s, id, rupees(10_000).toString(), account, source]);
    await hold(snap, 'MF:HDFC-MID', 'groww', 'manual-seed');
    await hold(snap, 'MF:PPFAS', 'groww', 'manual-seed');
    const [{ id: live }] = await d.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ($1, 'indmoney') returning id::text`, [day(-1)]) as [{ id: string }];
    await hold(live, 'IND:HDFC-MID', 'zerodha', 'indmoney');
    await hold(live, 'IND:HDFC-MID', 'indmoney', 'indmoney');

    const o = await getSipMoveOptions();
    expect(o.from).toEqual([
      { instrumentId: 'IND:HDFC-MID', name: 'HDFC Mid Cap', category: MID },
      { instrumentId: 'MF:PPFAS', name: 'Parag Parikh Flexi Cap', category: FLEXI },
    ]);   // MF:F has no category: not offered
    expect(o.toByCategory[MID]).toEqual([
      { instrumentId: 'IND:HDFC-MID', name: 'HDFC Mid Cap' },
      { instrumentId: 'MFU:1', name: 'Invesco India Mid Cap Fund - Direct Growth' },
    ]);
    expect(o.toByCategory[MID]!.some((f) => /flexi/i.test(f.name))).toBe(false);

    // Every pair the pickers offer passes logSipMove's own category check.
    const { id } = await logSipMove(d, {
      on: day(-1), fromInstrumentId: 'IND:HDFC-MID', toInstrumentId: 'MFU:1', amountPaise: rupees(5_000),
      firstMonth: day(0).slice(0, 7), note: '',
    });
    expect(id).toMatch(/^\d+$/);
  });

  it('index fund "to" options track the same index: a Nifty 50 SIP is never offered a Nifty Next 50 fund', async () => {
    const d = await db();
    const IDX = 'Other Scheme - Index Funds';
    await d.query(`insert into instruments (id, kind, name, currency, isin, metadata) values
      ('MF:ICICI-N50', 'MF', 'ICICI Pru Nifty 50 Index Direct', 'INR', 'INF109K012M7', jsonb_build_object('amfiCategory', $1::text)),
      ('MFU:149999', 'MF', 'Navi Nifty 50 Index Fund', 'INR', null, jsonb_build_object('indexChallenger', true, 'category', $1::text, 'indexType', 'NIFTY50')),
      ('MFU:150000', 'MF', 'Edelweiss Nifty Next 50 Index Fund', 'INR', null, jsonb_build_object('indexChallenger', true, 'category', $1::text, 'indexType', 'NEXT50'))`, [IDX]);
    const [{ id: s }] = await d.query<{ id: string }>(
      `insert into snapshots (business_date, source) values ($1, 'indmoney') returning id::text`, [day(0)]) as [{ id: string }];
    await d.query(`insert into holdings (snapshot_id, instrument_id, quantity, value_paise, account, as_of, source)
      values ($1, 'MF:ICICI-N50', '1', 6884320000, 'indmoney', now(), 'indmoney')`, [s]);
    const o = await getSipMoveOptions();
    const icici = o.from.find((f) => f.instrumentId === 'MF:ICICI-N50')!;
    expect(icici.category).toBe(`${IDX} · Nifty 50 index`);
    expect(o.toByCategory[icici.category]).toEqual([
      { instrumentId: 'MF:ICICI-N50', name: 'ICICI Pru Nifty 50 Index Direct' },
      { instrumentId: 'MFU:149999', name: 'Navi Nifty 50 Index Fund' },
    ]);
  });
});
