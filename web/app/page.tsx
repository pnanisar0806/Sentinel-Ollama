import type { Paise } from '../../src/money/paise.js';
import { getOverview } from '../lib/data';
import { Badge, Card, Money, Notice, PageHead, Pct, Stat } from '../lib/ui';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const { input, blocked } = await getOverview();

  const stale = input.staleness.filter((r) => r.stale);
  const delta =
    input.previousNetPaise === null ? null : (input.netPaise - input.previousNetPaise) as Paise;

  return (
    <>
      <PageHead
        title="Overview"
        badge={<Badge tone="gray">business day {input.businessDate}</Badge>}
        sub="Net worth, goal buckets, breaches, and the health of the data feeding them."
      />

      <div className="stats">
        <Stat
          label="Net worth"
          value={<Money p={input.netPaise} />}
          sub={delta === null ? 'first snapshot — no prior day yet' : <><Money p={delta} /> vs previous day</>}
          tone={delta === null ? undefined : delta < 0n ? 'red' : 'green'}
        />
        <Stat label="Assets" value={<Money p={input.assetsPaise} />} />
        <Stat label="Liabilities" value={<Money p={input.liabilitiesPaise} />} />
        <Stat
          label="FI floor funded"
          value={<Pct v={input.funded.floorRatio} />}
          sub={`stretch ${(input.funded.stretchRatio * 100).toFixed(0)}% — reporting only, never used to size`}
        />
      </div>

      <div className="grid two-thirds">
        <div>
          <Card
            title="IPS drift"
            aside={input.breaches.length === 0 ? 'all classes within bands' : `${input.breaches.length} breach${input.breaches.length === 1 ? '' : 'es'}`}
            tone={input.breaches.length === 0 ? 'ok' : 'warn'}
          >
            {input.breaches.length === 0
              ? <Notice tone="green">Every asset class is inside its IPS band.</Notice>
              : <ul>{input.breaches.map((b) => <li key={b}>{b}</li>)}</ul>}
          </Card>

          <Card
            title="Owner rails"
            aside={input.railBreaches.length === 0 ? 'within rails' : `${input.railBreaches.length} breach${input.railBreaches.length === 1 ? '' : 'es'}`}
            tone={input.railBreaches.length === 0 ? 'ok' : 'warn'}
          >
            {input.railBreaches.length === 0
              ? <Notice tone="green">All owner rails satisfied.</Notice>
              : <ul>{input.railBreaches.map((b) => <li key={b.code}>{b.detail}</li>)}</ul>}
          </Card>
        </div>

        <div>
          <Card title="Goal buckets">
            <ul>
              {input.buckets.map((b) => (
                <li key={b.id}>
                  <strong>{b.name}</strong> <span className="dim">({b.id})</span> —{' '}
                  {b.balancePaise === null
                    ? <span className="dim">not allocated yet</span>
                    : <><Money p={b.balancePaise} />{' · '}target {b.fundedRatio === null ? 'not set' : <><Pct v={b.fundedRatio} /> funded</>}</>}
                  {b.targetNote ? <span className="dim"> — {b.targetNote}</span> : null}
                </li>
              ))}
            </ul>
          </Card>

          <Card
            title="Data health"
            aside={stale.length === 0 && blocked.length === 0 ? 'clean' : 'attention'}
            tone={stale.length === 0 && blocked.length === 0 ? 'ok' : 'bad'}
          >
            {stale.length === 0
              ? <p style={{ margin: '0.3rem 0' }}>Every source is fresh.</p>
              : <ul>{stale.map((r) => <li key={r.source}>{r.source} — {r.ageHours === Infinity ? 'never updated' : `${Math.round(r.ageHours)}h old`}</li>)}</ul>}
            {blocked.length > 0
              ? <p style={{ margin: '0.4rem 0 0' }}><strong>{blocked.length}</strong> instrument{blocked.length === 1 ? '' : 's'} blocked by FR-31: <span className="mono">{blocked.join(', ')}</span></p>
              : null}
            <p style={{ margin: '0.6rem 0 0' }}>
              Next RSU vest:{' '}
              {input.nextVest
                ? <><strong>{input.nextVest.vestOn}</strong> · {input.nextVest.units} units · <Money p={input.nextVest.netPaise} /></>
                : <span className="dim">none projected</span>}
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}