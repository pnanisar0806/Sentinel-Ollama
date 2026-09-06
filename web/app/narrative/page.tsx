import { NotYetBuild, PageHead } from '../../lib/ui';

export default function NarrativePage() {
  return (
    <>
      <PageHead
        title="Weekly narrative"
        sub="The digested story of the week — what moved, what it means, what needs you."
      />
      <NotYetBuild
        task="Task 11"
        why="The weekly synthesis is currently a placeholder line in the Telegram message. Task 11 brings the LLM narration (your existing OpenRouter key) driven by the week's real events: drift, signals, maturities and the recommendation pipeline's output."
        points={[
          'Narration is deterministic-fallback — if the LLM is unreachable the report still ships, uncorrupted.',
          'Recommendations cite IPS clauses and freshness stamps (FR-31) inside the text.',
        ]}
      />
    </>
  );
}