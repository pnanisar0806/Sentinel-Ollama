import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/client.js';
import { IPS_V1_TEXT, getIpsClauseIndex } from './ips.js';
import type { FalsificationCondition } from './sell-triggers.js';
import type { Redemption } from './redemptions.js';

/**
 * FR-11 / FR-12 recommendation objects, and FR-55 paper mode.
 *
 * A recommendation is a PAPER object: it is logged and scored, and the surface is the
 * weekly report. Nothing here places an order, and nothing here may learn how funded the
 * owner is — this module is a sizing surface, so it deliberately does not import
 * `buckets.ts`/`maturities.ts` (which re-export `funded-status`). `announceMaturity`
 * takes the routing decision as data from a reporting caller instead.
 */

/** FR-11: a thesis the owner will actually read. */
export const MAX_THESIS_WORDS = 150;

/** FR-12: at most four recommendation objects in a calendar month. */
export const MAX_RECS_PER_MONTH = 4;

/** FR-12 / IPS §3.7: no repeat BUY on a name inside twelve months of the last one. */
export const MIN_HOLD_MONTHS = 12;

/**
 * FR-12: the only three events that may override the repeat-BUY hold. Anything else is a
 * reason to wait, and an unlisted override is not an override.
 */
export const OVERRIDE_EVENTS = [
  'ips-spec-change',
  'material-adverse-falsification',
  'owner-directive',
] as const;
export type OverrideEvent = (typeof OVERRIDE_EVENTS)[number];

/** Mirrors the `recommendations.kind` check constraint. */
export type RecKind =
  | 'satellite'
  | 'mf_switch'
  | 'rebalance'
  | 'sell'
  | 'prepay'
  | 'maturity_routing'
  | 'legacy_note';

/**
 * §6.6's fallback when no same-intent challenger exists: take the broad-index route
 * rather than manufacturing a second single-name idea to fill the slot.
 */
export const INDEX_ROUTE_INSTRUMENT = 'NSE:NIFTYBEES';

export interface RecLeg {
  /** What this leg is trying to achieve. A1 shares the primary's intent; A2 must not. */
  intent: string;
  instrumentId: string | null;
  action: 'BUY' | 'TRIM' | 'SELL' | 'REDEEM' | 'PREPAY' | 'HOLD' | 'REDIRECT';
  /** Stringified paise — money crosses the JSON boundary as a decimal string, never a float. */
  amountPaise: string | null;
  thesis: string;
  ipsClauseRefs: string[];
  /** Machine-testable kill condition; see `sell-triggers.ts` for the grammar. */
  falsification: FalsificationCondition | null;
}

export interface Recommendation {
  kind: RecKind;
  createdOn: string;
  primary: RecLeg;
  /** Exactly two: A1 same intent / different instrument, A2 different intent. */
  alternates: [RecLeg, RecLeg];
  engineEvidence: Record<string, unknown>;
  paperMode: boolean;
}

export interface RecommendationInput {
  kind: RecKind;
  createdOn: string;
  primary: RecLeg;
  /** Ranked same-intent challengers; the best becomes A1. Empty ⇒ the index route. */
  sameIntentAlternates?: RecLeg[];
  /** A2. Absent ⇒ the do-nothing leg, which is always a real option. */
  differentIntent?: RecLeg;
  engineEvidence?: Record<string, unknown>;
  paperMode?: boolean;
}

export function thesisWordCount(thesis: string): number {
  const trimmed = thesis.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

const VALID_CLAUSES = new Set(getIpsClauseIndex(IPS_V1_TEXT).map((c) => c.id));

/**
 * Every problem with a recommendation, not just the first. Returns [] for a valid one.
 *
 * The PRD preamble binds every recommendation to "cite the IPS clause(s) it serves", so a
 * clause id that does not exist in the rendered IPS is a hard failure — a citation nobody
 * can look up is worse than none.
 */
export function validateRecommendation(rec: Recommendation): string[] {
  const errors: string[] = [];
  const legs: [string, RecLeg][] = [
    ['primary', rec.primary],
    ['alternate A1', rec.alternates?.[0] as RecLeg],
    ['alternate A2', rec.alternates?.[1] as RecLeg],
  ];

  if (!Array.isArray(rec.alternates) || rec.alternates.length !== 2) {
    errors.push(`FR-11 requires exactly 2 alternates, found ${rec.alternates?.length ?? 0}`);
  }

  for (const [label, leg] of legs) {
    if (!leg) continue;
    const words = thesisWordCount(leg.thesis);
    if (words === 0) errors.push(`${label}: thesis is empty`);
    if (words > MAX_THESIS_WORDS) {
      errors.push(`${label}: thesis is ${words} words, over the ${MAX_THESIS_WORDS}-word limit`);
    }
    if (leg.ipsClauseRefs.length === 0) {
      errors.push(`${label}: no IPS clause cited`);
    }
    for (const ref of leg.ipsClauseRefs) {
      if (!VALID_CLAUSES.has(ref)) errors.push(`${label}: IPS clause ${ref} does not exist`);
    }
  }

  const [a1, a2] = rec.alternates ?? [];
  if (a1 && a1.intent !== rec.primary.intent) {
    errors.push('alternate A1 must share the primary intent (§6.6: same intent, different instrument)');
  }
  if (a1 && a1.instrumentId === rec.primary.instrumentId) {
    errors.push('alternate A1 must name a different instrument from the primary');
  }
  if (a2 && a2.intent === rec.primary.intent) {
    errors.push('alternate A2 must carry a different intent from the primary (§6.6)');
  }

  return errors;
}

function indexRouteLeg(primary: RecLeg): RecLeg {
  return {
    intent: primary.intent,
    instrumentId: INDEX_ROUTE_INSTRUMENT,
    action: 'BUY',
    amountPaise: primary.amountPaise,
    thesis:
      `No single-name challenger cleared the engine this cycle, so the same intent routes ` +
      `through the broad index instead: ${INDEX_ROUTE_INSTRUMENT} buys the market rather than ` +
      `a view, which is the honest expression of "we want this exposure but have no edge on ` +
      `which name carries it". Costs are lower and there is no single-stock cap to manage.`,
    ipsClauseRefs: ['3.4', '3.6'],
    falsification: null,
  };
}

function doNothingLeg(primary: RecLeg): RecLeg {
  return {
    intent: 'do nothing this cycle',
    instrumentId: null,
    action: 'HOLD',
    amountPaise: null,
    thesis:
      `Doing nothing is a real option and is priced as one: the portfolio stays inside its ` +
      `IPS bands without this action, and the ${MIN_HOLD_MONTHS}-month holding discipline ` +
      `means a skipped cycle costs one month of exposure, not the thesis. Revisit next cycle ` +
      `with fresher data rather than acting on a marginal edge.`,
    ipsClauseRefs: ['3.7'],
    falsification: primary.falsification,
  };
}

/**
 * Builds the FR-11 object and validates it. A caller that wants the errors rather than an
 * exception calls `validateRecommendation` on the pieces itself.
 */
export function buildRecommendation(input: RecommendationInput): Recommendation {
  const a1 = input.sameIntentAlternates?.[0] ?? indexRouteLeg(input.primary);
  const a2 = input.differentIntent ?? doNothingLeg(input.primary);

  const rec: Recommendation = {
    kind: input.kind,
    createdOn: input.createdOn,
    primary: input.primary,
    alternates: [a1, a2],
    engineEvidence: input.engineEvidence ?? {},
    paperMode: input.paperMode ?? true,
  };

  const errors = validateRecommendation(rec);
  if (errors.length > 0) {
    throw new Error(`buildRecommendation: FR-11 violation — ${errors.join('; ')}`);
  }
  return rec;
}

/**
 * Turns a maturity routing decision (Task 1) into a `maturity_routing` recommendation.
 *
 * The routing arrives as DATA rather than being computed here: routing reads bucket
 * status, and `buckets.ts` re-exports `funded-status`, which this module may not reach.
 */
export function announceMaturity(
  redemption: Redemption,
  routing: { bucket: string; thesis: string; ipsClauseRefs: string[]; note: string },
  createdOn: string,
): Recommendation {
  const primary: RecLeg = {
    intent: `route the ${redemption.symbol} redemption`,
    instrumentId: redemption.instrumentId,
    action: 'REDEEM',
    amountPaise: (redemption.facePaise + (redemption.couponDuePaise ?? 0n)).toString(),
    thesis: routing.thesis,
    ipsClauseRefs: routing.ipsClauseRefs,
    falsification: null,
  };
  return buildRecommendation({
    kind: 'maturity_routing',
    createdOn,
    primary,
    sameIntentAlternates: [
      {
        intent: primary.intent,
        instrumentId: null,
        action: 'REDIRECT',
        amountPaise: primary.amountPaise,
        thesis:
          `Route the proceeds to prepaying the highest-rate loan instead of ${routing.bucket}: ` +
          `IPS §3.8 prices credit paper against the loan rate, so cash that cannot beat that ` +
          `rate after tax belongs against the debt. ${routing.note}`,
        ipsClauseRefs: ['3.8'],
        falsification: null,
      },
    ],
    engineEvidence: { maturityDate: redemption.maturityDate, daysUntil: redemption.daysUntil, bucket: routing.bucket },
  });
}

// --- FR-12 caps + paper mode --------------------------------------------------------

export interface GateResult {
  allowed: boolean;
  reason: string | null;
}

const monthOf = (isoDate: string): string => isoDate.slice(0, 7);

/**
 * FR-55 paper mode. Absent from `settings_rails` it is TRUE: Phase 1 has no execution
 * path at all, so the safe reading of a missing switch is "do not act".
 */
export async function isPaperMode(db: Db): Promise<boolean> {
  const [row] = await db.query<{ value: unknown }>(
    `select value from settings_rails where key = 'paper_mode'`,
  );
  if (row === undefined) return true;
  return row.value === true || row.value === 'true';
}

/**
 * FR-12 gate. Both caps are counted against what is already stored, so a re-run cannot
 * talk itself past them.
 */
export async function gateRecommendation(
  db: Db,
  rec: Recommendation,
  opts: { override?: OverrideEvent } = {},
): Promise<GateResult> {
  const month = monthOf(rec.createdOn);
  // A maturity routing is a dated event with pre-approved routing (IPS §3.9), not a new
  // idea: it neither counts toward the cap nor is refused by it (owner, 2026-09-26).
  const [{ n } = { n: '0' }] = await db.query<{ n: string }>(
    `select count(*) as n from recommendations
      where suppressed = false and kind <> 'maturity_routing'
        and to_char(created_on, 'YYYY-MM') = $1`,
    [month],
  );
  if (rec.kind !== 'maturity_routing' && Number(n) >= MAX_RECS_PER_MONTH) {
    return {
      allowed: false,
      reason: `FR-12: ${month} already carries ${n} recommendations, the cap is ${MAX_RECS_PER_MONTH}`,
    };
  }

  if (rec.primary.action === 'BUY' && rec.primary.instrumentId !== null) {
    const [prior] = await db.query<{ created_on: string | Date }>(
      `select created_on from recommendations
        where suppressed = false and primary_rec like $1
        order by created_on desc limit 1`,
      [`%"instrumentId":"${rec.primary.instrumentId}"%`],
    );
    if (prior !== undefined) {
      const priorIso =
        prior.created_on instanceof Date
          ? prior.created_on.toISOString().slice(0, 10)
          : String(prior.created_on).slice(0, 10);
      const months = monthsBetween(priorIso, rec.createdOn);
      if (months < MIN_HOLD_MONTHS) {
        if (opts.override === undefined) {
          return {
            allowed: false,
            reason:
              `FR-12: ${rec.primary.instrumentId} was last recommended on ${priorIso}, ` +
              `${months} months ago — inside the ${MIN_HOLD_MONTHS}-month hold and no override event was given`,
          };
        }
        if (!OVERRIDE_EVENTS.includes(opts.override)) {
          return { allowed: false, reason: `FR-12: '${opts.override}' is not an override event` };
        }
      }
    }
  }

  return { allowed: true, reason: null };
}

function monthsBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`);
  const b = new Date(`${toIso}T00:00:00Z`);
  return (
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    (b.getUTCMonth() - a.getUTCMonth()) -
    (b.getUTCDate() < a.getUTCDate() ? 1 : 0)
  );
}

export interface PersistResult {
  id: number | null;
  suppressed: boolean;
  reason: string | null;
  /** Already stored this month; nothing was written. */
  duplicate?: boolean;
}

/**
 * Persists a recommendation, or — when a cap bites — logs it to `suppressed_actions` with
 * its reason. FR-12 is explicit that a capped action is *visible*, not dropped: an action
 * the engine wanted and policy refused is exactly what the owner needs to see.
 *
 * `suppressed_actions` is keyed `(logged_on, action)`, so the action string carries the
 * kind and instrument to keep two suppressions on one day apart.
 */
export async function persistRecommendation(
  db: Db,
  rec: Recommendation,
  opts: { override?: OverrideEvent } = {},
): Promise<PersistResult> {
  // A report that runs twice must not store its proposals twice: the copy would show on
  // the page and spend the month's FR-12 cap. Same kind, action, instrument and intent in
  // the same month is the same proposal.
  const [existing] = await db.query<{ id: number }>(
    `select id from recommendations
      where suppressed = false and kind = $1 and intent = $2
        and to_char(created_on, 'YYYY-MM') = $3
        and primary_rec::jsonb ->> 'action' = $4
        and primary_rec::jsonb ->> 'instrumentId' is not distinct from $5
      order by id limit 1`,
    [rec.kind, rec.primary.intent, monthOf(rec.createdOn), rec.primary.action, rec.primary.instrumentId],
  );
  if (existing) return { id: Number(existing.id), suppressed: false, reason: null, duplicate: true };

  const gate = await gateRecommendation(db, rec, opts);
  const action = `${rec.kind}:${rec.primary.action}:${rec.primary.instrumentId ?? 'portfolio'}`;

  if (!gate.allowed) {
    await db.query(
      `insert into suppressed_actions (logged_on, action, reason, suppressed_by)
       values ($1, $2, $3, 'FR-12')
       on conflict (logged_on, action) do nothing`,
      [rec.createdOn, action, gate.reason],
    );
    return { id: null, suppressed: true, reason: gate.reason };
  }

  const clauses = [
    ...new Set([rec.primary, ...rec.alternates].flatMap((l) => l.ipsClauseRefs)),
  ];
  const [row] = await db.query<{ id: number }>(
    `insert into recommendations
       (created_on, kind, intent, primary_rec, alternates, ips_clause_refs, engine_evidence, source)
     values ($1, $2, $3, $4, $5, $6, $7, 'advisor')
     returning id`,
    [
      rec.createdOn,
      rec.kind,
      rec.primary.intent,
      // `RecLeg` already carries `instrumentId` and `falsification` — the exact shape
      // `sell-triggers.evaluateExits` reads back to test trigger 1.
      JSON.stringify(rec.primary),
      JSON.stringify(rec.alternates),
      JSON.stringify(clauses),
      JSON.stringify({ ...rec.engineEvidence, paperMode: rec.paperMode, override: opts.override ?? null }),
    ],
  );
  return { id: Number(row!.id), suppressed: false, reason: null };
}

/**
 * FR-55 structural check: no module on the recommendation path may contain an
 * order-placing call. Exported so the test asserts the real source tree rather than a
 * list restated in the test file.
 */
export const ORDER_LIKE_PATTERNS = [
  /place[_A-Z]?order/i,
  /submit[_A-Z]?order/i,
  /\bmodify_order\b/i,
  /\bcancel_order\b/i,
  /\/orders(\/|\?|$)/i,
  /\bgtt\b/i,
];

export function scanForExecutionPaths(dir: string): string[] {
  const hits: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        const text = readFileSync(full, 'utf8');
        // The file that defines the ban necessarily spells out the banned names.
        if (text.includes('ORDER_LIKE_PATTERNS = [')) continue;
        for (const pattern of ORDER_LIKE_PATTERNS) {
          if (pattern.test(text)) hits.push(`${full}: ${pattern}`);
        }
      }
    }
  };
  walk(dir);
  return hits;
}
