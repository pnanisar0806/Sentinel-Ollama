import { getWeeklyReports } from '@/lib/data';
import { Card, Notice, PageHead, Stat } from '@/lib/ui';

export const dynamic = 'force-dynamic';

export default async function NarrativePage() {
  const runs = await getWeeklyReports();
  const withNarrative = runs.filter((r) => r.narrative !== null);

  return (
    <>
      <PageHead
        title="Weekly narrative"
        sub="Every weekly report that was delivered, and the narration that went with it."
      />

      {runs.length === 0 ? (
        <Notice tone="amber">
          No weekly report has been delivered yet. <span className="mono">pnpm report</span>{' '}
          writes a row here once Telegram accepts the message — a dry run delivers
          nothing and is deliberately not recorded, so it cannot mask a failed send.
        </Notice>
      ) : (
        <>
          <div className="stats">
            <Stat label="Reports delivered" value={runs.length} />
            <Stat
              label="With a narration"
              value={withNarrative.length}
              sub={withNarrative.length < runs.length ? 'earlier runs were not stored' : undefined}
            />
            <Stat label="Most recent" value={runs[0]?.asOf ?? '—'} />
          </div>

          <div className="stack">
            {runs.map((run) => (
              <Card
                key={run.asOf}
                title={`Week of ${run.asOf}`}
                aside={run.narrative === null ? 'no narration stored' : undefined}
              >
                {run.narrative === null ? (
                  <Notice tone="gray">
                    Delivered without a stored narration — either{' '}
                    <span className="mono">LLM_API_KEY</span> was unset when it ran, or the
                    run predates 2026-09-21, when the narration began being kept. The
                    engine&rsquo;s own bullets below are unaffected.
                  </Notice>
                ) : (
                  <p className="ips-text">{run.narrative}</p>
                )}

                {run.bullets.length > 0 ? (
                  <>
                    {/* The narration rewrites exactly these and nothing more. Showing
                        both is the only way to see whether it drifted from the engine,
                        which is the reason to read one back at all. */}
                    <p className="muted">What the engine said</p>
                    <ul className="notyet-points">
                      {run.bullets.map((b, i) => <li key={i}>{b}</li>)}
                    </ul>
                  </>
                ) : (
                  <p className="muted">
                    No bullets stored for this run.
                  </p>
                )}
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  );
}
