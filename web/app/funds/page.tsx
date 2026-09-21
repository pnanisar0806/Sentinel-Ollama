import { getMfRanking, getMfSwitches } from '@/lib/data';
import { Badge, Card, DataTable, Money, Notice, PageHead, Stat } from '@/lib/ui';
import { MAX_ACHIEVABLE_COMPOSITE } from '../../../src/domain/mf-ranking';

export const dynamic = 'force-dynamic';

export default async function FundsPage() {
  const { ranked, caveats } = await getMfRanking();
  const { switches, margin } = await getMfSwitches();
  const total = ranked.reduce((a, r) => a + r.valuePaise, 0n);

  return (
    <>
      <PageHead
        title="Mutual funds"
        sub="Every fund held, scored on consistency, cost and size."
      />

      {ranked.length === 0 ? (
        <Notice tone="amber">
          No mutual fund holding is on record. The ranking reads live positions, so it
          fills in once <span className="mono">pnpm sync</span> has run.
        </Notice>
      ) : (
        <>
          <div className="stats">
            <Stat label="Funds held" value={ranked.length} />
            <Stat label="Value" value={<Money p={total as never} />} />
            <Stat
              label="Best achievable score"
              value={`${MAX_ACHIEVABLE_COMPOSITE} / 100`}
              sub="tenure and style drift have no source"
            />
          </div>

          {caveats.map((c) => <Notice key={c} tone="amber">{c}</Notice>)}

          <Card title="Ranking" aside={`scored ${ranked[0]?.scoreDate ?? ''}`}>
            <DataTable
              rows={ranked.map((r) => ({ key: r.instrumentId, r }))}
              cols={[
                { label: '#', value: ({ r }) => r.rank },
                { label: 'Fund', value: ({ r }) => r.name },
                { label: 'Category', value: ({ r }) => r.category ?? <span className="dim">unknown</span> },
                { label: 'Value', value: ({ r }) => <Money p={r.valuePaise as never} /> },
                {
                  label: 'Score',
                  value: ({ r }) => (
                    <Badge tone={r.composite >= 50 ? 'green' : r.composite >= 30 ? 'amber' : 'gray'}>
                      {r.composite} / {MAX_ACHIEVABLE_COMPOSITE}
                    </Badge>
                  ),
                },
                {
                  label: 'Consistency',
                  value: ({ r }) => (r.monthsOfHistory <= 12
                    ? <span className="dim">withheld — {r.monthsOfHistory} months</span>
                    : r.components?.consistency ?? '—'),
                },
                { label: 'Cost', value: ({ r }) => r.components?.expense ?? '—' },
                { label: 'Size', value: ({ r }) => r.components?.aum ?? '—' },
                { label: 'Months', value: ({ r }) => r.monthsOfHistory },
              ]}
            />
          </Card>

          <Card
            title="Switch check"
            aside={`${switches.filter((s) => s.challengerId !== null).length} of ${switches.length} clear the bar`}
          >
            <p className="muted">
              Each fund against every Direct growth fund AMFI lists in its category. A
              challenger must beat the holding by {margin} points on a{' '}
              {MAX_ACHIEVABLE_COMPOSITE}-point scale before a switch is proposed — a
              margin a month of NAV noise can cross is not a reason to realise tax.
            </p>
            <DataTable
              rows={switches.map((s) => ({ key: s.heldInstrumentId, s }))}
              cols={[
                { label: 'Fund', value: ({ s }) => s.heldName },
                { label: 'Category', value: ({ s }) => s.category },
                { label: 'Cohort', value: ({ s }) => (s.cohortSize === 0
                  ? <span className="dim">none comparable</span> : s.cohortSize) },
                { label: 'Rank', value: ({ s }) => (s.cohortSize === 0
                  ? '—' : `${s.heldRank} of ${s.cohortSize + 1}`) },
                {
                  label: 'Verdict',
                  value: ({ s }) => (s.challengerId === null
                    ? <Badge tone="green">HOLD</Badge>
                    : <Badge tone="amber">SWITCH</Badge>),
                },
                { label: 'Why', value: ({ s }) => <span className="dim">{s.reason}</span> },
              ]}
            />
          </Card>

          <Card title="What this score does not include">
            <ul className="notyet-points">
              <li>
                <strong>Fund tenure (15 points)</strong> and <strong>style drift (10)</strong>{' '}
                have no source. They are 0 for every fund, so they cannot change the
                order — but they do cap the best possible score at {MAX_ACHIEVABLE_COMPOSITE}.
              </li>
              <li>
                <strong>Size scores the same for every fund held.</strong> The AUM ramp tops
                out at ₹2,000 crore and every fund here is far above it, so cost is the only
                one of the two INDmoney facts that separates them.
              </li>
              <li>
                <strong>Index funds are not switch-checked.</strong> AMFI&rsquo;s category
                says a fund is an index fund, not which index it tracks, so a Nifty 50
                tracker and a smallcap tracker would be ranked against each other. Their
                peer set needs same-index matching first.
              </li>
            </ul>
          </Card>
        </>
      )}
    </>
  );
}
