import type { Db } from '../db/client.js';
import { classify, loadPositions, type Position } from './networth.js';
import { concentration } from './allocation.js';
import { blockedInstruments, assessStaleness } from '../sources/staleness.js';
import { formatInr, paise } from '../money/paise.js';
import type { Recommendation } from './recommendations.js';
import type { OverrideEvent } from './recommendations.js';
import { DEFAULT_OWNER_RAILS, railPaise } from './rail-values.js';
import { loadFreeEnvelope } from './sips.js';

export { DEFAULT_OWNER_RAILS, railPaise };

export type RailViolation =
  | { code: 'MAX_ORDER_EXCEEDED'; detail: string }
  | { code: 'TACTICAL_BUDGET_EXCEEDED'; detail: string }
  | { code: 'CONCENTRATION_BREACH'; detail: string }
  | { code: 'CASH_CEILING'; detail: string }
  | { code: 'FORBIDDEN_UNIVERSE'; detail: string }
  | { code: 'STALE_DATA'; detail: string }
  | { code: 'NO_CATCH_UP'; detail: string }
  | { code: 'HOLD_PERIOD'; detail: string }
  | { code: 'OVERRIDE_INVALID'; detail: string }
  | { code: 'COOLING_NOT_ELAPSED'; detail: string }
  | { code: 'DRAWDOWN_LOOSENING_BLOCKED'; detail: string }
  | { code: 'DRAWDOWN_JUSTIFICATION_REQUIRED'; detail: string };

type FreezeState = {
  active: boolean;
  frozenAt: string | null;
  reason: string | null;
};

type BreakerState = {
  active: boolean;
  consecutiveFalsifications: number;
  lastFalsificationAt: string | null;
  demotedAt: string | null;
  postMortemNote: string | null;
};

export async function checkRails(
  db: Db,
  recommendation: Recommendation,
  opts: {
    override?: OverrideEvent;
    isRevision?: boolean;
    /** The recommendation this call is gating, so FR-12 does not treat it as its own prior. */
    forRecommendationId?: number | undefined;
    /** Re-gating this existing order (modify, resurface): its own amount is not prior spend. */
    excludeOrderIntentId?: string | undefined;
  } = {}
): Promise<{ code: string; detail: string }[]> {
  const violations: { code: string; detail: string }[] = [];

  const positions = await loadPositions(db);
  const stalenessRows = await assessStaleness(db, new Date().toISOString());

  const primaryInst = recommendation.primary.instrumentId;
  if (primaryInst) {
    const blocked = blockedInstruments(stalenessRows, positions);
    if (blocked.includes(primaryInst)) {
      violations.push({ code: 'STALE_DATA', detail: `${primaryInst} blocked by stale data` });
    }
  }

  const amountPaise = BigInt(recommendation.primary.amountPaise ?? '0');
  violations.push(...(await marginalConcentration(db, positions, recommendation, amountPaise)));

  // `instruments` keys on `id`; there is no `instrument_id` column. This query threw
  // `column "instrument_id" does not exist` on EVERY call, so checkRails aborted here and
  // never reached MAX_ORDER_EXCEEDED, TACTICAL_BUDGET_EXCEEDED, HOLD_PERIOD,
  // OVERRIDE_INVALID, COOLING_NOT_ELAPSED or the drawdown checks. It went unnoticed
  // because the function had no production caller to fail.
  const forbidden = await db.query<{ id: string }>(
    `select id from instruments where metadata->>'forbidden' = 'true'`
  );
  if (primaryInst && forbidden.some(f => f.id === primaryInst)) {
    violations.push({ code: 'FORBIDDEN_UNIVERSE', detail: `${primaryInst} is in forbidden universe` });
  }

  const maxOrder = await railPaise(db, 'max_order_paise');
  if (amountPaise > maxOrder) {
    violations.push({
      code: 'MAX_ORDER_EXCEEDED',
      detail: `${formatInr(paise(amountPaise))} exceeds the ${formatInr(paise(maxOrder))} per-order ceiling`,
    });
  }

  // FR-12 caps DEPLOYMENT, so only a buy is measured against it. A SELL or REDEEM
  // returns money; counting it would make selling into a breach impossible in exactly
  // the month the portfolio needs it. The month is the server's IST month, matching the
  // `as_of` the order row is stamped with — `recommendation.createdOn` can be an older date
  // and would then be compared against a different month's spend.
  // The cap is the free envelope (budget − live SIPs, inside the tactical rail) less this
  // month's spend (Sentinel BUY orders + purchases the owner logged outside Sentinel). An
  // unknown SIP commitment refuses every BUY: guessing zero SIPs would let the owner deploy
  // the whole budget on top of them.
  if (recommendation.primary.action === 'BUY') {
    const env = await loadFreeEnvelope(db, new Date().toISOString(), opts.excludeOrderIntentId);
    if (env.envelopePaise === null) {
      violations.push({ code: 'TACTICAL_BUDGET_EXCEEDED', detail: env.reason ?? 'SIP commitment unknown' });
    } else if (env.spentPaise + amountPaise > env.envelopePaise) {
      violations.push({
        code: 'TACTICAL_BUDGET_EXCEEDED',
        detail: `This order of ${formatInr(paise(amountPaise))} would exceed this month's ${formatInr(paise(env.envelopePaise))} envelope `
          + `(budget ${formatInr(paise(env.budgetPaise))} − SIPs ${formatInr(paise(env.sipTotalPaise ?? 0n))}, `
          + `tactical rail ${formatInr(paise(env.tacticalPaise))}; spent ${formatInr(paise(env.spentPaise))}, `
          + `remaining ${formatInr(paise(env.remainingPaise ?? 0n))})`
          + (env.reason ? `: ${env.reason}` : ''),
      });
    }
  }

  if (recommendation.primary.action === 'BUY' && primaryInst) {
    // One query, not two. The count that used to guard this threw
    // `column "recommendations.created_on" must appear in the GROUP BY clause` —
    // `count(*)` with an `order by` and no grouping is invalid, and it sat directly
    // behind the bad column name above, so the hold-period check had never run either.
    // The count was redundant regardless: the row fetch below answers "is there a prior".
    {
      // FR-12 dates the hold from the last BUY. The `like '%"instrumentId":"X"%'` this
      // replaces matched any prior recommendation naming the instrument, so a SELL or a
      // HOLD on the name would have blocked a first BUY of it; it also treated `%` and
      // `_` inside an id as wildcards. `primary_rec` is text holding JSON, so the cast
      // reads the two fields the rule is actually about.
      const [prior] = await db.query<{ created_on: string | Date }>(
        `select created_on from recommendations
         where suppressed = false
           and (primary_rec::jsonb)->>'instrumentId' = $1
           and (primary_rec::jsonb)->>'action' = 'BUY'
           -- The recommendation being executed is not prior to itself. Without this the
           -- order gate refused every order it was given, each one blocked by the very
           -- recommendation it implements.
           and ($2::bigint is null or id <> $2::bigint)
         order by created_on desc limit 1`,
        [primaryInst, opts.forRecommendationId ?? null]
      );
      if (prior) {
        const priorIso = prior.created_on instanceof Date
          ? prior.created_on.toISOString().slice(0, 10)
          : String(prior.created_on).slice(0, 10);
        const months = monthsBetween(priorIso, recommendation.createdOn);
        if (months < 12 && !opts.override) {
          violations.push({ code: 'HOLD_PERIOD', detail: `${primaryInst} last recommended ${priorIso} (${months} months ago) — inside 12-month hold, no override` });
        }
        if (opts.override && !['ips-spec-change', 'material-adverse-falsification', 'owner-directive'].includes(opts.override)) {
          violations.push({ code: 'OVERRIDE_INVALID', detail: `'${opts.override}' is not a valid override event` });
        }
      }
    }
  }

  // FR-34 rail cooling and the 15% no-loosening rule are NOT order checks any more. They
  // used to push COOLING_NOT_ELAPSED and DRAWDOWN_LOOSENING_BLOCKED here, which refused
  // EVERY order for 48 hours after any rail edit. The PRD asks that the EDIT wait, not
  // the portfolio: `proposeRailChange` / `applyDueRailChanges` in controls.ts now hold a
  // change back for 48 hours and refuse a loosening above 15% drawdown, at proposal and
  // again at activation.

  const drawdownJustification = await checkDrawdownJustification(db, recommendation);
  if (drawdownJustification) violations.push(drawdownJustification);

  return violations;
}

/** `Single-stock cap: NSE:X at 12.0% (cap 10.0%)` -> `NSE:X`. The separator is a colon
 *  followed by a space, which an instrument id (`NSE:X`) never contains. */
const breachSubject = (breach: string): string => breach.split(' at ')[0]!.split(': ').slice(1).join(': ');

/**
 * What THIS order does to concentration — not what the portfolio already is.
 *
 * `concentration()` reports every standing breach, and the owner's portfolio carries
 * three of them (Employer, Single-issuer, Single-stock). Pushing them all through
 * `checkRails` would refuse *every* order the moment the gate was wired up, including
 * the SELL that would clear the breach. Standing breaches already reach the owner
 * through `checkPortfolioRails`, which both the digest and `/rails` call; this is the
 * only place that can say whether an order makes one worse.
 *
 * A BUY of X strictly raises every bucket X sits in and strictly lowers every other
 * bucket, because the denominator grows. So a post-order breach is caused by this order
 * exactly when it is new, or when its subject is one of X's own buckets — no percentage
 * arithmetic distinguishes them. SELL and TRIM only reduce X, so they are never gated
 * here.
 */
async function marginalConcentration(
  db: Db,
  positions: Position[],
  recommendation: Recommendation,
  amountPaise: bigint,
): Promise<{ code: string; detail: string }[]> {
  const id = recommendation.primary.instrumentId;
  if (recommendation.primary.action !== 'BUY' || !id || amountPaise <= 0n) return [];

  const held = positions.find((p) => p.instrumentId === id);
  let after: Position[];
  if (held) {
    after = positions.map((p) =>
      p.instrumentId === id ? { ...p, valuePaise: paise(p.valuePaise + amountPaise) } : p);
  } else {
    const bought = await syntheticPosition(db, id, amountPaise);
    // An id absent from `instruments` cannot be ordered at all — `order_intents.instrument_id`
    // carries a foreign key to it — so there is no order here whose effect to assess.
    if (!bought) return [];
    after = [...positions, bought];
  }

  const target = held ?? after[after.length - 1]!;
  const ownBuckets = new Set([target.instrumentId, target.issuer, target.sector]
    .filter((b): b is string => b !== null));
  const before = new Set(concentration(positions).breaches.map(breachSubject));

  return concentration(after).breaches
    .filter((breach) => {
      const subject = breachSubject(breach);
      // The employer breach names every employer instrument at once, so it is matched on
      // the flag rather than on its subject text.
      if (breach.startsWith('Employer cap:')) return target.isEmployer;
      return !before.has(subject) || ownBuckets.has(subject);
    })
    .map((breach) => ({ code: 'CONCENTRATION_BREACH', detail: `this order would breach — ${breach}` }));
}

/** The position this BUY would create, for an instrument not currently held. */
async function syntheticPosition(db: Db, id: string, amountPaise: bigint): Promise<Position | null> {
  const [row] = await db.query<{
    kind: Position['kind']; name: string; issuer: string | null;
    sector: string | null; currency: string; is_employer: boolean;
  }>(
    `select kind, name, issuer, sector, currency, is_employer from instruments where id = $1`,
    [id],
  );
  if (!row) return null;
  return {
    instrumentId: id,
    name: row.name,
    kind: row.kind,
    account: 'zerodha',
    valuePaise: paise(amountPaise),
    avgCostPaise: null,
    assetClass: classify(row.kind, id, row.name),
    issuer: row.issuer,
    sector: row.sector,
    currency: row.currency,
    isEmployer: row.is_employer,
    asOf: new Date().toISOString(),
    source: 'rails-projection',
  };
}

function monthsBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
}

/**
 * FR-35 / IPS §3.10: at a drawdown of 20% or more, a SELL or TRIM needs the §3.10
 * citation and a typed justification.
 *
 * Only a sale. This used to apply to every order, so once `portfolio_drawdown` was
 * actually written it would have refused BUYs at exactly the moment the owner's own
 * policy calls a buying opportunity ("drawdowns are buying opportunities", PRD §2.6).
 * The protocol exists to stop a panic sale, and a REDEEM of a maturing bond is not one.
 */
async function checkDrawdownJustification(db: Db, recommendation: Recommendation): Promise<{ code: string; detail: string } | null> {
  if (recommendation.primary.action !== 'SELL' && recommendation.primary.action !== 'TRIM') return null;
  const [drawdown] = await db.query<{ current_pct: number | string }>(
    `select current_pct from portfolio_drawdown where as_of = (select max(as_of) from portfolio_drawdown)`
  );
  // numeric comes back as a string from postgres; compare as a number.
  if (!drawdown || Number(drawdown.current_pct) < 20) return null;

  if (!recommendation.primary.ipsClauseRefs?.includes('3.10')) {
    return { code: 'DRAWDOWN_JUSTIFICATION_REQUIRED', detail: `Drawdown ≥20% — requires §3.10 IPS citation and typed justification` };
  }
  return null;
}

export async function getFreezeState(db: Db): Promise<FreezeState> {
  const [row] = await db.query<{ value: FreezeState | string }>(
    `select value from settings_rails where key = 'freeze_state'`
  );
  if (!row) return { active: false, frozenAt: null, reason: null };
  const val = row.value;
  return typeof val === 'string' ? JSON.parse(val) : val;
}

export async function setFreeze(db: Db, active: boolean, reason: string): Promise<void> {
  if (active) {
    await db.query(
      `insert into settings_rails (key, value) values ('freeze_state', $1)
       on conflict (key) do update set value = $1`,
      [JSON.stringify({ active: true, frozenAt: new Date().toISOString(), reason })]
    );
  } else {
    await db.query(`update settings_rails set value = '{"active":false,"frozenAt":null,"reason":null}' where key = 'freeze_state'`);
  }
}

export async function getBreakerState(db: Db): Promise<BreakerState> {
  const [row] = await db.query<{ value: BreakerState | string }>(
    `select value from settings_rails where key = 'breaker_state'`
  );
  if (!row) return { active: false, consecutiveFalsifications: 0, lastFalsificationAt: null, demotedAt: null, postMortemNote: null };
  const val = row.value;
  return typeof val === 'string' ? JSON.parse(val) : val;
}

export async function recordFalsification(db: Db, instrumentId: string, detail: string): Promise<void> {
  const state = await getBreakerState(db);
  const newState = { ...state, consecutiveFalsifications: state.consecutiveFalsifications + 1, lastFalsificationAt: new Date().toISOString() };
  if (newState.consecutiveFalsifications >= 3) {
    newState.active = true;
    newState.demotedAt = new Date().toISOString();
  }
  await db.query(
    `insert into settings_rails (key, value) values ('breaker_state', $1)
     on conflict (key) do update set value = $1`,
    [JSON.stringify(newState)]
  );
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('breaker', $1, 'FALSIFICATION_RECORDED', 'agent', $2::jsonb)`,
    [instrumentId, JSON.stringify({ instrumentId, detail, consecutive: newState.consecutiveFalsifications })]
  );
}

export async function resetBreaker(db: Db, postMortemNote: string): Promise<void> {
  const state = { active: false, consecutiveFalsifications: 0, lastFalsificationAt: null, demotedAt: null, postMortemNote };
  await db.query(
    `insert into settings_rails (key, value) values ('breaker_state', $1)
     on conflict (key) do update set value = $1`,
    [JSON.stringify(state)]
  );
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('breaker', 'reset', 'BREAKER_RESET', 'owner', $1::jsonb)`,
    [JSON.stringify({ postMortemNote })]
  );
}

/**
 * Portfolio-level rail check for digest/reporting.
 * Checks the current portfolio state against rails without a specific recommendation.
 */
export async function checkPortfolioRails(
  db: Db,
  positions: import('./networth.js').Position[],
  totalAssets: import('../money/paise.js').Paise
): Promise<{ code: string; detail: string }[]> {
  const violations: { code: string; detail: string }[] = [];

  // Concentration breaches
  const conc = concentration(positions);
  for (const breach of conc.breaches) {
    violations.push({ code: 'CONCENTRATION_BREACH', detail: breach });
  }

  // Forbidden universe
  const forbidden = await db.query<{ id: string }>(
    `select id from instruments where metadata->>'forbidden' = 'true'`
  );
  for (const p of positions) {
    if (forbidden.some(f => f.id === p.instrumentId)) {
      violations.push({ code: 'FORBIDDEN_UNIVERSE', detail: `${p.instrumentId} is in forbidden universe` });
    }
  }

  // Tactical: this month's spend (Sentinel BUYs + owner-logged purchases) against the free
  // envelope. The previous version added the value of every equity/MF holding to the spend
  // and compared it with a hard-coded ₹50k, so any real portfolio read as a permanent breach
  // (found 2026-10-14). An unknown envelope is not reported here; the SIP staleness surfaces
  // it and the order gate refuses.
  const env = await loadFreeEnvelope(db, new Date().toISOString());
  if (env.envelopePaise !== null && env.spentPaise > env.envelopePaise) {
    violations.push({
      code: 'TACTICAL_BUDGET_EXCEEDED',
      detail: `This month's deployment: spent ${formatInr(paise(env.spentPaise))} exceeds the `
        + `${formatInr(paise(env.envelopePaise))} envelope (budget ${formatInr(paise(env.budgetPaise))} `
        + `− SIPs ${formatInr(paise(env.sipTotalPaise ?? 0n))}, tactical rail ${formatInr(paise(env.tacticalPaise))})`,
    });
  }

  // Cash ceiling (PRD 3.3)
  const cashViolation = await checkCashCeiling(db, positions, totalAssets);
  if (cashViolation) violations.push(cashViolation);

  // Rail cooling and drawdown loosening are properties of a pending rail EDIT, reported
  // by `pendingRailChanges` in controls.ts, not standing portfolio breaches.

  return violations;
}

/**
 * PRD 3.3: IDLE cash is capped at a share of total investable assets. The owner set it
 * to 10% on 2026-09-19; the PRD had left cash unbounded as part of the "remainder".
 *
 * "Cash" is `classify()`'s CASH class and nothing else -- bank balances. EPF, bonds and
 * liquid/debt funds are DEBT and are not idle cash, so they do not count here.
 *
 * The **funded B3 balance is subtracted first**. B3 is the emergency fund the IPS
 * requires the owner to hold in bank deposits (one IDFC First account, owner 2026-09-25;
 * DICGC covers 5L of it), so holding it is compliance, not idleness -- and its 6,00,000 target
 * is 10.7% of the 2026-09-19 portfolio, which would breach a 10% ceiling the day it
 * completed. Only the balance ACTUALLY in `bucket_flows` is excused: excusing the target
 * would exempt 6L of genuinely idle cash for a fund that does not exist yet. As of
 * 2026-09-19 B3 is unfunded, so this subtracts nothing.
 *
 * `bucket_flows` is queried directly rather than through `buckets.ts`. That module
 * re-exports the reporting-only FI-progress metric, and a sizing or risk function may not
 * reach it, transitively or otherwise. The Task 10 architecture test enforces that, and
 * it refuses the identifier in a comment too -- which is how this note got reworded.
 *
 * The rail is read from `settings_rails` per PRD 11 ("all rails live in settings_rails"),
 * falling back to DEFAULT_OWNER_RAILS when the row is absent. Ceiling is inclusive.
 */
async function checkCashCeiling(
  db: Db,
  positions: import('./networth.js').Position[],
  totalAssets: import('../money/paise.js').Paise,
): Promise<{ code: string; detail: string } | null> {
  if (totalAssets <= 0n) return null;

  const [row] = await db.query<{ value: number | string }>(
    `select value from settings_rails where key = 'cash_ceiling_pct'`,
  );
  const capPct = row ? Number(row.value) : Number(DEFAULT_OWNER_RAILS.cash_ceiling_pct);
  if (!Number.isFinite(capPct)) return null;

  let cash = 0n;
  for (const p of positions) {
    if (p.assetClass === 'CASH') cash += p.valuePaise;
  }

  const [b3Row] = await db.query<{ balance: string | number | null }>(
    `select sum(amount_paise) as balance from bucket_flows where bucket_id = 'B3'`,
  );
  const b3 = b3Row?.balance == null ? 0n : BigInt(b3Row.balance);
  const idle = cash > b3 ? cash - b3 : 0n;

  const actualPct = (Number(idle) / Number(totalAssets)) * 100;
  if (actualPct <= capPct) return null;

  const excused = b3 > 0n ? ` after excluding the B3 emergency fund (${formatInr(paise(b3))})` : '';
  return {
    code: 'CASH_CEILING',
    detail: `Cash ceiling: ${actualPct.toFixed(1)}% of assets in idle cash${excused} (cap ${capPct}%)`,
  };
}

export async function checkFreeze(db: Db): Promise<void> {
  const state = await getFreezeState(db);
  if (state.active) {
    throw new Error('FREEZE active since ' + state.frozenAt + ': ' + state.reason);
  }
}
