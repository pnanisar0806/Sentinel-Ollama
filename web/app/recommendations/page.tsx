import { Notice, NotYetBuild, PageHead, PendingButton } from '../../lib/ui';

export default function RecommendationsPage() {
  return (
    <>
      <PageHead
        title="Recommendations"
        sub="Paper recommendations, approved or suppressed by you. No orders anywhere."
      />
      <Notice tone="amber">
        Hard PRD constraint: every order requires fresh human approval, and there is no execution path in this
        product at all right now. These buttons record a decision in paper — approving a recommendation never places
        a trade.
      </Notice>
      <NotYetBuild
        task="Task 10"
        why="The recommendation pipeline does not exist yet — there is no recommendation table, no generation engine, and no FR-31-gated input seam. Until Task 10 lands, the buttons below sit exactly where they will live, disabled for the honest reason: nothing has been generated."
        points={[
          'Sizing and risk read every input, but the funded-corpus band is deliberately unreadable by them.',
          'Every recommendation cites the IPS clause it serves and the freshness of its inputs.',
          'Approve / suppress / mark-executed decisions persist so scoring (Task 12) can grade them later.',
        ]}
        actions={
          <>
            <PendingButton label="Approve" reason="Task 10 — no paper record yet; approving never executes" />
            <PendingButton label="Suppress" reason="Task 10 — no paper record yet" />
            <PendingButton label="Mark executed" reason="Task 10 — no paper record yet; execution is manual and out of scope by design" />
          </>
        }
      />
    </>
  );
}