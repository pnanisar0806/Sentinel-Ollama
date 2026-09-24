'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Freeze, unfreeze, breaker reset and rail changes.
 *
 * Unfreeze and reset take a typed phrase: a tap is not a decision. Both are checked
 * server-side in the domain, so this form cannot be talked past.
 */
const RAIL_KEYS = [
  'max_order_paise', 'tactical_monthly_paise', 'cash_ceiling_pct', 'single_stock_cap_pct',
  'employer_cap_pct', 'mf_scheme_cap_pct', 'sector_cap_pct', 'issuer_cap_pct',
];

export default function ControlsPanel(
  { frozen, breakerTripped }: { frozen: boolean; breakerTripped: boolean },
) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [railKey, setRailKey] = useState(RAIL_KEYS[0]!);
  const [railValue, setRailValue] = useState('');

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
      if (res.ok) { setTyped(''); setReason(''); setRailValue(''); router.refresh(); }
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

      <label className="dim">
        Change a rail. It takes effect after 48 hours; a loosening is refused above 15%
        drawdown, at proposal and again when it would take effect.
        <select style={field} value={railKey} onChange={(e) => setRailKey(e.target.value)}>
          {RAIL_KEYS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <input style={field} value={railValue} inputMode="numeric" placeholder="new value"
          onChange={(e) => setRailValue(e.target.value)} />
        <button className="btn" style={{ marginTop: 6 }} disabled={busy || railValue === ''}
          onClick={() => send({ action: 'propose_rail', key: railKey, value: Number(railValue) })}>
          Propose change
        </button>
      </label>

      {message !== null && (
        <p className={message.ok ? 'tone-green' : 'tone-red'} role="status" style={{ whiteSpace: 'pre-wrap' }}>
          {message.text}
        </p>
      )}
    </div>
  );
}
