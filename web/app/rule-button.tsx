'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postLog, type Msg } from './allow-once';

type Kind = 'NO_ADD' | 'HOLD_UNTIL' | 'NO_REBUY' | 'CAP_PCT';
const KINDS: { id: Kind; label: string; help: string }[] = [
  { id: 'NO_ADD', label: 'No new money', help: 'No SIP money, top-up or lump sum goes into it. What you hold stays.' },
  { id: 'HOLD_UNTIL', label: 'Hold until', help: 'Nothing proposes selling it before the date. Exit signals still show, as a warning.' },
  { id: 'NO_REBUY', label: 'Never buy again', help: 'Once you hold none of it, nothing proposes buying it back.' },
  { id: 'CAP_PCT', label: 'Cap at %', help: 'No buy may take it above this share of the portfolio.' },
];

/**
 * Batch C: put a holding rule on one fund or stock, inline. A rule only refuses advice; it never
 * sells, pauses a SIP or changes a rail. Validation is the domain's (logHoldingRule).
 */
export function RuleButton({ instrumentId, name, today }: { instrumentId: string; name: string; today: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>('NO_ADD');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const id = (f: string) => `rule-${f}-${instrumentId}`;

  if (!open) {
    return <div className="rule-ctl"><button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>Add rule</button></div>;
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<string, string>;
    setBusy(true); setMsg(null);
    const r = await postLog({ action: 'holding_rule', on: today, instrumentId, kind, ...f }).catch((err) => ({ ok: false, text: String(err) }));
    setMsg(r); setBusy(false);
    if (r.ok) { setOpen(false); router.refresh(); }
  }

  // A hold-until date must be after today (IST); the domain says so too.
  const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return (
    <form className="rule-ctl" onSubmit={submit} aria-label={`Rule on ${name}`}>
      <div className="tabs tabs-sm" role="radiogroup" aria-label={`Rule on ${name}`}>
        {KINDS.map((k) => (
          <button key={k.id} type="button" role="radio" aria-checked={kind === k.id} disabled={busy} onClick={() => { setKind(k.id); setMsg(null); }}>
            {k.label}
          </button>
        ))}
      </div>
      <span className="dim">{KINDS.find((k) => k.id === kind)!.help}</span>
      {kind === 'HOLD_UNTIL' && (
        <div className="field">
          <label htmlFor={id('until')}>Hold until</label>
          <input id={id('until')} name="untilOn" type="date" min={tomorrow} required />
        </div>
      )}
      {kind === 'CAP_PCT' && (
        <div className="field">
          <label htmlFor={id('cap')}>Cap (% of the portfolio)</label>
          <input id={id('cap')} name="capPct" inputMode="decimal" pattern="\d{1,3}(\.\d{1,2})?" required placeholder="12.5" />
        </div>
      )}
      <div className="field">
        <label htmlFor={id('note')}>Note (optional)</label>
        <input id={id('note')} name="note" maxLength={500} placeholder="Switching out of it" />
      </div>
      <div className="btn-row">
        <button className="btn btn-sm btn-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save rule'}</button>
        <button className="btn btn-sm" type="button" disabled={busy} onClick={() => { setOpen(false); setMsg(null); }}>Cancel</button>
      </div>
      {msg && !msg.ok ? <span role="status" className="result-err">{msg.text}</span> : null}
    </form>
  );
}
