import { getDataAge, getFreshness } from '../../lib/data';
import { dayLabel } from '../../lib/cashflow';
import { dataAgeNotices } from '../../lib/data-age';
import { BANK_STALE_DAYS, EPF_STALE_DAYS, SIP_UNITS_GRACE_DAYS, type BalanceAge } from '../../../src/domain/data-age.js';
import { formatInr, type Paise } from '../../../src/money/paise.js';
import { Badge, Card, DataTable, Notice, PageHead } from '../../lib/ui';

export const dynamic = 'force-dynamic';

const fmtAge = (ageHours: number): string =>
  ageHours === Infinity ? 'never' : `${Math.round(ageHours * 10) / 10}h`;

export default async function FreshnessPage() {
  const { rows, blocked, businessDate } = await getFreshness();
  const age = await getDataAge();
  const notices = dataAgeNotices(age);
  const balanceRow = (key: string, item: string, a: BalanceAge) => ({
    key, item, value: formatInr(a.amountPaise as Paise), stale: a.stale,
    changed: `${dayLabel(a.lastChangedOn)} (${a.daysUnchanged} days ago); fetched ${dayLabel(a.fetchedOn)}`,
  });
  const ageRows = [
    ...age.banks.map((b) => balanceRow(`bank-${b.label}`, b.label, b.age)),
    ...(age.epf === null ? [] : [balanceRow('epf', 'EPF', age.epf)]),
    ...age.sipUnits.map((u) => ({
      key: `sip-${u.instrumentId}`, item: `${u.fundName} SIP units`, value: `${u.unitsNow} units`, stale: u.stale,
      changed: `${u.unitsBefore} before the ${dayLabel(u.instalmentOn)} instalment`,
    })),
  ];
  const stale = ageRows.filter((r) => r.stale).length;

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
        title="INDmoney data age"
        aside={stale === 0 ? 'nothing stale' : `${stale} stale`}
        tone={stale === 0 ? 'ok' : 'warn'}
      >
        {ageRows.length === 0
          ? <Notice>Nothing fetched from INDmoney yet. The daily sync reads it.</Notice>
          : (
            <DataTable
              rows={ageRows}
              cols={[
                { label: 'Item', value: (r) => r.item },
                { label: 'Value', align: 'right', value: (r) => r.value },
                { label: 'Last changed', value: (r) => <span className="dim">{r.changed}</span> },
                { label: 'State', value: (r) => (r.stale ? <Badge tone="amber">stale</Badge> : <Badge tone="green">fresh</Badge>) },
              ]}
            />
          )}
        {notices.map((t) => <Notice key={t} tone="amber">{t}</Notice>)}
        <p className="dim" style={{ marginBottom: 0 }}>
          INDmoney gives no refresh time for a holding, and refreshes bank balances and EPF only when you open its app, so
          Sentinel dates each by when its value last changed. A bank is stale after {BANK_STALE_DAYS} days unchanged, EPF after{' '}
          {EPF_STALE_DAYS} days, and a fund&apos;s SIP units when they have not risen {SIP_UNITS_GRACE_DAYS} days after the
          instalment. This only warns: Sentinel keeps using the last value. The monthly cash flow does not depend on the HDFC
          figure: it uses the balance you enter on payday.
        </p>
      </Card>
    </>
  );
}