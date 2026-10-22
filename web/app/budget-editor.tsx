'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { InvestmentControls } from '../lib/data';
import { formatRailValue, parseRailInput, railInputValue, railShortLabel, RAIL_LABELS } from '../lib/rail-form';
import { fmtDateTime } from '../lib/format';

export default function BudgetEditor({ controls, budgetOnly = false }: {
  controls: InvestmentControls;
  budgetOnly?: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const keys = budgetOnly ? ['monthly_budget_paise'] : Object.keys(RAIL_LABELS);
  const [key, setKey] = useState(keys[0]!);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const current = controls.values[key];
  const pending = controls.pending.filter((change) => keys.includes(change.key));
  let parsed: number | null = null;
  let error = '';
  if (value !== '') {
    try { parsed = parseRailInput(key, value); }
    catch (e) { error = e instanceof Error ? e.message : 'Invalid value.'; }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (parsed === null || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/controls', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'propose_rail', key, value: parsed }),
      });
      const result = await response.json() as { error?: string };
      setMessage({ ok: response.ok, text: response.ok
        ? `${railShortLabel(key)} change scheduled. The current limit stays in effect until the 48-hour wait and activation checks complete.`
        : result.error ?? 'Could not schedule this change.' });
      if (response.ok) { setValue(''); router.refresh(); }
    } catch {
      setMessage({ ok: false, text: 'Could not confirm the change. Refresh to check pending changes before trying again.' });
    } finally { setBusy(false); }
  }

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/controls', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm_budget' }),
      });
      const result = await response.json() as { message?: string; error?: string };
      setMessage({ ok: response.ok, text: result.message ?? result.error ?? `failed (${response.status})` });
      if (response.ok) router.refresh();
    } catch {
      setMessage({ ok: false, text: 'Could not confirm the budget. Refresh to check before trying again.' });
    } finally { setBusy(false); }
  }

  const month = controls.budgetMonth;
  const budget = controls.values.monthly_budget_paise;
  // A pending budget change holds the advisor whatever is confirmed, so the button would mislead.
  const budgetPending = controls.pending.some((c) => c.key === 'monthly_budget_paise' || c.key === 'tactical_monthly_paise');

  return (
    <div className="investment-editor">
      {budgetOnly && <div className="btn-row" style={{ alignItems: 'center' }}>
        {month.settled
          ? <span className="dim">{month.confirmedOn ? `This month's budget is settled (${month.confirmedOn}).` : "This month's budget is settled: the advisor runs on the budget in force."}</span>
          : budgetPending || budget === undefined
            ? <span className="dim">Advisor waiting: {month.reason}.</span>
            : <>
              <button className="btn btn-primary" type="button" disabled={busy} onClick={confirm}>
                Keep {formatRailValue('monthly_budget_paise', budget)} this month
              </button>
              <span className="dim">No change, so no 48-hour wait: the advisor runs at the next weekly report. Otherwise it waits until the 7th.</span>
            </>}
      </div>}
      <p className="dim">Every edit waits 48 hours. Increases are refused above 15% drawdown, both now and at activation.</p>
      {budgetOnly && <p className="dim">
        The budget includes SIPs. What you may invest beyond them is the smaller of budget − SIPs and the
        separate tactical cap (currently {controls.values.tactical_monthly_paise === undefined ? 'unknown'
          : formatRailValue('tactical_monthly_paise', controls.values.tactical_monthly_paise)}), which caps
        non-SIP buys and never adds to the budget. Change the tactical cap on Cleanup.
      </p>}
      <form onSubmit={submit} className="control-form">
        <div className="control-field">
          <label htmlFor={`${id}-limit`}>Investment limit</label>
          <select id={`${id}-limit`} value={key} disabled={busy} onChange={(event) => { setKey(event.target.value); setValue(''); setMessage(null); }}>
            {keys.map((item) => <option key={item} value={item}>{RAIL_LABELS[item]}</option>)}
          </select>
          <span className="dim">Current: <strong className="tnum">{current === undefined ? 'unknown' : formatRailValue(key, current)}</strong></span>
        </div>
        <div className="control-field">
          <label htmlFor={`${id}-value`}>New {key.endsWith('_paise') ? 'amount (₹)' : 'percentage (%)'}</label>
          <input id={`${id}-value`} value={value} inputMode="decimal" disabled={busy}
            placeholder={current === undefined ? '' : railInputValue(key, current)}
            aria-invalid={error !== ''} aria-describedby={`${id}-hint`}
            onChange={(event) => setValue(event.target.value)} />
          <span id={`${id}-hint`} className={error ? 'tone-red' : 'dim'}>{error || (parsed === null ? 'Enter the new value to schedule a change.' : `Proposed: ${formatRailValue(key, parsed)}`)}</span>
        </div>
        <button className="btn" disabled={busy || parsed === null || parsed === current} type="submit">{busy ? 'Scheduling…' : 'Schedule change'}</button>
      </form>
      {message && <p role="status" className={message.ok ? 'tone-green' : 'tone-red'}>{message.text}</p>}
      {/* /cleanup already lists every pending rail change; only Overview needs its own. */}
      {budgetOnly && <div className="control-pending">
        <strong>Pending changes</strong>
        {pending.length === 0 ? <p className="dim">No changes scheduled.</p> : pending.map((change) => (
          <div className="control-pending-row" key={change.key}>
            <span>{RAIL_LABELS[change.key] ?? change.key}</span>
            <strong className="tnum">{formatRailValue(change.key, change.current)} → {formatRailValue(change.key, change.proposed)}</strong>
            <span className="dim">Eligible {fmtDateTime(change.activatesAt)} · awaiting activation checks</span>
          </div>
        ))}
      </div>}
    </div>
  );
}
