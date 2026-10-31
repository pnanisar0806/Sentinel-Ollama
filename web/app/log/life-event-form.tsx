'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { EVENT_LABEL } from '../review-lines';

type Kind = 'SALARY_CHANGE' | 'JOB_LOSS' | 'NEW_DEPENDENT' | 'WINDFALL' | 'RETIREMENT_AGE' | 'MEDICAL_EXPENSE';
const KINDS = Object.keys(EVENT_LABEL) as Kind[];

type Msg = { ok: boolean; text: string } | null;

async function post(body: object): Promise<{ ok: boolean; text: string }> {
  const res = await fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json() as { message?: string; error?: string };
  return { ok: res.ok, text: json.message ?? json.error ?? `failed (${res.status})` };
}

/**
 * Batch C "Life event" tab: one form, fields per kind. An event leaves a review list on the
 * Overview and changes nothing by itself. A windfall is money received, so it hands off to that
 * tab prefilled rather than becoming an event. Live job losses and medical expenses are listed
 * with **Ended** (a dated second row; the IPS stop-event ends with it).
 */
export default function LifeEventForm({ today, endable, onWindfall }: {
  today: string;
  /** Live job losses / medical expenses, labelled by the page. */
  endable: { id: string; label: string; on: string }[];
  onWindfall: (prefill: Record<string, string>) => void;
}) {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>('SALARY_CHANGE');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Msg>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const target = e.currentTarget;
    const body = Object.fromEntries(new FormData(target).entries()) as Record<string, string>;
    if (kind === 'WINDFALL') { onWindfall({ rupees: body['rupees'] ?? '', from: body['from'] ?? '', on: body['on'] ?? today }); return; }
    setBusy(true);
    setMessage(null);
    const r = await post({ action: 'life_event', kind, ...body }).catch((err) => ({ ok: false, text: String(err) }));
    setMessage(r);
    setBusy(false);
    if (r.ok) { target.reset(); router.refresh(); }
  }

  const date = (label: string) => (
    <div className="field">
      <label htmlFor="on">{label}</label>
      <input id="on" name="on" type="date" max={today} defaultValue={today} required />
    </div>
  );
  const rupees = (label: string, help?: string) => (
    <div className="field">
      <label htmlFor="rupees">{label}</label>
      <input id="rupees" name="rupees" inputMode="decimal" required />
      {help ? <span className="help">{help}</span> : null}
    </div>
  );

  return (
    <div className="form">
      <p className="dim">
        Something changed in your life. Sentinel lists the numbers it touches on the Overview until you close each one;
        it never changes a number or pauses a SIP by itself.
      </p>
      <div className="tabs tabs-sm" role="radiogroup" aria-label="What changed?">
        {KINDS.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => { setKind(k); setMessage(null); }}>
            {EVENT_LABEL[k]}
          </button>
        ))}
      </div>

      <form className="form" onSubmit={submit} key={kind}>
        <div className="form-row">
          {kind === 'SALARY_CHANGE' && <>{rupees('New monthly take-home (₹)')}{date('Date it changed')}</>}
          {kind === 'JOB_LOSS' && (
            <>
              {date('Date it began')}
              <div className="field">
                <label htmlFor="expectedOn">Expected end (optional)</label>
                <input id="expectedOn" name="expectedOn" type="date" />
              </div>
            </>
          )}
          {kind === 'NEW_DEPENDENT' && (
            <>
              <div className="field">
                <label htmlFor="expectedOn">Expected date</label>
                <input id="expectedOn" name="expectedOn" type="date" required />
              </div>
              {date('Date you are logging it')}
            </>
          )}
          {kind === 'WINDFALL' && (
            <>
              {rupees('Amount (₹)')}
              <div className="field">
                <label htmlFor="from">From</label>
                <input id="from" name="from" maxLength={200} required placeholder="Inheritance" />
              </div>
              {date('Date received')}
            </>
          )}
          {kind === 'RETIREMENT_AGE' && (
            <>
              <div className="field">
                <label htmlFor="fiTargetAge">New FI target age</label>
                <input id="fiTargetAge" name="fiTargetAge" type="number" min={35} max={75} step={1} required />
              </div>
              {date('Date you decided')}
            </>
          )}
          {kind === 'MEDICAL_EXPENSE' && <>{rupees('Amount (₹)', 'Above ₹30,00,000 the IPS permits pausing SIPs; Sentinel only says so.')}{date('Date of the expense')}</>}
        </div>
        {kind === 'WINDFALL'
          ? <p className="dim">A windfall is money received: it is logged there, and the advisor proposes where it goes. It raises no review list.</p>
          : (
            <div className="field">
              <label htmlFor="note">Note</label>
              <input id="note" name="note" maxLength={500} />
            </div>
          )}
        <div className="btn-row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            {kind === 'WINDFALL' ? 'Log it as Money received' : 'Record it'}
          </button>
          {message ? <span role="status" className={message.ok ? 'result-ok' : 'result-err'}>{message.text}</span> : null}
        </div>
      </form>

      <h3 className="card-title" style={{ marginTop: 12 }}>In force</h3>
      {endable.length === 0
        ? <p className="dim">No job loss or medical expense is in force. One you log here is listed until you mark it ended.</p>
        : (
          <ul className="timeline">
            {endable.map((e) => (
              <li key={e.id}>
                <span className="tnum dim">{e.on}</span>
                <span>{e.label}</span>
                <EndControl id={e.id} today={today} since={e.on} />
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

function EndControl({ id, today, since }: { id: string; today: string; since: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Msg>(null);

  if (!open) return <span><button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>Ended</button></span>;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setMessage(null);
    const r = await post({ action: 'end_life_event', eventId: id, on: f.get('on'), note: f.get('note') }).catch((err) => ({ ok: false, text: String(err) }));
    setMessage(r);
    setBusy(false);
    if (r.ok) router.refresh();
  }

  return (
    <form className="btn-row" onSubmit={submit}>
      <label htmlFor={`end-on-${id}`} className="dim">Ended on</label>
      <input id={`end-on-${id}`} name="on" type="date" min={since} max={today} defaultValue={today} required />
      <label htmlFor={`end-note-${id}`} className="dim">Note</label>
      <input id={`end-note-${id}`} name="note" maxLength={500} placeholder="New job from Dec" />
      <button className="btn btn-sm btn-primary" type="submit" disabled={busy}>Mark ended</button>
      <button className="btn btn-sm" type="button" disabled={busy} onClick={() => { setOpen(false); setMessage(null); }}>Cancel</button>
      {message ? <span role="status" className={message.ok ? 'result-ok' : 'result-err'}>{message.text}</span> : null}
    </form>
  );
}
