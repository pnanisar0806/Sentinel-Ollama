import Link from 'next/link';
import { getCashflow } from '../../lib/data';
import { dayLabel, moneyOrUnknown, monthShort, paydayDueText } from '../../lib/cashflow';
import { Badge, Card, DataTable, Notice, PageHead, Stat } from '../../lib/ui';
import type { Cycle } from '../../../src/domain/cashflow.js';

export const dynamic = 'force-dynamic';

const m = moneyOrUnknown;

/** Average of known values over the last three cycles; null until three are known. */
function avg3(cycles: Cycle[], pick: (c: Cycle) => bigint | null): bigint | null {
  const last = cycles.slice(0, 3).map(pick);
  if (last.length < 3 || last.some((v) => v === null)) return null;
  return (last as bigint[]).reduce((s, v) => s + v, 0n) / 3n;
}

export default async function CashflowPage() {
  const { cycles, paydays, due } = await getCashflow();
  const latest = cycles[0] ?? null;
  const dueText = paydayDueText(due);
  const avgSurplus = avg3(cycles, (c) => c.surplusPaise);
  const avgSpend = avg3(cycles, (c) => c.spendPaise);

  return (
    <>
      <PageHead
        title="Cash flow"
        badge={<Badge tone="gray">{cycles.length} cycle{cycles.length === 1 ? '' : 's'}</Badge>}
        sub="Payday to payday: the salary, what else came in, what was invested, and what was spent. Built only from your payday entries and what Sentinel has recorded; nothing is modelled."
      />

      {dueText !== null && <Notice tone="indigo">{dueText} <Link href="/log?tab=payday">Enter it on Log</Link>.</Notice>}

      <div className="stats">
        <Stat label="Surplus, latest cycle" value={latest === null ? '—' : m(latest.surplusPaise)}
          sub={latest === null ? 'needs two paydays' : `${dayLabel(latest.from)} → ${dayLabel(latest.to)}`}
          tone={latest?.surplusPaise == null ? undefined : latest.surplusPaise < 0n ? 'red' : 'green'} />
        <Stat label="Spend, latest cycle" value={latest === null ? '—' : m(latest.spendPaise)}
          sub={latest === null ? 'needs two paydays' : 'everything that left HDFC and was not invested, set aside or loan principal'} />
        <Stat label="Average surplus" value={avgSurplus === null ? '—' : m(avgSurplus)}
          sub={avgSurplus === null ? 'needs 3 known cycles' : 'last 3 cycles'} />
        <Stat label="Average spend" value={avgSpend === null ? '—' : m(avgSpend)}
          sub={avgSpend === null ? 'needs 3 known cycles' : 'last 3 cycles'} />
      </div>

      <Card title="Cycles" aside="newest first">
        {cycles.length === 0
          ? (
            <Notice>
              {paydays.length === 0
                ? <>No payday entered yet. After the salary lands (usually the 2nd-last working day, next from {dayLabel(due.from)}), enter it under <Link href="/log?tab=payday">Payday</Link> on Log. An earlier payday can be entered too, from your HDFC app, so the first cycle shows sooner.</>
                : <>One payday entered ({dayLabel(paydays[0]!.on)}). The first cycle appears after the next one, due from {dayLabel(due.from)}.</>}
            </Notice>
          )
          : (
            <>
              <DataTable
                rows={cycles.map((c) => ({ ...c, key: `${c.from}-${c.to}` }))}
                rowTone={(c) => (c.surplusPaise !== null && c.surplusPaise < 0n ? 'red' : undefined)}
                cols={[
                  { label: 'Cycle', value: (c) => <span className="tnum">{dayLabel(c.from)} → {dayLabel(c.to)}</span> },
                  { label: 'Salary', align: 'right', value: (c) => m(c.salaryPaise) },
                  { label: 'Other in', align: 'right', value: (c) => m(c.otherInPaise) },
                  { label: 'Left HDFC', align: 'right', value: (c) => m(c.moneyOutPaise) },
                  { label: 'Invested', align: 'right', value: (c) => m(c.investedPaise) },
                  { label: 'Set aside', align: 'right', value: (c) => m(c.setAsidePaise) },
                  { label: 'Loan principal', align: 'right', value: (c) => m(c.loanPrincipalPaise) },
                  { label: 'Spend', align: 'right', value: (c) => m(c.spendPaise) },
                  { label: 'Surplus', align: 'right', value: (c) => <strong>{m(c.surplusPaise)}</strong> },
                ]}
              />
              {cycles.flatMap((c) => c.unknown.map((u) => (
                <Notice key={`${c.to}-${u}`} tone="amber">{dayLabel(c.from)} → {dayLabel(c.to)}: {u}.</Notice>
              )))}
            </>
          )}
      </Card>

      <div className="bento">
        <div className="span-7">
          <Card title="How it is worked out">
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
              <li><strong>Left HDFC</strong> = the balance after the first salary + other money in − the balance just before the next salary (that entry&apos;s balance minus its salary).</li>
              <li><strong>Other in</strong>: Money received logged on Log, sale proceeds kept in the bank, and bond redemptions. Money received that came from a sale or redemption is counted once.</li>
              <li><strong>Invested</strong>: the month&apos;s SIP instalments (frozen when the payday was entered), purchases logged on Log, and orders Sentinel proposed once marked executed.</li>
              <li><strong>Set aside</strong>: money moved into a goal, logged on Log as a monthly surplus or transfer.</li>
              <li><strong>Loan principal</strong>: the fall in your loan balances from INDmoney between the two paydays.</li>
              <li><strong>Spend</strong> is the rest: card bills paid, EMI interest, and everything else. <strong>Surplus</strong> = salary + other in − spend.</li>
            </ul>
          </Card>
        </div>
        <div className="span-5">
          <Card title="What it cannot see">
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
              <li>Only HDFC is tracked. Money moved to any other account (SBI included) counts as spend.</li>
              <li>A card bill paid in a cycle is the previous cycle&apos;s spending; over three cycles that evens out.</li>
              <li>A day&apos;s entries on the first payday are taken as before that balance; on the last payday, as within the cycle.</li>
              <li>Sales made through Approvals are not counted as money in yet.</li>
              <li>An unknown input makes spend and surplus unknown, never ₹0.</li>
            </ul>
          </Card>
        </div>
      </div>

      <Card title="Payday entries" aside={`${paydays.length}`}>
        {paydays.length === 0
          ? <Notice>None yet.</Notice>
          : (
            <DataTable
              rows={[...paydays].reverse().map((p) => ({ ...p, key: p.id }))}
              cols={[
                { label: 'Payday', value: (p) => <span className="tnum">{p.on}</span> },
                { label: 'Salary', align: 'right', value: (p) => m(p.salaryPaise) },
                { label: 'HDFC after', align: 'right', value: (p) => m(p.balancePaise) },
                { label: 'SIPs that month', align: 'right', value: (p) => (p.sipsMonth === null ? 'unknown' : `${m(p.sipsPaise)} (${monthShort(p.sipsMonth)})`) },
              ]}
            />
          )}
        <p className="dim" style={{ marginBottom: 0 }}>A wrong entry is reversed on the <Link href="/log">Log</Link> timeline, then entered again.</p>
      </Card>
    </>
  );
}
