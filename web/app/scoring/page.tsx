import { NotYetBuild, PageHead } from '../../lib/ui';

export default function ScoringPage() {
  return (
    <>
      <PageHead
        title="Scoring & calibration"
        sub="Whether recommendations beat their baseline, honestly measured, and what gets calibrated because of it."
      />
      <NotYetBuild
        task="Task 12"
        why="There is no recommendation record to score — Task 10 must land first. Calibration without a record would be a fiction, so this page stays a shell until the pipeline exists."
        points={[
          'Every recommendation is scored against its own IPS baseline, not against a tuned target.',
          'Calibration feedback feeds future sizing — and never widens a test band to make a red result green.',
        ]}
      />
    </>
  );
}