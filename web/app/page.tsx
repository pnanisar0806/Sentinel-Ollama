import { formatInr, type Paise } from '../../src/money/paise.js';
import { getInvestmentControls, getOverview, getSips } from '../lib/data';
import BudgetEditor from './budget-editor';
import { AllocationBar, Badge, Card, ClassChip, DataTable, GoalList, Money, Notice, PageHead, Pct, Stat } from '../lib/ui';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const { input, blocked } = await getOverview();
  const sips = await getSips();
  const controls = await getInvestmentControls();
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

        <div className="span-12">
          <Card
            title="Allocation against the IPS"
            aside={input.breaches.length === 0 ? 'all classes inside their bands' : `${input.breaches.length} outside a band`}
            tone={input.breaches.length === 0 ? 'ok' : 'warn'}
          >
            <AllocationBar drift={input.drift} />
            <p className="help">Based on synced holdings. A purchase recorded in Log updates the monthly budget immediately; allocation changes after the holdings sync includes it.</p>
          </Card>
        </div>

        <div className="span-8">
          <Card
            title="Monthly investing"
            aside={sips.asOf === null ? 'never synced · INDmoney' : `as of ${sips.asOf.slice(0, 10)} · INDmoney`}
            tone={sips.asOf === null || sips.stale ? 'warn' : undefined}
          >
            {sips.asOf === null
              ? <Notice tone="amber">No SIP data yet — the daily sync fills this (<span className="mono">indmoney-sips</span>). Until it does, the advisor sizes nothing.</Notice>
              : sips.stale
                ? <Notice tone="amber">SIP data is from {sips.asOf.slice(0, 10)}, older than 7 days — sizing is paused until it refreshes.</Notice>
                : sips.rows.length === 0
                  ? <Notice>INDmoney reports no active SIPs (as of {sips.asOf.slice(0, 10)}).</Notice>
                  : null}
            <div className="stat-grid">
              <Stat label="Budget" value={<Money p={sips.budgetPaise as Paise} />} accent="sky" />
              <Stat label="SIPs this month" value={sips.sipTotalPaise === null ? 'unknown' : <Money p={sips.sipTotalPaise as Paise} />} sub="INDmoney SIPs + recorded payments" accent="violet" />
              <Stat
                label="Spent this month"
                value={<Money p={sips.spentPaise as Paise} />}
                sub="Sentinel buys + purchases logged on /log"
                accent="teal"
              />
              <Stat
                label="Remaining"
                value={sips.remainingPaise === null ? 'unknown' : <Money p={sips.remainingPaise as Paise} />}
                sub={sips.reason ?? (
                  // Name the binding term: once the budget is raised past SIPs + rail, the rail caps it.
                  sips.sipTotalPaise !== null && sips.envelopePaise === sips.tacticalPaise
                    && sips.budgetPaise - sips.sipTotalPaise > sips.tacticalPaise
                    ? `tactical rail − spent (budget − SIPs is ${formatInr((sips.budgetPaise - sips.sipTotalPaise) as Paise)})`
                    : 'budget − SIPs − spent')}
                accent={/* green only while money is left; ₹0 (already deployed) and unknown are amber */
                  sips.remainingPaise !== null && sips.remainingPaise > 0n ? 'green' : 'amber'}
              />
              <Stat
                label="Next step-up"
                value={sips.nextStepUp
                  ? `${sips.nextStepUp.on} → ${sips.nextStepUp.totalPaise === null ? 'unknown' : formatInr(sips.nextStepUp.totalPaise as Paise)}`
                  : '—'}
                accent="teal"
              />
            </div>
            {sips.rows.length > 0
              ? (
                <DataTable
                  rows={sips.rows}
                  cols={[
                    {
                      label: 'Fund',
                      value: (r) => (r.ownerPaid
                        ? <>{r.fund} <Badge tone="green">{r.recordedPaise === r.amountPaise
                          ? <>paid {formatInr(r.recordedPaise as Paise)} on {r.paidOn} · counted this month</>
                          : <>paid {formatInr(r.recordedPaise as Paise)} on {r.paidOn} · {formatInr(r.amountPaise as Paise)} beyond the feed</>}</Badge></>
                        : r.departed
                        ? <><span className="dim">{r.fund}</span> <Badge tone="gray">stopped — counted this month</Badge></>
                        : r.fund),
                    },
                    { label: 'Class', value: (r) => <ClassChip assetClass={r.assetClass} /> },
                    {
                      label: 'Amount counted',
                      value: (r) => (r.departed ? <span className="dim"><Money p={r.amountPaise as Paise} /></span> : <Money p={r.amountPaise as Paise} />),
                      align: 'right',
                    },
                    { label: 'Step-up', value: (r) => <>{r.stepUp ?? '—'}{r.stepUpInferred ? <> <Badge tone="gray">inferred</Badge></> : null}</> },
                    {
                      label: 'Next',
                      value: (r) => (r.nextOn === null ? '—'
                        : <>{r.nextOn} · {r.nextAmountPaise === null ? <span className="dim">unknown</span> : <Money p={r.nextAmountPaise as Paise} />}</>),
                    },
                  ]}
                />
              )
              : null}
            <BudgetEditor controls={controls} budgetOnly />
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
