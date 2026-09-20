import { NotYetBuild, PageHead } from '../../lib/ui';

export const dynamic = 'force-dynamic';

export default function NarrativePage() {
  return (
    <>
      <PageHead
        title="Weekly narrative"
        sub="The weekly deep report and its narration."
      />
      <NotYetBuild
        task="persistence"
        why="The weekly report and its LLM narration are built and shipping — `pnpm report` composes them and Telegram delivers them. They are simply never stored: the narration exists only in the message that was sent, so there is no row for this page to read."
        points={[
          'What is missing is a table, not an engine. The report builder, the narration prompt and the Sunday schedule all already run.',
          'Persisting it means a weekly_reports row written at send time, carrying the composed text, the model that wrote it and the as_of date — the same as_of/source discipline every other externally-derived row follows.',
          'Until that exists this page would have to re-run the report to show anything, which would spend an LLM call on a page view and could render text that was never actually sent to you.',
        ]}
      />
    </>
  );
}
