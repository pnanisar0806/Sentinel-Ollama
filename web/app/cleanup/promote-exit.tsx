'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Turns one exit candidate into an FR-11 recommendation.
 *
 * Deliberately a button and not an automatic step: promotion spends one of FR-12's four
 * recommendation slots for the month, and a standing breach re-fires every month — so
 * promoting automatically would burn the budget on an unchanged fact. The candidate is
 * re-derived server side, so a stale page cannot promote a trigger that has stopped
 * firing.
 */
export default function PromoteExit(
  { instrumentId, trigger, blocked }: { instrumentId: string; trigger: string; blocked: boolean },
) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (blocked) {
    return (
      <span className="dim" title="IPS §3.7 minimum holding period">
        held
      </span>
    );
  }

  async function promote() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/exits/promote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instrumentId, trigger }),
      });
      const body = await res.json() as { reason?: string; error?: string; id?: number | null };
      if (res.ok) {
        setMessage(`recommendation #${body.id}`);
        router.refresh();
      } else {
        // The FR-12 cap and the already-promoted guard both land here. Say which.
        setMessage(body.reason ?? body.error ?? `failed (${res.status})`);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="btn btn-sm" onClick={promote} disabled={busy}>
        {busy ? 'Promoting…' : 'Recommend'}
      </button>
      {message ? <div className="dim" style={{ marginTop: 4 }}>{message}</div> : null}
    </>
  );
}
