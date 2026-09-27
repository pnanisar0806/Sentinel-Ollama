import type { Db } from '../db/client.js';
import { loadPositions } from './networth.js';
import { railPaise } from './rails.js';
import { BANDS } from './engine.js';
import type { SizingInput } from './sizing.js';

/**
 * Reads what `sizeCandidates` needs from the database (Phase 2.5 Task 4). Read-only.
 *
 * Cash available is bank cash (the CASH asset class) minus the emergency fund's funded
 * balance — B3 is never spent on a trade. Open BUY requests reserve their amount until
 * they are done, abandoned, rejected or expired.
 */
const OPEN = ['PENDING_APPROVAL', 'MODIFIED', 'ACKNOWLEDGED', 'AWAITING_MANUAL_EXECUTION', 'DEFERRED'];

export async function loadSizingInput(db: Db, asOf: string): Promise<SizingInput> {
  const positions = await loadPositions(db);
  const portfolio = positions.reduce((s, p) => s + p.valuePaise, 0n);
  const cashPositions = positions.filter((p) => p.assetClass === 'CASH');
  const [b3] = await db.query<{ n: string | null }>(`select sum(amount_paise)::text as n from bucket_flows where bucket_id = 'B3'`);
  const emergency = BigInt(b3?.n ?? '0');
  const cash = cashPositions.length === 0 ? null : cashPositions.reduce((s, p) => s + p.valuePaise, 0n) - emergency;

  const [reserved] = await db.query<{ n: string | null }>(
    `select sum(o.quantity)::bigint::text as n from order_intents o
      where o.intent = 'BUY'
        and (select t.to_status from order_transitions t where t.order_intent_id = o.id order by t.at desc, t.id desc limit 1) = any($1)`,
    [OPEN],
  );

  const units = await db.query<{ instrument_id: string; units: string }>(
    `select h.instrument_id, sum(h.quantity)::text as units from holdings h
      where h.snapshot_id in (select distinct on (source) id from snapshots order by source, business_date desc, id desc)
      group by h.instrument_id`,
  );
  const unitsOf = new Map(units.map((u) => [u.instrument_id, u.units]));

  const quotes = await db.query<{ instrument_id: string; close_paise: string; trade_date: string }>(
    `select distinct on (instrument_id) instrument_id, close_paise::text, trade_date::text
       from prices_eod order by instrument_id, trade_date desc`,
  );

  const [latestScore] = await db.query<{ d: string | null }>(`select max(score_date)::text as d from signal_scores`);
  const buys = latestScore?.d
    ? await db.query<{ instrument_id: string; name: string; kind: string; composite: string }>(
      `select s.instrument_id, i.name, i.kind, s.composite::text from signal_scores s join instruments i on i.id = s.instrument_id
        where s.score_date = $1 and s.quality_passed and s.composite >= $2`,
      [latestScore.d, BANDS.medium],
    )
    : [];

  const sells = await db.query<{ instrument_id: string; name: string; kind: string; action: 'SELL' | 'TRIM'; amount_paise: string | null; blocked_by_minimum_hold: boolean; trigger_code: string; evidence: string }>(
    `select e.instrument_id, i.name, i.kind, e.action, e.amount_paise::text, e.blocked_by_minimum_hold, e.trigger_code, e.evidence
       from exit_candidates e join instruments i on i.id = e.instrument_id
      where e.month = $1 and e.action in ('SELL', 'TRIM')`,
    [asOf.slice(0, 7)],
  );

  return {
    asOf,
    tacticalBudgetPaise: await railPaise(db, 'tactical_monthly_paise'),
    maxOrderPaise: await railPaise(db, 'max_order_paise'),
    cashAvailablePaise: cash,
    reservedPaise: BigInt(reserved?.n ?? '0'),
    portfolioPaise: portfolio,
    singleStockCapPct: Number(await railPaise(db, 'single_stock_cap_pct')),
    holdings: positions.map((p) => ({
      instrumentId: p.instrumentId, valuePaise: p.valuePaise, units: unitsOf.get(p.instrumentId) ?? null,
      kind: p.kind, costKnown: p.avgCostPaise !== null,
    })),
    quotes: new Map(quotes.map((q) => [q.instrument_id, { pricePaise: BigInt(q.close_paise), asOf: q.trade_date }])),
    buys: buys.map((b) => ({ instrumentId: b.instrument_id, name: b.name, kind: b.kind, score: Number(b.composite) })),
    sells: sells.map((s) => ({
      instrumentId: s.instrument_id, name: s.name, kind: s.kind, action: s.action,
      amountPaise: s.amount_paise === null ? null : BigInt(s.amount_paise),
      blockedByMinimumHold: s.blocked_by_minimum_hold, reason: `${s.trigger_code}: ${s.evidence}`,
    })),
  };
}
