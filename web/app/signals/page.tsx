import { getSignals } from '../../lib/data';
import { Badge, Card, DataTable, Notice, PageHead } from '../../lib/ui';

export const dynamic = 'force-dynamic';

/** Sub-scores are nullable: a missing leg is rendered as unknown, never as zero. */
const score = (v: number | null) =>
  v === null ? <span className="dim">—</span> : <>{v.toFixed(1)}</>;

const ratio = (v: number | null, suffix = '') =>
  v === null ? <span className="dim">—</span> : <>{`${v}${suffix}`}</>;

export default async function SignalsPage() {
  const { scoreDate, rows } = await getSignals();
  const passed = rows.filter((r) => r.qualityPassed).length;

  return (
    <>
      <PageHead
        title="Signal review"
        badge={
          scoreDate
            ? <Badge tone="gray">scored {scoreDate}</Badge>
            : <Badge tone="amber">never run</Badge>
        }
        sub="The satellite composite — valuation, trend, earnings and fit — against the section 6 quality gate. The gate is fail-closed: a name that does not pass is not a candidate regardless of how well it scores."
      />

      {scoreDate === null ? (
        <Notice tone="amber">
          No scoring run has been recorded. <span className="mono">signal_scores</span> is empty —
          run <span className="mono">pnpm report</span> or the signal review job to populate it.
          Nothing is inferred in the meantime.
        </Notice>
      ) : (
        <>
          <div className="grid">
            <Card title="Quality gate" aside="section 6, fail-closed" tone={passed > 0 ? 'ok' : 'warn'}>
              <p style={{ margin: '0.2rem 0' }}>
                <strong>{passed}</strong> of <strong>{rows.length}</strong> scored names pass.
              </p>
              <p className="dim" style={{ marginBottom: 0 }}>
                A failed gate is disqualifying, not a penalty applied to the composite.
              </p>
            </Card>
          </div>

          <div className="card" style={{ padding: '0.3rem 0' }}>
            <DataTable
              rows={rows}
              rowTone={(r) => (r.qualityPassed ? undefined : 'red')}
              cols={[
                { label: '#', align: 'right', value: (r) => r.rank ?? <span className="dim">—</span> },
                { label: 'Name', value: (r) => r.name },
                { label: 'Instrument', value: (r) => <span className="mono">{r.instrumentId}</span> },
                { label: 'Composite', align: 'right', value: (r) => <strong>{r.composite.toFixed(1)}</strong> },
                { label: 'Gate', value: (r) => (r.qualityPassed ? <Badge tone="green">pass</Badge> : <Badge tone="red">fail</Badge>) },
                { label: 'Val', align: 'right', value: (r) => score(r.valuation) },
                { label: 'Trend', align: 'right', value: (r) => score(r.trend) },
                { label: 'Earn', align: 'right', value: (r) => score(r.earnings) },
                { label: 'Fit', align: 'right', value: (r) => score(r.fit) },
                { label: 'ROCE', align: 'right', value: (r) => ratio(r.rocePct, '%') },
                { label: 'D/E', align: 'right', value: (r) => ratio(r.deRatio) },
                {
                  label: 'FCF 5y',
                  value: (r) =>
                    r.fcfPositive5y === null ? <span className="dim">—</span>
                      : r.fcfPositive5y ? <Badge tone="green">positive</Badge>
                        : <Badge tone="amber">negative</Badge>,
                },
                {
                  label: 'Flags',
                  align: 'right',
                  value: (r) =>
                    r.redFlags === null ? <span className="dim">—</span>
                      : r.redFlags > 0 ? <Badge tone="red">{r.redFlags}</Badge>
                        : <span className="dim">0</span>,
                },
              ]}
            />
          </div>

          <p className="dim" style={{ marginTop: '0.4rem' }}>
            Fundamentals columns come from the most recent screener upload carrying that
            instrument. A dash means the value was never captured — it is not a zero.
          </p>
        </>
      )}
    </>
  );
}
