import { getScoring } from '../../lib/data';
import { Badge, Card, DataTable, Notice, PageHead, Stat } from '../../lib/ui';

export const dynamic = 'force-dynamic';

export default async function ScoringPage() {
  const { calibration, evaluated } = await getScoring();

  const calRows = calibration.rows.map((r) => ({
    key: `${r.conviction}:${r.horizon}`,
    conviction: r.conviction,
    horizon: r.horizon,
    evaluated: r.evaluated,
    hitRate: r.hitRate,
    medianExcessBps: r.medianExcessBps,
  }));

  return (
    <>
      <PageHead
        title="Scoring & calibration"
        badge={
          calibration.insufficient
            ? <Badge tone="amber">insufficient evidence</Badge>
            : <Badge tone="green">{calibration.totalEvaluated} evaluated</Badge>
        }
        sub="Whether a recommendation beat the benchmark it was measured against, grouped by how confident it was. A hit-rate computed from a handful of outcomes is noise dressed as a number, so it is withheld until the bucket has enough."
      />

      <div className="grid">
        <Stat label="Evaluations completed" value={calibration.totalEvaluated} />
        <Stat label="Minimum per bucket" value={calibration.minimum} sub="before a hit-rate is stated" />
        <Stat
          label="Benchmarked recommendations"
          value={evaluated.length}
          tone={evaluated.length === 0 ? 'amber' : undefined}
        />
      </div>

      {calibration.insufficient ? (
        <Notice tone="amber">
          <strong>No bucket has enough evidence yet.</strong> Every conviction bucket holds fewer
          than {calibration.minimum} completed evaluations, so no hit-rate is reported. This is a
          deliberate refusal, not a missing feature — the number would not mean anything yet.
        </Notice>
      ) : null}

      <Card
        title="Calibration by conviction and horizon"
        aside="section 13"
        tone={calibration.insufficient ? 'warn' : 'ok'}
      >
        {calRows.length === 0 ? (
          <p className="dim" style={{ margin: '0.2rem 0' }}>
            Nothing to calibrate — no recommendation has reached an evaluation date.
          </p>
        ) : (
          <DataTable
            rows={calRows}
            cols={[
              { label: 'Conviction', value: (r) => <Badge tone="indigo">{r.conviction}</Badge> },
              { label: 'Horizon', align: 'right', value: (r) => `${r.horizon}m` },
              { label: 'Evaluated', align: 'right', value: (r) => r.evaluated },
              {
                label: 'Hit rate',
                align: 'right',
                value: (r) =>
                  r.hitRate === null
                    ? <span className="dim">insufficient</span>
                    : <strong>{`${(r.hitRate * 100).toFixed(0)}%`}</strong>,
              },
              {
                label: 'Median excess',
                align: 'right',
                value: (r) =>
                  r.medianExcessBps === null
                    ? <span className="dim">—</span>
                    : `${r.medianExcessBps > 0 ? '+' : ''}${r.medianExcessBps} bps`,
              },
            ]}
          />
        )}
      </Card>

      <Card title="Benchmarked recommendations" aside={evaluated.length === 0 ? 'none' : `${evaluated.length}`}>
        {evaluated.length === 0 ? (
          <Notice tone="gray">
            No recommendation has been benchmarked. A benchmark is snapshotted when the
            recommendation is made; the 3, 6 and 12 month evaluations fill in as those dates pass.
          </Notice>
        ) : (
          <DataTable
            rows={evaluated}
            cols={[
              { label: '#', value: (r) => <span className="mono dim">{r.id}</span> },
              { label: 'Kind', value: (r) => <Badge tone="gray">{r.kind}</Badge> },
              { label: 'Intent', value: (r) => r.intent },
              { label: 'Benchmarked', value: (r) => <span className="dim">{r.benchmarkAsOf}</span> },
              { label: '3m', value: (r) => (r.eval3m ? <Badge tone="green">done</Badge> : <span className="dim">pending</span>) },
              { label: '6m', value: (r) => (r.eval6m ? <Badge tone="green">done</Badge> : <span className="dim">pending</span>) },
              { label: '12m', value: (r) => (r.eval12m ? <Badge tone="green">done</Badge> : <span className="dim">pending</span>) },
            ]}
          />
        )}
      </Card>
    </>
  );
}
