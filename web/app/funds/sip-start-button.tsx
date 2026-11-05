'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postLog, type Msg } from '../allow-once';

/**
 * Suggested SIPs (spec 2026-11-03 Part B): "Started" logs a new SIP the owner set up in INDmoney
 * (same domain checks as /log "Start a new SIP"); "Undo" reverses it. It counts from its first
 * month until the feed lists the fund.
 */
export function SipStartButton(p:
  | { kind: 'start'; instrumentId: string; fundName: string; rupees: string; today: string; months: { value: string; label: string }[] }
  | { kind: 'started'; startId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(p.kind === 'start' ? p.months[p.months.length - 1]!.value : '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const send = async (body: object) => {
    setBusy(true); setMsg(null);
    const r = await postLog(body).catch((e) => ({ ok: false, text: String(e) }));
    setMsg(r); setBusy(false);
    if (r.ok) { setOpen(false); router.refresh(); }
  };

  if (p.kind === 'started') {
    return (
      <div className="rule-ctl">
        <button className="btn btn-sm" type="button" disabled={busy}
          onClick={() => send({ action: 'reverse', entity: 'sip_start', entityId: p.startId, reason: 'undone on /funds' })}>
          {busy ? 'Undoing…' : 'Undo'}
        </button>
        {msg && !msg.ok ? <span role="status" className="result-err">{msg.text}</span> : null}
      </div>
    );
  }
  if (!open) return <div className="rule-ctl"><button className="btn btn-sm" type="button" onClick={() => setOpen(true)}>Started</button></div>;

  const id = `start-${p.instrumentId}`;
  return (
    <form className="rule-ctl" onSubmit={(e) => {
      e.preventDefault();
      const rupees = String(new FormData(e.currentTarget).get('rupees') ?? '');
      void send({ action: 'sip_start', on: p.today, instrumentId: p.instrumentId, rupees, firstMonth: month, note: 'from the /funds Suggested SIPs card' });
    }}>
      <div className="field">
        <label htmlFor={id}>Monthly SIP in {p.fundName} (₹)</label>
        <input id={id} name="rupees" inputMode="decimal" defaultValue={p.rupees} required />
      </div>
      <span className="dim" id={`${id}-m`}>first SIP in</span>
      <div className="tabs tabs-sm" role="radiogroup" aria-labelledby={`${id}-m`}>
        {p.months.map((m) => (
          <button key={m.value} type="button" role="radio" aria-checked={month === m.value} disabled={busy} onClick={() => setMonth(m.value)}>
            {m.label}
          </button>
        ))}
      </div>
      <div className="btn-row">
        <button className="btn btn-sm btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Log it'}</button>
        <button className="btn btn-sm" type="button" disabled={busy} onClick={() => { setOpen(false); setMsg(null); }}>Cancel</button>
      </div>
      {msg && !msg.ok ? <span role="status" className="result-err">{msg.text}</span> : null}
    </form>
  );
}
