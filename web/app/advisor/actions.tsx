'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

async function post(body: object): Promise<{ ok: boolean; text: string }> {
  const res = await fetch('/api/advisor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json() as { message?: string; error?: string };
  return { ok: res.ok, text: json.message ?? json.error ?? `failed (${res.status})` };
}

/** Sign or dismiss one piece of advice. Signing a BUY creates an approval request, not an order. */
export function AdviceActions({ id, decision }: { id: number; decision: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (body: object) => {
    setBusy(true); setMsg(null);
    const r = await post(body).catch((e) => ({ ok: false, text: String(e) }));
    setMsg(r); setBusy(false);
    if (r.ok) router.refresh();
  };
  const actionable = decision === 'BUY' || decision === 'SELL';
  return (
    <div className="form" style={{ gap: 10 }}>
      <div className="btn-row">
        <button className="btn btn-primary" disabled={busy} onClick={() => run({ action: 'sign', proposalId: id })}>
          {actionable ? 'Sign — send to Approvals' : `Accept ${decision.toLowerCase()}`}
        </button>
        <button className="btn" disabled={busy} onClick={() => setDismissing(!dismissing)}>Dismiss</button>
      </div>
      {dismissing && (
        <div className="form-row">
          <div className="field">
            <label htmlFor={`why-${id}`}>Why dismiss it?</label>
            <input id={`why-${id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. not convinced by the valuation" />
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-danger" disabled={busy || reason.trim() === ''} onClick={() => run({ action: 'dismiss', proposalId: id, reason })}>Confirm dismiss</button>
          </div>
        </div>
      )}
      {msg ? <span role="status" className={msg.ok ? 'result-ok' : 'result-err'}>{msg.text}</span> : null}
    </div>
  );
}

/** Accept or decline one line of the quarterly watchlist revision. */
export function LineActions({ id, line }: { id: number; line: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (accept: boolean) => {
    setBusy(true); setMsg(null);
    const r = await post({ action: 'watchlist', proposalId: id, line, accept }).catch((e) => ({ ok: false, text: String(e) }));
    setMsg(r); setBusy(false);
    if (r.ok) router.refresh();
  };
  return (
    <span className="btn-row">
      <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(true)}>Accept</button>
      <button className="btn btn-sm" disabled={busy} onClick={() => run(false)}>Decline</button>
      {msg && !msg.ok ? <span role="status" className="result-err">{msg.text}</span> : null}
    </span>
  );
}
