import type { Db } from '../db/client.js';
import { loadPositions } from './networth.js';
import { railPaise } from './rails.js';
import { loadFreeEnvelope } from './sips.js';
import { loadStockChecks } from './stock-checks.js';
import { CAPS } from './allocation.js';
import { loadFundCandidates } from './fund-mix.js';
import { idleBankCash, loadBucketBalances } from './bucket-balances.js';
import type { SizingInput } from './sizing.js';
import { fromMicro, heldAfterSales, loadLiveSales, toMicro } from './owner-sales.js';

/**
 * Reads what `sizeCandidates` needs from the database (Phase 2.5 Task 4). Read-only.
 *
 * Cash available is bank cash (the CASH asset class) minus the emergency fund's funded
 * balance and Planned spending (SP) — neither is ever spent on a trade. Open BUY
 * requests reserve their amount until they are done, abandoned, rejected or expired.
 */
const OPEN = ['PENDING_APPROVAL', 'MODIFIED', 'ACKNOWLEDGED', 'AWAITING_MANUAL_EXECUTION', 'DEFERRED'];

export async function loadSizingInput(db: Db, asOf: string, now = new Date()): Promise<SizingInput> {
  const positions = await loadPositions(db);
  const portfolio = positions.reduce((s, p) => s + p.valuePaise, 0n);
  const cash = idleBankCash(positions, await loadBucketBalances(db));

  const [reserved] = await db.query<{ n: string | null }>(
    `select sum(o.quantity)::bigint::text as n from order_intents o
      where o.intent = 'BUY'
        and (select t.to_status from order_transitions t where t.order_intent_id = o.id order by t.at desc, t.id desc limit 1) = any($1)`,
    [OPEN],
  );

  const units = await db.query<{ instrument_id: string; quantity: string; source: string; as_of_ist: string }>(
    `select h.instrument_id, h.quantity::text as quantity, h.source,
            (h.as_of at time zone 'Asia/Kolkata')::date::text as as_of_ist from holdings h
      where h.quantity is not null
        and h.snapshot_id in (select distinct on (source) id from snapshots order by source, business_date desc, id desc)`,
  );
  // A manual-seed row less the owner's logged sales since it (spec §3.1), as `loadPositions`.
  const sales = await loadLiveSales(db);
  const micro = new Map<string, bigint>();
  for (const u of units) {
    const held = u.source === 'manual-seed'
      ? heldAfterSales(sales, { instrumentId: u.instrument_id, quantity: u.quantity, since: u.as_of_ist }).held
      : toMicro(u.quantity);
    micro.set(u.instrument_id, (micro.get(u.instrument_id) ?? 0n) + held);
  }
  const unitsOf = new Map([...micro].map(([id, m]) => [id, fromMicro(m)]));

  const quotes = await db.query<{ instrument_id: string; close_paise: string; trade_date: string }>(
    `select distinct on (instrument_id) instrument_id, close_paise::text, trade_date::text
       from prices_eod order by instrument_id, trade_date desc`,
  );

  // The stock gate (Piece 3): composite ≥ BANDS.high, the quality gate and five fail-closed
  // checks (`isPassed`). Everything else never reaches sizing.
  const passed = (await loadStockChecks(db, asOf, now)).filter((s) => s.passed);
  const kinds = passed.length === 0 ? [] : await db.query<{ id: string; kind: string }>(
    `select id, kind from instruments where id = any($1)`, [passed.map((s) => s.instrumentId)]);
  const kindOf = new Map(kinds.map((k) => [k.id, k.kind]));
  const buys = passed.map((s) => ({ instrumentId: s.instrumentId, name: s.name, kind: kindOf.get(s.instrumentId)!, score: s.composite! }));

  const sells = await db.query<{ instrument_id: string; name: string; kind: string; action: 'SELL' | 'TRIM'; amount_paise: string | null; blocked_by_minimum_hold: boolean; trigger_code: string; evidence: string }>(
    `select e.instrument_id, i.name, i.kind, e.action, e.amount_paise::text, e.blocked_by_minimum_hold, e.trigger_code, e.evidence
       from exit_candidates e join instruments i on i.id = e.instrument_id
      where e.month = $1 and e.action in ('SELL', 'TRIM')`,
    [asOf.slice(0, 7)],
  );

  // SIP staleness is about the wall clock now, not the report's asOf. What remains this
  // month (envelope less BUY orders and owner-logged purchases), never the whole envelope.
  const envelope = await loadFreeEnvelope(db, new Date().toISOString());

  return {
    asOf,
    tacticalBudgetPaise: envelope.remainingPaise ?? 0n,
    envelopeReason: envelope.reason,
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
    buys,
    sells: sells.map((s) => ({
      instrumentId: s.instrument_id, name: s.name, kind: s.kind, action: s.action,
      amountPaise: s.amount_paise === null ? null : BigInt(s.amount_paise),
      blockedByMinimumHold: s.blocked_by_minimum_hold, reason: `${s.trigger_code}: ${s.evidence}`,
    })),
    funds: await loadFundCandidates(db, asOf),
    singleSchemeCapPct: Math.round(CAPS.singleMfScheme * 100),
  };
}
