import { getFreshness, getPaydayStatus } from '../../lib/data';
import { dayLabel, staleBankText } from '../../lib/cashflow';
import { formatInr, type Paise } from '../../../src/money/paise.js';
import { Badge, Card, DataTable, Notice, PageHead } from '../../lib/ui';

export const dynamic = 'force-dynamic';

const fmtAge = (ageHours: number): string =>
  ageHours === Infinity ? 'never' : `${Math.round(ageHours * 10) / 10}h`;

export default async function FreshnessPage() {
  const { rows, blocked, businessDate } = await getFreshness();
  const { hdfc } = await getPaydayStatus();

  const tableRows = rows.map((r) => ({
    key: r.source,
    source: r.source,
    asOf: r.asOf.slice(0, 10),
    ageHours: r.ageHours,
    limitHours: r.limitHours,
    state: r.state,
  }));

  return (
    <>
      <PageHead
        title="Data freshness"
        badge={<Badge tone="gray">checked on {businessDate}</Badge>}
        sub="Every source's age against its freshness limit. 'Unimplemented' is a missing feature, not rotten data — the two must read differently."
      />
      <div className="card" style={{ padding: '0.3rem 0' }}>
        <DataTable
          rows={tableRows}
          cols={[
            { label: 'Source', value: (r) => <span className="mono">{r.source}</span> },
            { label: 'As of', value: (r) => <span className="dim">{r.asOf}</span> },
            { label: 'Age', align: 'right', value: (r) => fmtAge(r.ageHours) },
            { label: 'Limit', align: 'right', value: (r) => `${r.limitHours}h` },
            {
              label: 'State',
              value: (r) =>
                r.state === 'stale' ? <Badge tone="red">stale</Badge>
                  : r.state === 'unimplemented' ? <Badge tone="gray">unimplemented</Badge>
                    : <Badge tone="green">fresh</Badge>,
            },
          ]}
        />
      </div>
      <Card
        title="Blocked instruments — FR-31"
        aside={blocked.length === 0 ? 'nothing blocked' : `${blocked.length} blocked`}
        tone={blocked.length === 0 ? 'ok' : 'bad'}
      >
        {blocked.length === 0
          ? <Notice tone="green">Nothing is blocked: every input needed to value the holdings is fresh.</Notice>
          : <p style={{ margin: '0.2rem 0' }}><span className="mono">{blocked.join(', ')}</span></p>}
        <p className="dim" style={{ marginBottom: 0 }}>
          FR-31 gates recommendation inputs, not just display. Each holding is checked against every input needed to value it: the portfolio source that reported it, FX for non-INR holdings, NAVs (amfi) for mutual funds, NSE closes (bhavcopy) for stocks, ETFs and bonds, and screener fundamentals for stocks. Closes, NAVs and FX are judged against the last completed trading session, not the clock, so a weekend or holiday never blocks anything.
        </p>
      </Card>
      <Card
        title="HDFC balance (INDmoney)"
        aside={hdfc === null ? 'never fetched' : hdfc.stale ? `unchanged ${hdfc.daysUnchanged} days` : 'recently changed'}
        tone={hdfc === null ? undefined : hdfc.stale ? 'warn' : 'ok'}
      >
        {hdfc === null
          ? <Notice>No HDFC balance fetched yet. The daily sync reads it from INDmoney.</Notice>
          : (
            <p style={{ margin: '0.2rem 0' }}>
              {formatInr(hdfc.amountPaise as Paise)}, unchanged since {dayLabel(hdfc.lastChangedOn)}; last fetched {dayLabel(hdfc.fetchedOn)}.
            </p>
          )}
        {staleBankText(hdfc) ? <Notice tone="amber">{staleBankText(hdfc)}</Notice> : null}
        <p className="dim" style={{ marginBottom: 0 }}>
          Sentinel fetches the balance every day, but INDmoney refreshes it only when you open its app, so the fetch date says
          nothing about its age. The date the amount last changed does. The monthly cash flow does not depend on it: it uses the
          balance you enter on payday.
        </p>
      </Card>
    </>
  );
}