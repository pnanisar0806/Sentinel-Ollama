import { NotYetBuild, PageHead, PendingButton } from '../../lib/ui';

export default function WatchlistPage() {
  return (
    <>
      <PageHead
        title="Watchlist"
        sub="The bounded list of ~40 names Sentinel watches for signals."
      />
      <NotYetBuild
        task="Task 6"
        why="There is no persistent watchlist yet — Phase 0 has no watchlist table. The daily digest already names watchlist candidates, but they live in the message, not in the system."
        points={[
          'Advisor-owned: Sentinel seeds ~40 names from a domain list and proposes changes to you quarterly.',
          'Unsolicited adds, removes and reprioritisation come back to you for sign-off — nothing mutates on its own.',
          'Signals later read only the watchlist (Task 7), so this table is the dependency they build on.',
        ]}
        actions={
          <>
            <PendingButton label="Add to watchlist" reason="Task 6 — no watchlist table yet" />
            <PendingButton label="Propose change" reason="Task 6 — advisor proposals ship with the seed" />
          </>
        }
      />
    </>
  );
}