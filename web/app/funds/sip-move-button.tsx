'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The switch check's SIP answer, acted on in place: "Done" logs the SIP move /log would
 * (same domain checks), "Undo" reverses it. The owner still changes the SIP in INDmoney.
 */
export function SipMoveButton(p:
  | { kind: 'move'; fromId: string; toId: string; rupees: string; today: string; months: { value: string; label: string }[] }
  | { kind: 'moved'; moveId: string }) {
  const router = useRouter();
  const [month, setMonth] = useState(p.kind === 'move' ? p.months[p.months.length - 1]!.value : '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async () => {
    setBusy(true); setMsg(null);
    const body = p.kind === 'move'
      ? { action: 'sip_move', on: p.today, fromInstrumentId: p.fromId, toInstrumentId: p.toId, rupees: p.rupees, firstMonth: month, note: 'from the /funds switch check' }
      : { action: 'reverse', entity: 'sip_move', entityId: p.moveId, reason: 'undone on /funds' };
    const r = await fetch('/api/log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (res) => {
      const json = await res.json() as { message?: string; error?: string };
      return { ok: res.ok, text: json.message ?? json.error ?? `failed (${res.status})` };
    }).catch((e) => ({ ok: false, text: String(e) }));
    setMsg(r); setBusy(false);
    if (r.ok) router.refresh();
  };
  return (
    <div className="btn-row" style={{ marginTop: 6 }}>
      {p.kind === 'move' ? (
        <>
          <label className="dim" htmlFor={`first-${p.fromId}`}>first SIP in</label>
          <select id={`first-${p.fromId}`} value={month} disabled={busy} onChange={(e) => setMonth(e.target.value)}>
            {p.months.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
          <button className="btn btn-primary btn-sm" type="button" disabled={busy} onClick={run}>{busy ? 'Saving…' : 'Done'}</button>
        </>
      ) : (
        <button className="btn btn-sm" type="button" disabled={busy} onClick={run}>{busy ? 'Undoing…' : 'Undo'}</button>
      )}
      {msg && !msg.ok ? <span role="status" className="result-err">{msg.text}</span> : null}
    </div>
  );
}
