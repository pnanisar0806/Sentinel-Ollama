import type { Db } from '../db/client.js';
import { loadPositions, type Position } from './networth.js';
import { concentration } from './allocation.js';
import { blockedInstruments, assessStaleness } from '../sources/staleness.js';
import { formatInr, paise } from '../money/paise.js';
import type { Recommendation } from './recommendations.js';
import type { OverrideEvent } from './recommendations.js';

export const RAIL_CONSTRAINTS = {
  MAX_ORDER_PAISE: 100_00_000,
  TACTICAL_MONTHLY_PAISE: 50_00_000,
} as const;

/** Default owner rails seeded by `seed.ts`. Idempotent — existing values are preserved. */
export const DEFAULT_OWNER_RAILS: Record<string, unknown> = {
  cash_ceiling_pct: 20,
  tactical_monthly_paise: 50_00_000,
  max_order_paise: 100_00_000,
  single_stock_cap_pct: 10,
  employer_cap_pct: 25,
  mf_scheme_cap_pct: 10,
  sector_cap_pct: 20,
  issuer_cap_pct: 15,
};

export type RailViolation =
  | { code: 'MAX_ORDER_EXCEEDED'; detail: string }
  | { code: 'TACTICAL_BUDGET_EXCEEDED'; detail: string }
  | { code: 'CONCENTRATION_BREACH'; detail: string }
  | { code: 'FORBIDDEN_UNIVERSE'; detail: string }
  | { code: 'STALE_DATA'; detail: string }
  | { code: 'NO_CATCH_UP'; detail: string }
  | { code: 'HOLD_PERIOD'; detail: string }
  | { code: 'OVERRIDE_INVALID'; detail: string }
  | { code: 'COOLING_NOT_ELAPSED'; detail: string }
  | { code: 'DRAWDOWN_LOOSENING_BLOCKED'; detail: string }
  | { code: 'DRAWDOWN_JUSTIFICATION_REQUIRED'; detail: string };

export type FreezeState = {
  active: boolean;
  frozenAt: string | null;
  reason: string | null;
};

export type BreakerState = {
  active: boolean;
  consecutiveFalsifications: number;
  lastFalsificationAt: string | null;
  demotedAt: string | null;
  postMortemNote: string | null;
};

export async function checkRails(
  db: Db,
  recommendation: Recommendation,
  opts: { override?: OverrideEvent; isRevision?: boolean } = {}
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

  const conc = concentration(positions);
  for (const breach of conc.breaches) {
    violations.push({ code: 'CONCENTRATION_BREACH', detail: breach });
  }

  const forbidden = await db.query<{ instrument_id: string }>(
    `select instrument_id from instruments where metadata->>'forbidden' = 'true'`
  );
  if (primaryInst && forbidden.some(f => f.instrument_id === primaryInst)) {
    violations.push({ code: 'FORBIDDEN_UNIVERSE', detail: `${primaryInst} is in forbidden universe` });
  }

  const amountPaise = BigInt(recommendation.primary.amountPaise ?? '0');
  if (amountPaise > 100_00_000n) {
    violations.push({ code: 'MAX_ORDER_EXCEEDED', detail: `${formatInr(paise(amountPaise))} exceeds ₹1L ceiling` });
  }

  const tacticalUsed = await getTacticalUsedThisMonth(db);
  if (tacticalUsed + amountPaise > 50_00_000n) {
    violations.push({ code: 'TACTICAL_BUDGET_EXCEEDED', detail: `Tactical deployment would exceed ₹50k/month (used: ${formatInr(paise(tacticalUsed))})` });
  }

  if (recommendation.primary.action === 'BUY' && primaryInst) {
    const [{ n } = { n: '0' }] = await db.query<{ n: string }>(
      `select count(*) as n from recommendations
       where suppressed = false and primary_rec like $1
       order by created_on desc limit 1`,
      [`%"instrumentId":"${primaryInst}"%`]
    );
    if (Number(n) > 0) {
      const [prior] = await db.query<{ created_on: string | Date }>(
        `select created_on from recommendations
         where suppressed = false and primary_rec like $1
         order by created_on desc limit 1`,
        [`%"instrumentId":"${primaryInst}"%`]
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

  const coolingViolation = await checkRailCooling(db);
  if (coolingViolation) violations.push(coolingViolation);

  const drawdownViolation = await checkDrawdownLoosening(db);
  if (drawdownViolation) violations.push(drawdownViolation);

  const drawdownJustification = await checkDrawdownJustification(db, recommendation);
  if (drawdownJustification) violations.push(drawdownJustification);

  return violations;
}

async function getTacticalUsedThisMonth(db: Db): Promise<bigint> {
  // Tactical budget tracking not yet implemented - order_intents lacks amount_paise column
  // Would need payload_snapshot parsing or a dedicated amount column
  return 0n;
}

function monthsBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) - (b.getUTCDate() < a.getUTCDate() ? 1 : 0);
}

async function checkRailCooling(db: Db): Promise<{ code: string; detail: string } | null> {
  const [row] = await db.query<{ value: { cooling_until: string } | string }>(
    `select value from settings_rails where key = 'last_rail_change'`
  );
  if (!row) return null;
  const val = typeof row.value === 'string' ? JSON.parse(row.value) : row.value;
  if (val.cooling_until && new Date(val.cooling_until) > new Date()) {
    return { code: 'COOLING_NOT_ELAPSED', detail: `Rail change cooling until ${new Date(val.cooling_until).toISOString()}` };
  }
  return null;
}

async function checkDrawdownLoosening(db: Db): Promise<{ code: string; detail: string } | null> {
  const [drawdown] = await db.query<{ current_pct: number }>(
    `select current_pct from portfolio_drawdown where as_of = (select max(as_of) from portfolio_drawdown)`
  );
  if (!drawdown || drawdown.current_pct <= 15) return null;

  const [lastChange] = await db.query<{ key: string; value: unknown }>(
    `select key, value from settings_rails where key = 'last_rail_change'`
  );
  if (!lastChange) return null;

  const isLoosening = (lastChange.value as any)?.direction === 'loosen';
  if (isLoosening) {
    return { code: 'DRAWDOWN_LOOSENING_BLOCKED', detail: `Drawdown ${drawdown.current_pct}% > 15% — rail loosening blocked` };
  }
  return null;
}

async function checkDrawdownJustification(db: Db, recommendation: Recommendation): Promise<{ code: string; detail: string } | null> {
  const [drawdown] = await db.query<{ current_pct: number }>(
    `select current_pct from portfolio_drawdown where as_of = (select max(as_of) from portfolio_drawdown)`
  );
  if (!drawdown || drawdown.current_pct < 20) return null;

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

  // Tactical monthly budget check (aggregate, not per order)
  const tacticalUsed = await getTacticalUsedThisMonth(db);
  let totalTactical: import('../money/paise.js').Paise = paise(0n);
  for (const p of positions) {
    if (['EQUITY', 'ETF', 'MF'].includes(p.kind)) {
      totalTactical = paise(totalTactical + p.valuePaise);
    }
  }
  if (tacticalUsed + totalTactical > 50_00_000n) {
    violations.push({ code: 'TACTICAL_BUDGET_EXCEEDED', detail: `Tactical deployment would exceed ₹50k/month (used: ${formatInr(paise(tacticalUsed))})` });
  }

  // Cooling period
  const coolingViolation = await checkRailCooling(db);
  if (coolingViolation) violations.push(coolingViolation);

  // Drawdown loosening
  const drawdownViolation = await checkDrawdownLoosening(db);
  if (drawdownViolation) violations.push(drawdownViolation);

  return violations;
}

export async function checkFreeze(db: Db): Promise<void> {
  const state = await getFreezeState(db);
  if (state.active) {
    throw new Error('FREEZE active since ' + state.frozenAt + ': ' + state.reason);
  }
}
