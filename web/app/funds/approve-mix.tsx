'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Signs the proposed range table whole; the band is the one this page showed. */
export function ApproveMix({ band, label }: { band: '15+' | '7-15'; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async () => {
    setBusy(true); setMsg(null);
    const r = await fetch('/api/funds', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'approve', band }),
    }).then(async (res) => {
      const json = await res.json() as { message?: string; error?: string };
      return { ok: res.ok, text: json.message ?? json.error ?? `failed (${res.status})` };
    }).catch((e) => ({ ok: false, text: String(e) }));
    setMsg(r); setBusy(false);
    if (r.ok) router.refresh();
  };
  return (
    <div className="form" style={{ gap: 6 }}>
      <div className="btn-row"><button className="btn btn-primary" type="button" disabled={busy} onClick={run}>{busy ? 'Signing…' : label}</button></div>
      {msg ? <span role="status" className={msg.ok ? 'result-ok' : 'result-err'}>{msg.text}</span> : null}
    </div>
  );
}
