import Link from 'next/link';
import { formatInr, type Paise } from '../../../src/money/paise.js';
import { getLog, getSipMoveOptions } from '../../lib/data';
import { canReverse } from '../../lib/log';
import { Badge, Card, Notice, PageHead } from '../../lib/ui';
import type { Tone } from '../../lib/ui';
import LogForm, { ReverseControl } from './log-form';

export const dynamic = 'force-dynamic';

const KIND_TONE: Record<string, Tone> = {
  Goal: 'green', Purchase: 'indigo', Bond: 'amber', Milestone: 'indigo', Note: 'gray', RSU: 'indigo',
  Earmark: 'green', Spend: 'amber', Sale: 'indigo', SIP: 'indigo', 'SIP move': 'indigo', 'Lump sum': 'green',
};

const inr = (p: bigint) => formatInr(p as Paise);

export default async function LogPage() {
  const { timeline, buckets, openMilestones, bonds, holdings, sellable, pots, spLabels, idleBankCashPaise, openLumpSums } = await getLog();
  const sipMoves = await getSipMoveOptions();
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

  return (
    <>
      <PageHead
        title="Log what I did"
        sub="Tell Sentinel what you did outside it — money moved into a goal or set aside, money spent, a sale, a purchase, a bond that paid out, a milestone reached. Entries are never edited; a mistake is reversed and logged again."
      />

      <div className="bento">
        <div className="span-7">
          <Card title="Record something">
            <LogForm
              buckets={buckets} bonds={bonds} holdings={holdings} milestones={openMilestones} today={today} sellable={sellable}
              pots={pots.map((p) => ({ id: p.id, name: p.name, held: p.balancePaise === null ? 'nothing logged' : inr(p.balancePaise) }))}
              spLabels={spLabels.map((l) => ({ label: l.label, held: inr(l.balancePaise) }))}
              idleCash={idleBankCashPaise === null ? 'unknown' : inr(idleBankCashPaise)}
              sipMoves={sipMoves}
              lumpSums={openLumpSums.map((l) => ({ id: l.id, label: `${l.from} · ${inr(l.remainingPaise)} left` }))}
            />
          </Card>
        </div>

        <div className="span-5">
          <Card title="Where other things go">
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
              <li>An order Sentinel proposed and you executed: mark it on <Link href="/approvals">Approvals</Link>.</li>
              <li>A new statement or cost basis: <Link href="/import">Import statements</Link>.</li>
              <li>An RSU vest: confirm it with the Telegram bot for now.</li>
              <li>A buy you made yourself: log it under <em>Purchase outside Sentinel</em> so it counts against the month; your holdings update from the daily sync.</li>
              <li>A sale or redemption you made yourself: <em>A sale I made</em>. A fund switch is a sale plus a purchase.</li>
              <li>A monthly SIP moved to another fund in the same category: <em>Move a SIP</em>.</li>
              <li>Money you want invested on top of the month, like bond interest: <em>Money received</em>. A buy paid from it says so under <em>Purchase outside Sentinel</em>.</li>
              <li>A wrong entry: <em>Reverse</em> it on the timeline below, then log the right one.</li>
            </ul>
          </Card>
        </div>

        <div className="span-12">
          <Card title="What you have told Sentinel" aside={`${timeline.length} entr${timeline.length === 1 ? 'y' : 'ies'}`}>
            {timeline.length === 0
              ? <Notice>Nothing recorded yet. Entries you add above appear here, newest first.</Notice>
              : (
                <ul className="timeline">
                  {timeline.map((e) => (
                    <li key={e.key}>
                      <span className="tnum dim">{e.on}</span>
                      <span><Badge tone={KIND_TONE[e.kind] ?? 'gray'}>{e.kind}</Badge></span>
                      <span>
                        {e.reversed
                          ? <><del className="dim">{e.summary}</del> <Badge tone="gray">reversed on {e.reversed.on}: {e.reversed.reason}</Badge></>
                          : e.summary}
                        {canReverse(e) ? <><br /><ReverseControl entity={e.reversible!.entity} entityId={e.reversible!.entityId} summary={e.summary} /></> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
          </Card>
        </div>
      </div>
    </>
  );
}
