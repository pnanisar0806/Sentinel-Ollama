import type { Paise } from '../../src/money/paise.js';
import { getOverview } from '../lib/data';
import { AllocationBar, Badge, Card, GoalList, Money, Notice, PageHead, Pct, Stat } from '../lib/ui';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const { input, blocked } = await getOverview();
  const stale = input.staleness.filter((r) => r.stale);
  const delta = input.previousNetPaise === null ? null : (input.netPaise - input.previousNetPaise) as Paise;
  const healthy = stale.length === 0 && blocked.length === 0;

  return (
    <>
      <PageHead
        title="Overview"
        badge={<Badge tone="gray">business day {input.businessDate}</Badge>}
        sub="Net worth, where it sits against the IPS, your goals, and whether the data behind it is fresh."
      />

      <div className="bento">
        <div className="span-3">
          <Stat
            label="Net worth"
            value={<Money p={input.netPaise} />}
            sub={delta === null ? 'first snapshot — no prior day yet' : <><Money p={delta} /> vs previous day</>}
            accent={delta === null ? 'violet' : delta < 0n ? 'red' : 'green'}
          />
        </div>
        <div className="span-3"><Stat label="Assets" value={<Money p={input.assetsPaise} />} accent="sky" /></div>
        <div className="span-3"><Stat label="Liabilities" value={<Money p={input.liabilitiesPaise} />} accent="amber" /></div>
        <div className="span-3">
          <Stat
            label="FI floor funded"
            value={<Pct v={input.funded.floorRatio} />}
            sub={`stretch ${(input.funded.stretchRatio * 100).toFixed(0)}% — reporting only, never used to size`}
            accent="teal"
          />
        </div>

        <div className="span-8">
          <Card
            title="Allocation against the IPS"
            aside={input.breaches.length === 0 ? 'all classes inside their bands' : `${input.breaches.length} outside a band`}
            tone={input.breaches.length === 0 ? 'ok' : 'warn'}
          >
            <AllocationBar drift={input.drift} />
          </Card>
        </div>

        <div className="span-4">
          <Card title="Goals">
            <GoalList buckets={input.buckets} />
          </Card>
        </div>

        <div className="span-4">
          <Card
            title="IPS drift"
            aside={input.breaches.length === 0 ? 'within bands' : `${input.breaches.length} breach${input.breaches.length === 1 ? '' : 'es'}`}
            tone={input.breaches.length === 0 ? 'ok' : 'warn'}
          >
            {input.breaches.length === 0
              ? <Notice tone="green">Every asset class is inside its IPS band.</Notice>
              : <ul style={{ margin: 0, paddingLeft: 18 }}>{input.breaches.map((b) => <li key={b}>{b}</li>)}</ul>}
          </Card>
        </div>

        <div className="span-4">
          <Card
            title="Owner rails"
            aside={input.railBreaches.length === 0 ? 'within rails' : `${input.railBreaches.length} breach${input.railBreaches.length === 1 ? '' : 'es'}`}
            tone={input.railBreaches.length === 0 ? 'ok' : 'warn'}
          >
            {input.railBreaches.length === 0
              ? <Notice tone="green">All owner rails satisfied.</Notice>
              : <ul style={{ margin: 0, paddingLeft: 18 }}>{input.railBreaches.map((b) => <li key={b.code}>{b.detail}</li>)}</ul>}
          </Card>
        </div>

        <div className="span-4">
          <Card title="Data health" aside={healthy ? 'clean' : 'attention'} tone={healthy ? 'ok' : 'bad'}>
            {stale.length === 0
              ? <p style={{ margin: 0 }}>Every source is fresh.</p>
              : <ul style={{ margin: 0, paddingLeft: 18 }}>{stale.map((r) => <li key={r.source}>{r.source} — {r.ageHours === Infinity ? 'never updated' : `${Math.round(r.ageHours)}h old`}</li>)}</ul>}
            {blocked.length > 0
              ? <p style={{ margin: '0.5rem 0 0' }}><strong>{blocked.length}</strong> instrument{blocked.length === 1 ? '' : 's'} blocked by FR-31: <span className="mono">{blocked.join(', ')}</span></p>
              : null}
            <p style={{ margin: '0.7rem 0 0' }}>
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
