import { NotYetBuild, PageHead, PendingButton } from '../../lib/ui';

export default function SignalsPage() {
  return (
    <>
      <PageHead
        title="Signal review"
        sub="Machine-checked signals, each presented for you to confirm or dismiss."
      />
      <NotYetBuild
        task="Task 7"
        why="Signals are hand-synthesised inside the Telegram daily/weekly summaries today. The machine-checked review — a signal record you can inspect row by row — ships in Task 7."
        points={[
          'Every signal is stamped with its pricing inputs, and those inputs are freshness-gated (FR-31): a signal computed over stale prices is not shown as if it were computed over fresh ones.',
          'Watchlist (Task 6), maturity events (Task 1) and allocation drift all become signal inputs once their tables exist.',
          'Confirmation is yours: a confirm/dismiss decision is a paper record, never an order.',
        ]}
        actions={
          <>
            <PendingButton label="Confirm signal" reason="Task 7 — no signal record table yet" />
            <PendingButton label="Dismiss signal" reason="Task 7 — no signal record table yet" />
          </>
        }
      />
    </>
  );
}