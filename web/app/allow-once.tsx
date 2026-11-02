'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export type Msg = { ok: boolean; text: string } | null;

/** POST /api/log; the server's message verbatim, or its error. */
export async function postLog(body: object): Promise<{ ok: boolean; text: string }> {
  const res = await fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json() as { message?: string; error?: string };
  return { ok: res.ok, text: json.message ?? json.error ?? `failed (${res.status})` };
}

/**
 * Batch C "Allow once": breaks a holding rule once, for one IST month or one lump sum, with a
 * required note. The rule stays on; the next advice run (or a reload of /funds) uses it.
 */
export function AllowOnce({ ruleId, month, lumpSumId, scope }: {
  ruleId: string;
  /** Exactly one of month / lumpSumId. */
  month?: string; lumpSumId?: string;
  /** "for Nov 2026", "for this lump sum". */
  scope: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const id = `allow-${ruleId}-${month ?? lumpSumId}`;

  if (!open) {
    return <div className="rule-ctl"><button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>Allow once</button></div>;
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const note = String(new FormData(e.currentTarget).get('note') ?? '');
    setBusy(true); setMsg(null);
    const r = await postLog({ action: 'rule_exception', ruleId, note, ...(lumpSumId ? { lumpSumId } : { month }) })
      .catch((err) => ({ ok: false, text: String(err) }));
    setMsg(r); setBusy(false);
    if (r.ok) router.refresh();
  }

  return (
    <form className="rule-ctl" onSubmit={submit}>
      <div className="field">
        <label htmlFor={id}>Why break it {scope}?</label>
        <input id={id} name="note" maxLength={500} required placeholder="One more top-up before the switch" />
      </div>
      <div className="btn-row">
        <button className="btn btn-sm btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : `Allow ${scope}`}</button>
        <button className="btn btn-sm" type="button" disabled={busy} onClick={() => { setOpen(false); setMsg(null); }}>Cancel</button>
      </div>
      {msg ? <span role="status" className={msg.ok ? 'result-ok' : 'result-err'}>{msg.text}</span> : null}
    </form>
  );
}
