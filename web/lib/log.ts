/** Pure display helpers for /log and the Overview's Planned spending line (spec 2026-10-22 §3.3, §3.4). */
import { formatInr, type Paise } from '../../src/money/paise.js';
import { REVERSAL_ENTITIES } from '../../src/domain/reversals.js';
import type { TimelineEntry } from '../../src/domain/owner-log.js';

const ENTITIES: ReadonlySet<string> = new Set(REVERSAL_ENTITIES);

/** The Reverse control shows only on a live, reversible entry of a known entity; the domain still validates. */
export const canReverse = (e: Pick<TimelineEntry, 'reversible' | 'reversed'>): boolean =>
  e.reversible !== null && e.reversed === null && ENTITIES.has(e.reversible.entity);

const lakhs = (p: bigint) => formatInr(p as Paise, { compact: true });

/** "Planned spending ₹X (Himachal trip ₹Y, …)"; null when no label is open. */
export function plannedSpendingLine(labels: readonly { label: string; balancePaise: bigint }[]): string | null {
  if (labels.length === 0) return null;
  const total = labels.reduce((s, l) => s + l.balancePaise, 0n);
  return `Planned spending ${lakhs(total)} (${labels.map((l) => `${l.label} ${lakhs(l.balancePaise)}`).join(', ')})`;
}
