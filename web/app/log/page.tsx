import Link from 'next/link';
import { getLog } from '../../lib/data';
import { Badge, Card, Notice, PageHead } from '../../lib/ui';
import type { Tone } from '../../lib/ui';
import LogForm from './log-form';

export const dynamic = 'force-dynamic';

const KIND_TONE: Record<string, Tone> = {
  Goal: 'green', Bond: 'amber', Milestone: 'indigo', Note: 'gray', RSU: 'indigo',
};

export default async function LogPage() {
  const { timeline, buckets, openMilestones, bonds } = await getLog();
  const today = new Date(Date.now() + 5.5 * 3_600_000).toISOString().slice(0, 10);

  return (
    <>
      <PageHead
        title="Log what I did"
        sub="Tell Sentinel what you did outside it — money moved into a goal, a bond that paid out, a milestone reached. Each entry is permanent and feeds the rest of the app."
      />

      <div className="bento">
        <div className="span-7">
          <Card title="Record something">
            <LogForm buckets={buckets} bonds={bonds} milestones={openMilestones} today={today} />
          </Card>
        </div>

        <div className="span-5">
          <Card title="Where other things go">
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.9 }}>
              <li>An order Sentinel proposed and you executed: mark it on <Link href="/approvals">Approvals</Link>.</li>
              <li>A new statement or cost basis: <Link href="/import">Import statements</Link>.</li>
              <li>An RSU vest: confirm it with the Telegram bot for now.</li>
              <li>A trade or fund switch you made yourself: log it under <em>Anything else</em>; your holdings update from the daily sync.</li>
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
                      <span>{e.summary}</span>
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
