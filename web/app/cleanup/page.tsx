import { getCleanupCalendar, getRatingFilings } from '@/lib/data';
import { Badge, Card, DataTable, Notice, PageHead, Pct } from '@/lib/ui';
import { fmtDateTime, relTime, rupees } from '@/lib/format';
import PromoteExit from './promote-exit';
import ControlsPanel from './controls-panel';

export const dynamic = 'force-dynamic';

export default async function CleanupPage() {
  const { redemptions, freezeState, breakerState, railChanges, exitCandidates, drawdownPct } = await getCleanupCalendar();
  const ratings = await getRatingFilings();

  const statusMap: Record<string, { label: string; tone: 'green' | 'amber' | 'indigo' | 'gray' | 'red' }> = {
    falsification: { label: 'FALSIFICATION', tone: 'red' },
    'red-flag': { label: 'RED FLAG', tone: 'red' },
    'hard-cap': { label: 'HARD CAP', tone: 'amber' },
    underperformance: { label: 'UNDERPERF', tone: 'amber' },
    'better-alternative': { label: 'BETTER ALT', tone: 'indigo' },
    'credit-maturity': { label: 'MATURITY', tone: 'indigo' },
  };

  const exitRows = exitCandidates.map((c) => ({
    key: `${c.trigger}-${c.instrumentId}`,
    trigger: statusMap[c.trigger]?.label ?? c.trigger,
    // The tone was looked up by the mapped LABEL ('HARD CAP'), which is never a key of
    // statusMap, so every badge fell back to grey and the triggers all looked alike.
    tone: statusMap[c.trigger]?.tone ?? 'gray',
    instrument: c.instrumentId,
    action: c.action,
    // A TRIM is sized at the excess over the cap, a SELL or REDEEM at the whole
    // position. NULL means no position sizes it, and renders as unknown, never as 0.
    size: c.amountPaise === null ? null : rupees(c.amountPaise.toString()),
    month: c.month,
    // A breach standing since August is not news in September. NULL means the weekly
    // job has not recorded one yet, which is not the same as "new".
    firstSeen: c.firstSeen,
    evidence: c.evidence,
    overridesHold: c.overridesMinimumHold ? 'Yes' : 'No',
    blockedByHold: c.blockedByMinimumHold ? '⚠ BLOCKED' : 'No',
    ips: c.ipsClauseRefs.join(', '),
    rawTrigger: c.trigger,
    heldByIps: c.blockedByMinimumHold,
  }));

  const redemptionRows = redemptions.map((r) => ({
    key: r.instrumentId,
    instrument: r.instrumentId,
    symbol: r.symbol,
    maturity: r.maturityDate,
    daysUntil: r.daysUntil,
    faceValue: rupees(r.facePaise.toString()),
    couponDue: r.couponDuePaise ? rupees(r.couponDuePaise.toString()) : '\u2014',
    total: rupees((r.facePaise + (r.couponDuePaise ?? 0n)).toString()),
  }));

  return (
    <>
      <PageHead
        title="Cleanup calendar"
        sub="Standing cleanup queue (IPS §3.9) — micro-orphans, thesis-less consolidation, LTCG harvest across fiscal years, bond maturities, and behavioral rails."
      />

      <div className="grid">
        <section className="card span-2">
          <header className="card-head">
            <span className="card-title">Controls</span>
            <span className="card-aside">freeze · breaker · rails</span>
          </header>
          <div className="card-body">
            <ControlsPanel frozen={freezeState.active} breakerTripped={breakerState.active} />
          </div>
        </section>
        <section className="card span-2">
          <header className="card-head">
            <span className="card-title">Freeze state</span>
            <span className="card-aside">{freezeState.active ? 'ACTIVE' : 'INACTIVE'}</span>
          </header>
          <div className="card-body">
            <Badge tone={freezeState.active ? 'red' : 'green'}>{freezeState.active ? 'FREEZE ACTIVE' : 'Normal'}</Badge>
            {freezeState.active && (
              <>
                <p style={{ marginTop: 8 }}>Frozen since: {freezeState.frozenAt ? fmtDateTime(freezeState.frozenAt) : 'unknown'}</p>
                <p>Reason: {freezeState.reason ?? '—'}</p>
              </>
            )}
          </div>
        </section>

        <section className="card span-2">
          <header className="card-head">
            <span className="card-title">Breaker (3 falsifications → report-only)</span>
            <span className="card-aside">{breakerState.active ? 'TRIPPED' : 'OK'}</span>
          </header>
          <div className="card-body">
            <Badge tone={breakerState.active ? 'red' : 'green'}>{breakerState.active ? 'BREAKER TRIPPED' : 'Normal'}</Badge>
            <div style={{ marginTop: 8, display: 'grid', gap: 4 }}>
              <div>Consecutive falsifications: <strong>{breakerState.consecutiveFalsifications}</strong> / 3</div>
              <div>Last falsification: {breakerState.lastFalsificationAt ? fmtDateTime(breakerState.lastFalsificationAt) : '—'}</div>
              {breakerState.active && (
                <>
                  <div>Demoted at: {breakerState.demotedAt ? fmtDateTime(breakerState.demotedAt) : '—'}</div>
                  <div>Post-mortem: {breakerState.postMortemNote ?? 'Not recorded'}</div>
                </>
              )}
            </div>
          </div>
        </section>

        <section className="card span-2">
          <header className="card-head">
            <span className="card-title">Rail changes &amp; drawdown</span>
            <span className="card-aside">
              {railChanges.length === 0 ? 'No change pending' : `${railChanges.length} pending`}
              {drawdownPct !== null && ` · Drawdown: ${drawdownPct}%`}
            </span>
          </header>
          <div className="card-body">
            {railChanges.length === 0
              ? <Badge tone="green">No rail change waiting out its 48 hours</Badge>
              : railChanges.map((c) => (
                <div key={c.key}>
                  <Badge tone="amber">{c.key}: {c.current} → {c.proposed}</Badge>{' '}
                  <span className="dim">takes effect {fmtDateTime(c.activatesAt)}</span>
                </div>
              ))}
            {drawdownPct === null ? (
              <div style={{ marginTop: 8 }} className="dim">
                No recent drawdown on record, so no rail can be loosened until sync records one.
              </div>
            ) : (
              <div style={{ marginTop: 8 }}>
                <Badge tone={drawdownPct >= 20 ? 'red' : drawdownPct >= 15 ? 'amber' : 'green'}>
                  Portfolio drawdown: {drawdownPct}%
                </Badge>
                {drawdownPct >= 20 && <span className="dim"> — §3.10: a sale needs the IPS citation and a typed reason</span>}
                {drawdownPct >= 15 && drawdownPct < 20 && <span className="dim"> — rail loosening is refused above 15%</span>}
                <div className="dim" style={{ marginTop: 4 }}>
                  Price-only, so deposits do not mask a fall. Includes the ServiceNow RSU, priced
                  from its own daily close.
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="card span-2">
          <header className="card-head">
            <span className="card-title">Credit rating actions (IPS §3.8)</span>
            <span className="card-aside">{ratings.filings.length} in 12 months</span>
          </header>
          <div className="card-body">
            <p className="dim">
              Every rating action a bond issuer you hold must disclose to BSE (SEBI Reg 30).
              The filing shows that an action happened; open it to see whether it was a
              downgrade, an upgrade or a reaffirmation.
            </p>
            {ratings.unwatched.length > 0 && (
              <Notice tone="amber">
                Not watched: bonds from issuer {ratings.unwatched.join(', ')}. Add the issuer to
                ISSUER_BSE_SCRIP so its rating actions are fetched.
              </Notice>
            )}
            {ratings.filings.length === 0 ? (
              <Notice tone="gray">No rating filings on record yet. The daily sync fetches them.</Notice>
            ) : (
              <DataTable
                rows={ratings.filings.map((f, i) => ({ key: `${f.filedAt}-${i}`, f }))}
                cols={[
                  { label: 'Filed', value: ({ f }) => fmtDateTime(f.filedAt) },
                  { label: 'Issuer', value: ({ f }) => f.company },
                  {
                    label: 'Filing',
                    value: ({ f }) => (f.attachmentUrl
                      ? <a href={f.attachmentUrl} target="_blank" rel="noreferrer">read the PDF</a>
                      : <span className="dim">no attachment</span>),
                  },
                ]}
              />
            )}
          </div>
        </section>

        <section className="card span-2">
          <header className="card-head">
            <span className="card-title">Bond maturities (60-day horizon)</span>
            <span className="card-aside">{redemptions.length} upcoming</span>
          </header>
          <div className="card-body">
            {redemptions.length === 0 ? (
              <Notice tone="gray">No maturities in horizon.</Notice>
            ) : (
              <DataTable
                rows={redemptionRows}
                cols={[
                  { label: 'Instrument', value: (r) => <span className="mono">{r.instrument}</span> },
                  { label: 'Symbol', value: (r) => r.symbol },
                  { label: 'Maturity', value: (r) => r.maturity },
                  { label: 'Days', align: 'right', value: (r) => r.daysUntil },
                  { label: 'Face value', align: 'right', value: (r) => <span className="tnum">{r.faceValue}</span> },
                  { label: 'Coupon due', align: 'right', value: (r) => <span className="tnum">{r.couponDue}</span> },
                  { label: 'Total', align: 'right', value: (r) => <span className="tnum">{r.total}</span> },
                ]}
              />
            )}
          </div>
        </section>

        <section className="card span-2">
          <header className="card-head">
            <span className="card-title">Sell trigger candidates (this month)</span>
            <span className="card-aside">{exitCandidates.length} candidate(s)</span>
          </header>
          <div className="card-body">
            {exitCandidates.length === 0 ? (
              <Notice tone="green">No exit triggers fired this month.</Notice>
            ) : (
              <DataTable
                rows={exitRows}
                cols={[
                  { label: 'Trigger', value: (r) => <Badge tone={r.tone}>{r.trigger}</Badge> },
                  { label: 'Instrument', value: (r) => <span className="mono">{r.instrument}</span> },
                  { label: 'Action', value: (r) => r.action },
                  { label: 'Size', value: (r) => r.size ?? <span className="dim">unknown</span> },
                  { label: 'Month', value: (r) => r.month },
                  {
                    label: 'First flagged',
                    value: (r) => (r.firstSeen === null
                      ? <span className="dim">not yet recorded</span>
                      : r.firstSeen === r.month ? 'this month' : r.firstSeen),
                  },
                  { label: 'Evidence', value: (r) => <span className="dim">{r.evidence}</span> },
                  { label: 'Overrides hold', value: (r) => r.overridesHold },
                  { label: 'Blocked by hold', value: (r) => r.blockedByHold },
                  { label: 'IPS refs', value: (r) => <span className="mono dim">{r.ips}</span> },
                  {
                    label: 'Act',
                    value: (r) => (
                      <PromoteExit
                        instrumentId={r.instrument}
                        trigger={r.rawTrigger}
                        blocked={r.heldByIps}
                      />
                    ),
                  },
                ]}
              />
            )}
          </div>
        </section>

        <section className="card span-2">
          <header className="card-head">
            <span className="card-title">LTCG Harvest (IPS §3.9)</span>
            <span className="card-aside">₹1.25L/year exemption</span>
          </header>
          <div className="card-body">
            <Notice tone="indigo">
              Cleanup recommendations are generated via <code>pnpm cleanup</code> and appear as paper FR-11 recommendations.
              They include: smallcase termination, micro-orphans {'<\u20b95k'}, thesis-less consolidation, Groww RPOWER manual closure,
              bond credit review, Sammaan maturity routing to B3, and LTCG harvest scheduled across 1–2 fiscal years.
            </Notice>
            <p className="dim">Run <code>pnpm cleanup</code> to refresh the standing queue. All recommendations are PAPER mode — no execution without fresh approval.</p>
          </div>
        </section>
      </div>
    </>
  );
}