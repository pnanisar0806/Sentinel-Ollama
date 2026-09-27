import type { Tone } from '../../lib/ui';

/** Owner-facing words for each approval status. */
export const STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING_APPROVAL: { label: 'waiting for you', tone: 'indigo' },
  MODIFIED: { label: 'modified', tone: 'indigo' },
  ACKNOWLEDGED: { label: 'approved — place it', tone: 'amber' },
  AWAITING_MANUAL_EXECUTION: { label: 'placed — confirm', tone: 'amber' },
  DEFERRED: { label: 'deferred', tone: 'gray' },
  VERIFIED: { label: 'done', tone: 'green' },
  APPROVED: { label: 'approved', tone: 'green' },
  REJECTED: { label: 'rejected', tone: 'gray' },
  EXPIRED: { label: 'expired', tone: 'red' },
  ABANDONED: { label: "didn't go through", tone: 'gray' },
  CANCELLED: { label: 'cancelled', tone: 'gray' },
};
