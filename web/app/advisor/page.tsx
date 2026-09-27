import Link from 'next/link';
import { getAdvisor } from '../../lib/data';
import { Badge, Card, DataTable, Notice, PageHead } from '../../lib/ui';
import type { Tone } from '../../lib/ui';
import { rupees } from '../../lib/format';
import { humanize } from '../../lib/plain';
import { AdviceActions, LineActions } from './actions';

export const dynamic = 'force-dynamic';

const DECISION: Record<string, { tone: Tone; label: string }> = {
  BUY: { tone: 'green', label: 'Buy' }, SELL: { tone: 'red', label: 'Sell' }, HOLD: { tone: 'gray', label: 'Hold' },
  WAIT: { tone: 'amber', label: 'Wait' }, NO_ACTION: { tone: 'gray', label: 'Nothing eligible' }, UNAVAILABLE: { tone: 'red', label: 'Advisor unavailable' },
};
const POLARITY: Record<string, Tone> = { POSITIVE: 'green', NEGATIVE: 'red', NEUTRAL: 'gray', UNKNOWN: 'gray' };

export default async function AdvisorPage() {
  const { advice, revision, commentary, news, calibration, names } = await getAdvisor();
  const latest = advice[0] ?? null;
  const older = advice.slice(1);
  const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

  return (
    <>
      <PageHead
        title="Advisor"
        badge={<Badge tone="indigo">monthly · you sign, then approve</Badge>}
        sub="Once a month the advisor reads each candidate's news, trend and scores and decides for a five-year holder: buy, sell, hold or wait. Amounts are fixed by the system, not the model. Signing sends a buy or sell to Approvals; it is not an order."
      />

      <div className="bento">
        <div className="span-7">
          {latest === null ? (
            <Card title="This month's advice"><Notice>No advice yet. It runs in the first weekly report of each month.</Notice></Card>
          ) : (() => {
            const p = latest.payload;
            const d = DECISION[str(p['decision'])] ?? { tone: 'gray' as Tone, label: str(p['decision']) };
            const excluded = (p['excluded'] as string[] | undefined) ?? [];
            return (
              <Card
                title={<><Badge tone={d.tone}>{d.label}</Badge>{' '}{str(p['name']) || (p['decision'] === 'NO_ACTION' || p['decision'] === 'UNAVAILABLE' ? '' : 'the portfolio')}</>}
                aside={`${latest.asOf.slice(0, 10)} · ${latest.status.toLowerCase()}`}
                tone={p['decision'] === 'UNAVAILABLE' ? 'bad' : undefined}
              >
                {p['amountPaise'] ? <p style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{rupees(str(p['amountPaise']))}{p['units'] ? <span className="dim" style={{ fontSize: 14 }}> · {str(p['units'])} shares</span> : null}</p> : null}
                {p['deferredByNews'] ? <Notice tone="amber">The model said buy, but recent material negative news turned it into WAIT — the owner's rule that news may delay a buy.</Notice> : null}
                {p['reason'] ? <p className="dim">{str(p['reason'])}</p> : null}
                {p['rationale'] ? <><div className="option-label" style={{ marginTop: 12 }}>Why</div><p style={{ margin: 0 }}>{humanize(str(p['rationale']), names)}</p></> : null}
                {p['keyRisk'] ? <><div className="option-label" style={{ marginTop: 12 }}>Key risk</div><p style={{ margin: 0 }}>{str(p['keyRisk'])}</p></> : null}
                {p['falsification'] ? <><div className="option-label" style={{ marginTop: 12 }}>What would prove it wrong</div><p className="option-kill" style={{ margin: 0 }}>{str(p['falsification'])}</p></> : null}
                {p['counterargument'] ? <><div className="option-label" style={{ marginTop: 12 }}>The best case against</div><p className="dim" style={{ margin: 0 }}>{str(p['counterargument'])}</p></> : null}
                {p['horizonYears'] ? <p className="muted">Horizon: {str(p['horizonYears'])} years.</p> : null}
                {excluded.length > 0 && (
                  <details style={{ marginTop: 10 }}><summary className="muted">{excluded.length} candidate(s) not considered, and why</summary>
                    <ul className="muted" style={{ paddingLeft: 18 }}>{excluded.map((e) => <li key={e}>{e}</li>)}</ul>
                  </details>
                )}
                {latest.status === 'OPEN' && p['decision'] !== 'NO_ACTION' && p['decision'] !== 'UNAVAILABLE'
                  ? <div style={{ marginTop: 14 }}><AdviceActions id={latest.id} decision={str(p['decision'])} /></div>
                  : latest.note ? <p className="muted">{latest.status.toLowerCase()}: {latest.note}</p> : null}
              </Card>
            );
          })()}
        </div>

        <div className="span-5">
          <Card title="Weekly commentary" aside={commentary ? commentary.asOf.slice(0, 10) : undefined}>
            {commentary === null
              ? <Notice>No validated commentary yet. Every number in it must match the data, or the section is dropped.</Notice>
              : ((commentary.payload['sections'] as { title: string; text: string }[]) ?? []).map((s) => (
                <div key={s.title} style={{ marginBottom: 12 }}><strong>{s.title}</strong><p className="dim" style={{ margin: '4px 0 0' }}>{s.text}</p></div>
              ))}
          </Card>
        </div>

        <div className="span-12">
          <Card title="Material company news, last 30 days" aside={`${news.length} shown · the model reads headlines only`}>
            {news.length === 0 ? <Notice>No material filings in the last 30 days for held or watched companies.</Notice> : (
              <DataTable
                rows={news.map((n) => ({ key: String(n.id), n }))}
                cols={[
                  { label: 'Date', value: ({ n }) => <span className="tnum dim">{n.on}</span> },
                  { label: 'Company', value: ({ n }) => n.name },
                  { label: 'Reading', value: ({ n }) => n.polarity === null ? <Badge tone="amber">not read yet</Badge> : <Badge tone={POLARITY[n.polarity] ?? 'gray'}>{n.polarity.toLowerCase()} · {n.materiality?.toLowerCase()}</Badge> },
                  { label: 'What it says', value: ({ n }) => <>{n.summary ?? n.headline}{n.url ? <> · <a href={n.url} target="_blank" rel="noreferrer">filing</a></> : null}</> },
                ]}
              />
            )}
          </Card>
        </div>

        <div className="span-7">
          <Card title="Quarterly watchlist revision" aside={revision ? `${str(revision.payload['quarter'])} · ${revision.status.toLowerCase()}` : undefined}>
            {revision === null ? <Notice>None yet. The next one is drafted on the first weekday on or after 20 November.</Notice> : (
              <DataTable
                rows={((revision.payload['lines'] as { op: string; instrumentId: string; name: string; reason: string }[]) ?? []).map((l, i) => ({ key: String(i), l, i }))}
                cols={[
                  { label: 'Change', value: ({ l }) => <Badge tone={l.op === 'ADD' ? 'green' : 'red'}>{l.op === 'ADD' ? 'watch' : 'stop watching'}</Badge> },
                  { label: 'Company', value: ({ l }) => l.name },
                  { label: 'Why', value: ({ l }) => <span className="dim">{l.reason}</span> },
                  { label: 'Decision', value: ({ i }) => revision.decided[i] ? <Badge tone={revision.decided[i] === 'ACCEPTED' ? 'green' : 'gray'}>{revision.decided[i]!.toLowerCase()}</Badge> : <LineActions id={revision.id} line={i} /> },
                ]}
              />
            )}
          </Card>
        </div>

        <div className="span-5">
          <Card title="Track record" aside={`shown once a group has ${calibration.minimum} results`}>
            {calibration.rows.length === 0
              ? <Notice>No results yet. A recommendation is first scored 3 months after it is made.</Notice>
              : <DataTable
                rows={calibration.rows.map((r) => ({ key: `${r.origin}${r.conviction}${r.horizon}`, r }))}
                cols={[
                  { label: 'From', value: ({ r }) => r.origin },
                  { label: 'Confidence', value: ({ r }) => r.conviction.toLowerCase() },
                  { label: 'After', value: ({ r }) => `${r.horizon} months` },
                  { label: 'Scored', align: 'right', value: ({ r }) => r.evaluated },
                  { label: 'Beat the index', align: 'right', value: ({ r }) => r.hitRate === null ? <span className="dim">withheld</span> : `${Math.round(r.hitRate * 100)}%` },
                ]}
              />}
          </Card>
        </div>

        {older.length > 0 && (
          <div className="span-12">
            <Card title="Earlier advice">
              <DataTable
                rows={older.map((p) => ({ key: String(p.id), p }))}
                cols={[
                  { label: 'Date', value: ({ p }) => p.asOf.slice(0, 10) },
                  { label: 'Decision', value: ({ p }) => { const d = DECISION[str(p.payload['decision'])]; return <Badge tone={d?.tone ?? 'gray'}>{d?.label ?? str(p.payload['decision'])}</Badge>; } },
                  { label: 'Company', value: ({ p }) => str(p.payload['name']) || '—' },
                  { label: 'Outcome', value: ({ p }) => `${p.status.toLowerCase()}${p.note ? ` — ${p.note}` : ''}` },
                ]}
              />
            </Card>
          </div>
        )}
      </div>
      <p className="muted">Signed buys and sells appear on <Link href="/approvals">Approvals</Link>, where you approve them and record the order you placed.</p>
    </>
  );
}
