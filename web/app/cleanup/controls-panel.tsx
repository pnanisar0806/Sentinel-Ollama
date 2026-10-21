'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Freeze, unfreeze and breaker reset. Rail changes are entered in rupees on BudgetEditor.
 *
 * Unfreeze and reset take a typed phrase: a tap is not a decision. Both are checked
 * server-side in the domain, so this form cannot be talked past.
 */
export default function ControlsPanel(
  { frozen, breakerTripped }: { frozen: boolean; breakerTripped: boolean },
) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/controls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json() as { message?: string; error?: string };
      setMessage({ ok: res.ok, text: json.message ?? json.error ?? `failed (${res.status})` });
      if (res.ok) { setTyped(''); setReason(''); router.refresh(); }
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const field = { display: 'block', width: '100%', marginTop: 4 } as const;

  return (
    <div className="stack" style={{ gap: 14 }}>
      {!frozen ? (
        <label className="dim">
          Freeze: halts drafting and cancels every open request
          <input style={field} value={reason} placeholder="reason"
            onChange={(e) => setReason(e.target.value)} />
          <button className="btn btn-danger" style={{ marginTop: 6 }}
            disabled={busy || reason.trim() === ''}
            onClick={() => send({ action: 'freeze', reason })}>Freeze</button>
        </label>
      ) : (
        <label className="dim">
          Type UNFREEZE to lift the freeze. Cancelled requests are not revived.
          <input style={field} value={typed} onChange={(e) => setTyped(e.target.value)} />
          <button className="btn" style={{ marginTop: 6 }} disabled={busy || typed === ''}
            onClick={() => send({ action: 'unfreeze', typed })}>Unfreeze</button>
        </label>
      )}

      {breakerTripped && (
        <label className="dim">
          Type RESET BREAKER to reset. The post-mortem is written from the record.
          <input style={field} value={typed} onChange={(e) => setTyped(e.target.value)} />
          <button className="btn" style={{ marginTop: 6 }} disabled={busy || typed === ''}
            onClick={() => send({ action: 'reset_breaker', typed })}>Reset breaker</button>
        </label>
      )}

      {message !== null && (
        <p className={message.ok ? 'tone-green' : 'tone-red'} role="status" style={{ whiteSpace: 'pre-wrap' }}>
          {message.text}
        </p>
      )}
    </div>
  );
}
