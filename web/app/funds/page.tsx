import Link from 'next/link';
import { getFundMix, getFundMoves, getIndexFundChoices, getMfRanking, getSipSuggestions, getSips, type MixStatus } from '@/lib/data';
import { monthLabel, moveStarted, sipText, unitsText } from '@/lib/funds';
import { Badge, Card, DataTable, Money, Notice, PageHead, Stat, type Tone } from '@/lib/ui';
import { MAX_ACHIEVABLE_COMPOSITE } from '../../../src/domain/mf-ranking';
import { sipCapLabel, sipCapSentence, tacticalCapBinds } from '../../../src/domain/sip-advice';
import { formatInr, type Paise } from '../../../src/money/paise';
import { INDEX_SWITCH_MIN_BPS } from '../../../src/domain/index-switch';
import { FUND_TYPE_LABEL, midBps } from '../../../src/domain/fund-mix';
import { ASSUMPTIONS } from '../../../src/config/assumptions';
import { istDate, istMonth } from '../../../src/domain/sips';
import { nextMonthStart } from '../../../src/domain/cadence';
import { ApproveMix } from './approve-mix';
import { SipMoveButton } from './sip-move-button';

export const dynamic = 'force-dynamic';

const pctOf = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
const pctOf2 = (bps: number) => `${(bps / 100).toFixed(2)}%`;
const STATUS_TONE: Record<MixStatus, Tone> = {
  'below midpoint': 'amber', 'in range': 'green', 'above range': 'amber', '0% new money': 'gray',
};

export default async function FundsPage() {
  const mix = await getFundMix();
  const { proposal, signed, actual } = mix;
  const unknownShare = actual.totalPaise === 0n;
  const costUnstamped = mix.findings.some((f) => f.kind === 'cost' && f.text.startsWith('cost not compared'));
  const { ranked, caveats } = await getMfRanking();
  const fundMoves = await getFundMoves();
  // One feed, one reason: every fund's SIP answer is unknown together.
  const sipUnknown = fundMoves.moves.map((m) => m.sip).find((x) => x.kind === 'unknown');
  const sips = await getSips();
  const suggested = await getSipSuggestions();
  const capBinds = tacticalCapBinds(sips);
  const indexFunds = await getIndexFundChoices();
  // Ranking rows carry the position id, which for an INDmoney fund is IND:<fund_id> — the
  // same id the SIP sync writes, so no canonical/sibling mapping is needed.
  // Active SIPs only: a SIP stopped this month still counts toward the month, but is not running.
  const sipOf = new Map(sips.rows.filter((r) => !r.departed).map((r) => [r.instrumentId, r.amountPaise]));
  const total = ranked.reduce((a, r) => a + r.valuePaise, 0n);
  const nowIso = new Date().toISOString();
  const month = istMonth(nowIso);
  const firstMonths = [month, nextMonthStart(month).slice(0, 7)].map((m) => ({ value: m, label: monthLabel(m) }));
  const sipAnswerOf = new Map(fundMoves.moves.map((m) => [m.instrumentId, m.sip]));
  // A logged move's new fund, shown in Suggested SIPs before the feed lists it.
  const movedTo = new Map(fundMoves.moves.flatMap((m) => (m.sip.kind === 'moved' ? [[m.sip.toId, m.sip] as const] : [])));
  const rupees = (p: bigint) => `${p / 100n}.${(p % 100n).toString().padStart(2, '0')}`;

  return (
    <>
      <PageHead
        title="Mutual funds"
        sub="Every fund held, scored on consistency, cost and size."
      />

      <Card
        title="Fund mix: target vs actual"
        aside={signed ? `signed ${signed.asOf.slice(0, 10)} · ${signed.band} years` : 'not signed'}
      >
        <DataTable
          rows={[
            ...mix.rows.map((r) => ({ key: r.type, r, u: null })),
            ...actual.untyped.map((u) => ({ key: `u:${u.instrumentId}`, r: null, u })),
          ]}
          cols={[
            { label: 'Type', value: ({ r, u }) => (r ? r.label : <><span className="dim">type unknown</span> · {u!.name}</>) },
            {
              label: 'Target',
              value: ({ r }) => (r === null ? '—'
                : r.target === null ? <span className="dim">not set — approve the proposal below</span>
                : `${pctOf(r.target.minBps)}–${pctOf(r.target.maxBps)}`),
            },
            {
              label: 'Actual',
              value: ({ r, u }) => (unknownShare ? <span className="dim">unknown</span>
                : r ? pctOf(r.actualBps!)
                : pctOf(Number((u!.valuePaise * 10_000n) / actual.totalPaise))),
            },
            {
              label: 'Held',
              value: ({ r, u }) => (unknownShare ? <span className="dim">—</span>
                : <Money p={(r ? r.valuePaise : u!.valuePaise) as never} />),
            },
            {
              label: 'Status',
              value: ({ r }) => (r?.status ? <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge> : <span className="dim">—</span>),
            },
          ]}
        />
        {unknownShare ? (
          <p className="muted">
            No equity fund value is known yet, so the actual mix and what is held are unknown.
            The daily <span className="mono">pnpm sync</span> fills holdings.
          </p>
        ) : null}
        {actual.untyped.length > 0 ? (
          <p className="muted">
            A fund of unknown type counts in the total but is never a top-up candidate. Its type
            is set in <span className="mono">src/domain/fund-mix.ts</span>, keyed by ISIN.
          </p>
        ) : null}
      </Card>

      <Card
        title="Proposal"
        aside={`equity serves FI, ~${ASSUMPTIONS.ownerBirthYear + ASSUMPTIONS.fiTargetAge}, ${proposal.horizonYears} years`}
      >
        {proposal.band === null ? (
          <Notice tone="amber">{proposal.reason}</Notice>
        ) : (
          <>
            <DataTable
              rows={proposal.ranges.map((r) => ({ key: r.type, r }))}
              cols={[
                { label: 'Type', value: ({ r }) => FUND_TYPE_LABEL[r.type] },
                { label: 'Range', value: ({ r }) => `${pctOf(r.minBps)}–${pctOf(r.maxBps)}` },
                { label: 'Midpoint', value: ({ r }) => pctOf(midBps(r)) },
                { label: 'New money', value: ({ r }) => (r.newMoney ? 'yes' : <Badge tone="gray">0% new money</Badge>) },
                { label: 'Why', value: ({ r }) => <span className="dim">{r.reason}</span> },
              ]}
            />
            {mix.newProposal ? (
              <Notice tone="amber">
                A new proposal is ready for the {proposal.band}-year band. The signed ranges stay
                in force until you sign this one.
              </Notice>
            ) : null}
            {signed === null || mix.newProposal
              ? <ApproveMix band={proposal.band} label={`Approve the ${proposal.band}-year ranges`} />
              : <p className="muted">These ranges are signed and in force since {signed.asOf.slice(0, 10)}.</p>}
          </>
        )}

        <h2 className="section-title">Findings</h2>
        {mix.findings.length === 0 ? (
          <p className="muted">No overlap, cost or single-scheme finding for the funds held.</p>
        ) : (
          <ul className="notyet-points">
            {mix.findings.map((f, i) => (
              <li key={`${f.kind}:${f.instrumentId ?? ''}:${i}`}>
                <Badge tone={f.kind === 'scheme_cap' ? 'amber' : 'gray'}>{f.kind.replace('_', ' ')}</Badge> {f.text}
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          Informational. The single-scheme finding counts ETFs as schemes (an ETF is a mutual
          fund scheme); the concentration check and the sell triggers look at mutual funds only.
        </p>
        {costUnstamped ? (
          <Notice tone="amber">
            Cost is not compared until held funds carry an AMFI category with peers&rsquo; expense
            ratios. <span className="mono">pnpm mf:universe</span> fills it.
          </Notice>
        ) : null}
      </Card>

      <Card
        title="Suggested SIPs"
        aside={`toward the signed mix · never cuts a SIP · within ${sipCapLabel(sips.budgetPaise, sips.setAsidePaise)}`}
      >
        {suggested.rows === null ? (
          <Notice tone="amber">No suggestion: {suggested.reason}.</Notice>
        ) : (
          <>
            <DataTable
              rows={suggested.rows.map((s, i) => ({ key: `${s.instrumentId ?? 'new'}:${s.fundType ?? 'u'}:${i}`, s }))}
              cols={[
                {
                  label: 'Fund',
                  value: ({ s }) => (s.instrumentId === null ? <span className="dim">{s.fundName}</span>
                    : s.logged ? <>{s.fundName} <Badge tone="gray">{(() => {
                      const m = movedTo.get(s.instrumentId);
                      return m && !moveStarted(m, month) ? `logged, starts ${monthLabel(m.firstMonth)}` : 'logged, not yet in the feed';
                    })()}</Badge></> : s.fundName),
                },
                { label: 'Type', value: ({ s }) => (s.fundType === null ? <span className="dim">type unknown</span> : FUND_TYPE_LABEL[s.fundType]) },
                {
                  label: 'Current → suggested', align: 'right',
                  value: ({ s }) => <span className="tnum"><Money p={s.currentPaise as never} /> → <strong><Money p={s.suggestedPaise as never} /></strong></span>,
                },
                { label: 'Why', value: ({ s }) => <span className="dim">{s.reason}</span> },
              ]}
            />
            <p className="muted">
              Today&apos;s SIPs total <Money p={suggested.currentPaise as never} />
              {suggested.rows.some((s) => s.logged) ? ', counting SIP moves logged on /log that the feed does not show yet' : ''};
              suggested <Money p={suggested.suggestedPaise as never} />. {sipCapSentence(suggested)} A fund the switch
              check says to leave gets no new money. Change SIPs in INDmoney; the next sync shows them here.
            </p>
          </>
        )}
        {capBinds ? (
          <Notice tone="amber">
            Tactical cap {formatInr(capBinds.capPaise as Paise)} is now below your free money {formatInr(capBinds.freePaise as Paise)} — raise it on <Link href="/cleanup">Cleanup</Link>?
          </Notice>
        ) : null}
      </Card>

      {indexFunds.choices.map((c) => {
        const picks = c.top === null ? [] : [c.top, ...c.alternatives];
        // Each type carries its own latest as-of: a missed listing leaves the last good one.
        const asOf = picks[0]?.asOf ?? c.notProposed[0]?.row.asOf ?? null;
        return (
          <Card key={c.fundType} title={`New index fund: ${FUND_TYPE_LABEL[c.fundType]}`} aside={asOf ? `INDmoney · as of ${asOf}` : undefined}>
            {asOf === null ? (
              <Notice tone="amber">
                No candidates on record — they are read by the daily <span className="mono">pnpm sync</span>.
              </Notice>
            ) : (
              <>
                {c.reason ? <Notice tone="amber">{c.reason}.</Notice> : null}
                {picks.length > 0 ? (
                  <DataTable
                    rows={picks.map((r, i) => ({ key: r.indmoneyFundId, r, i }))}
                    cols={[
                      { label: '', value: ({ i }) => (i === 0 ? <Badge tone="green">top choice</Badge> : <Badge tone="gray">alternative</Badge>) },
                      { label: 'Fund', value: ({ r }) => r.name },
                      { label: 'Expense ratio', align: 'right', value: ({ r }) => pctOf2(r.expenseRatioBps!) },
                      { label: 'Tracking error', align: 'right', value: ({ r }) => (r.trackingErrorBps === null ? <span className="dim">unavailable</span> : pctOf2(r.trackingErrorBps)) },
                      { label: 'AUM', align: 'right', value: ({ r }) => <Money p={r.aumPaise! as never} /> },
                      { label: 'Source', value: ({ r }) => <span className="dim">{r.source} · {r.asOf}</span> },
                    ]}
                  />
                ) : null}
                {c.notProposed.length > 0 ? (
                  <>
                    <h2 className="section-title">Not proposed</h2>
                    <DataTable
                      rows={c.notProposed.map((n) => ({ key: n.row.indmoneyFundId, n }))}
                      cols={[
                        { label: 'Fund', value: ({ n }) => n.row.name },
                        { label: 'Why', value: ({ n }) => <span className="dim">{n.why}</span> },
                      ]}
                    />
                  </>
                ) : null}
                <p className="muted">
                  Ranked on expense ratio, then tracking error, then size.
                  {c.trackingErrorAvailable ? null : ' Tracking error unavailable from INDmoney, so it does not rank.'}
                  {' '}Open it in INDmoney as a Direct Growth SIP; once the sync sees it, it is a held fund like any other.
                </p>
              </>
            )}
          </Card>
        );
      })}

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
                {
                  label: 'SIP',
                  value: ({ r }) => (sips.asOf === null
                    ? <span className="dim">unknown</span>
                    // Stale (or a non-MONTHLY SIP in the set): the list is not a current monthly figure.
                    : sips.stale || sips.sipTotalPaise === null
                      ? <span className="dim">unknown (as of {sips.asOf.slice(0, 10)})</span>
                    // A logged move overrides the feed: the old SIP runs until the move's first month.
                    : sipAnswerOf.get(r.instrumentId)?.kind === 'moved'
                      ? <span className="dim">{moveStarted(sipAnswerOf.get(r.instrumentId)!, month) ? 'stopped — ' : ''}{sipText(sipAnswerOf.get(r.instrumentId)!, month)}</span>
                    : sipOf.has(r.instrumentId)
                      ? <><Money p={sipOf.get(r.instrumentId)! as never} />/mo</>
                      : <span className="dim">no active SIP</span>),
                },
              ]}
            />
          </Card>

          <Card
            title="Switch check"
            aside={`${fundMoves.moves.filter((m) => m.units.kind === 'move').length} of ${fundMoves.moves.length} clear the bar`}
          >
            <p className="muted">
              Each active fund against every Direct growth fund AMFI lists in its category: a
              challenger must beat the holding by {fundMoves.margin} points on a{' '}
              {MAX_ACHIEVABLE_COMPOSITE}-point scale. Each index fund against funds tracking the
              same index: a challenger must cost at least {(INDEX_SWITCH_MIN_BPS / 100).toFixed(2)} points a
              year less. Only mutual funds are checked, not ETFs. Moving a SIP stops this SIP and
              starts the same amount in the new fund — no tax; past units are untouched.
            </p>
            {sipUnknown && <Notice tone="amber">SIP answers unknown — {sipUnknown.reason}</Notice>}
            <DataTable
              rows={fundMoves.moves.map((m) => ({ key: m.instrumentId, m }))}
              cols={[
                { label: 'Fund', value: ({ m }) => m.name },
                { label: 'Category', value: ({ m }) => m.category },
                {
                  label: 'SIP',
                  value: ({ m }) => (m.sip.kind === 'none' || m.sip.kind === 'unknown' ? <span className="dim">{sipText(m.sip, month)}</span>
                    : <>
                      <Badge tone={m.sip.kind === 'move' ? 'amber' : m.sip.kind === 'moved' ? 'indigo' : 'green'}>{sipText(m.sip, month)}</Badge>
                      {m.sip.kind === 'move'
                        ? <SipMoveButton kind="move" fromId={m.instrumentId} toId={m.sip.toId} rupees={rupees(m.sip.amountPaise)} today={istDate(nowIso)} months={firstMonths} />
                        : m.sip.kind === 'moved' ? <SipMoveButton kind="moved" moveId={m.sip.moveId} /> : null}
                    </>),
                },
                {
                  label: 'Units',
                  value: ({ m }) => <Badge tone={m.units.kind === 'move' ? 'amber' : 'green'}>{unitsText(m.units)}</Badge>,
                },
                {
                  label: 'Gain if sold now', align: 'right',
                  value: ({ m }) => (m.units.kind === 'keep' ? <span className="dim">—</span>
                    : m.units.gainPaise === null ? <span className="dim">unknown</span>
                    : <span className="tnum"><Money p={m.units.gainPaise as never} /></span>),
                },
                { label: 'Why', value: ({ m }) => <span className="dim">{m.units.why}</span> },
              ]}
            />
            <p className="muted">
              Annual LTCG exemption: <Money p={fundMoves.ltcgExemptionPaise as never} /> — not net of
              gains already realised this FY. A move staged across financial years can keep long-term
              gains inside each year&apos;s exemption. Gains on units held under 12 months are
              short-term; Sentinel has no purchase dates for funds, so the split is unknown.
              Decisions are yours; change funds in INDmoney.
            </p>
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
            </ul>
          </Card>
        </>
      )}
    </>
  );
}
