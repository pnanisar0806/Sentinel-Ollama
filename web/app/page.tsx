import type { Paise } from '../../src/money/paise.js';
import { getOverview } from '../lib/data';
import { Badge, Card, Money, Notice, PageHead, Pct, Stat } from '../lib/ui';

export const dynamic = 'force-dynamic';

/** One colour per asset class, the same on every page (globals.css --c-*). */
const CLASS_COLOR: Record<string, string> = {
  EQUITY: 'var(--c-equity)', DEBT: 'var(--c-debt)', GOLD: 'var(--c-gold)', CASH: 'var(--c-cash)',
};
const CLASS_LABEL: Record<string, string> = { EQUITY: 'Equity', DEBT: 'Debt & EPF', GOLD: 'Gold', CASH: 'Cash' };

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
            <div className="alloc-bar" role="img"
              aria-label={input.drift.map((d) => `${CLASS_LABEL[d.assetClass]} ${(d.actual * 100).toFixed(1)}%`).join(', ')}>
              {input.drift.map((d) => (
                <span key={d.assetClass} style={{ width: `${d.actual * 100}%`, background: CLASS_COLOR[d.assetClass] }} />
              ))}
            </div>
            <div className="alloc-legend">
              {input.drift.map((d) => (
                <div className="alloc-item" key={d.assetClass}>
                  <span className="swatch" style={{ background: CLASS_COLOR[d.assetClass] }} aria-hidden="true" />
                  <div>
                    <div>{CLASS_LABEL[d.assetClass] ?? d.assetClass}</div>
                    <div className="v">{(d.actual * 100).toFixed(1)}%</div>
                    <div className="muted">band {(d.min * 100).toFixed(0)}–{(d.max * 100).toFixed(0)}%{' '}
                      {d.breach === null ? <span className="tone-green">· in band</span>
                        : <span className={d.breach === 'OVER' ? 'tone-amber' : 'tone-red'}>· {d.breach === 'OVER' ? 'over' : 'under'}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <div className="span-4">
          <Card title="Goals">
            {input.buckets.map((b) => {
              const ratio = b.fundedRatio === null ? null : Math.min(1, b.fundedRatio);
              return (
                <div className="goal" key={b.id}>
                  <div className="goal-top">
                    <span className="goal-name">{b.name} <span className="dim">({b.id})</span></span>
                    <span className="tnum">
                      {b.balancePaise === null ? <span className="dim">not allocated yet</span>
                        : ratio === null ? <Money p={b.balancePaise} compact /> : <Pct v={b.fundedRatio!} />}
                    </span>
                  </div>
                  {ratio !== null
                    ? <div className="progress" aria-hidden="true"><div className={`fill ${ratio >= 1 ? 'f-green' : 'f-violet'}`} style={{ width: `${ratio * 100}%` }} /></div>
                    : null}
                  {b.targetNote ? <span className="muted">{b.targetNote}</span> : null}
                </div>
              );
            })}
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
