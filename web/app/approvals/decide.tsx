'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * The owner's buttons for one approval request. What is offered follows the request's
 * state: approve / defer / reject while it waits; then "I've placed it" once approved;
 * then "Done" or "Didn't go through" once placed. Nothing executes from here —
 * Sentinel records what the owner decided and did.
 */
export default function Decide({ id, status, today }: { id: string; status: string; today: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'none' | 'reject' | 'defer'>('none');
  const [reason, setReason] = useState('');
  const [deferUntil, setDeferUntil] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function act(action: string, body: Record<string, string> = {}) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/approvals/${id}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const json = await res.json() as { status?: string; error?: string };
      setMessage({ ok: res.ok, text: res.ok ? `Recorded — now ${json.status?.toLowerCase().replace(/_/g, ' ')}.` : json.error ?? `failed (${res.status})` });
      if (res.ok) { setMode('none'); router.refresh(); }
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const waiting = status === 'PENDING_APPROVAL' || status === 'MODIFIED';
  return (
    <div className="form" style={{ gap: 10 }}>
      <div className="btn-row">
        {waiting && (
          <>
            <button className="btn btn-primary" disabled={busy} onClick={() => act('approve')}>Approve</button>
            <button className="btn" disabled={busy} onClick={() => setMode(mode === 'defer' ? 'none' : 'defer')}>Defer</button>
            <button className="btn btn-danger" disabled={busy} onClick={() => setMode(mode === 'reject' ? 'none' : 'reject')}>Reject</button>
          </>
        )}
        {status === 'DEFERRED' && (
          <button className="btn btn-danger" disabled={busy} onClick={() => setMode(mode === 'reject' ? 'none' : 'reject')}>Reject</button>
        )}
        {status === 'ACKNOWLEDGED' && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act('placing')}>I&apos;ve placed the order</button>
        )}
        {status === 'AWAITING_MANUAL_EXECUTION' && (
          <>
            <button className="btn btn-primary" disabled={busy} onClick={() => act('done')}>Done — it went through</button>
            <button className="btn btn-danger" disabled={busy} onClick={() => act('abandon')}>It didn&apos;t go through</button>
          </>
        )}
      </div>

      {mode === 'reject' && (
        <div className="form-row">
          <div className="field">
            <label htmlFor={`reason-${id}`}>Why reject it?</label>
            <input id={`reason-${id}`} value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. trimming for a 0.7% overshoot is churn" />
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-danger" disabled={busy || reason.trim() === ''} onClick={() => act('reject', { reason })}>Confirm reject</button>
          </div>
        </div>
      )}
      {mode === 'defer' && (
        <div className="form-row">
          <div className="field">
            <label htmlFor={`defer-${id}`}>Remind me on</label>
            <input id={`defer-${id}`} type="date" min={today} value={deferUntil} onChange={(e) => setDeferUntil(e.target.value)} />
          </div>
          <div className="field" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" disabled={busy || deferUntil === ''} onClick={() => act('defer', { deferUntil })}>Confirm defer</button>
          </div>
        </div>
      )}
      {message ? <span role="status" className={message.ok ? 'result-ok' : 'result-err'}>{message.text}</span> : null}
    </div>
  );
}
