/**
 * Goal review lines after a life event (batch C spec "Life events"): the emergency-fund
 * target and the education goal are goal status, so they are read here in web/ only, never
 * in src/domain/life-events.ts (the normal plan never reads goal status).
 */
import type { Db } from '../../src/db/client.js';
import { loadGoalTracker, type GoalId } from '../../src/domain/goal-plan.js';
import { openReviewLines, type ReviewLine } from '../../src/domain/life-events.js';

const GOAL_OF: Record<string, GoalId> = { emergency_target: 'EMERGENCY', education_goal: 'EDUCATION' };

/** Open goal lines; `current` is the goal's target label, or null when the tracker cannot load. */
export async function goalReviewLines(db: Db, now: string): Promise<ReviewLine[]> {
  let tracker: Awaited<ReturnType<typeof loadGoalTracker>> | null | undefined;
  return openReviewLines(db, now, ['goal'], async (item) => {
    if (tracker === undefined) tracker = await loadGoalTracker(db, now).catch(() => null);
    return tracker?.cards.find((c) => c.id === GOAL_OF[item.key])?.targetLabel ?? null;
  });
}
