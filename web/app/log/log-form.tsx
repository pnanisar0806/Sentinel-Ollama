'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Tab = 'goal' | 'bond' | 'milestone' | 'note';

const TABS: { id: Tab; label: string }[] = [
  { id: 'goal', label: 'Money into a goal' },
  { id: 'bond', label: 'Bond matured' },
  { id: 'milestone', label: 'Milestone done' },
  { id: 'note', label: 'Anything else' },
];

/**
 * One form per kind of thing the owner did. Validation is server-side in the domain;
 * this only gathers the fields and reports what the server said.
 */
export default function LogForm({ buckets, bonds, milestones, today }: {
  buckets: { id: string; name: string }[];
  bonds: { id: string; name: string }[];
  milestones: { id: string; name: string }[];
  today: string;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('goal');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = Object.fromEntries(form.entries());
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/log', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: tab, ...body }),
      });
      const json = await res.json() as { message?: string; error?: string };
      setMessage({ ok: res.ok, text: json.message ?? json.error ?? `failed (${res.status})` });
      if (res.ok) { (e.target as HTMLFormElement).reset(); router.refresh(); }
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  const date = (
    <div className="field">
      <label htmlFor="on">Date it happened</label>
      <input id="on" name="on" type="date" max={today} defaultValue={today} required />
    </div>
  );

  return (
    <div className="form">
      <div className="tabs" role="tablist" aria-label="What did you do?">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id}
            onClick={() => { setTab(t.id); setMessage(null); }}>
            {t.label}
          </button>
        ))}
      </div>

      <form className="form" onSubmit={submit} key={tab}>
        {tab === 'goal' && (
          <>
            <div className="form-row">
              <div className="field">
                <label htmlFor="bucketId">Goal</label>
                <select id="bucketId" name="bucketId" required>
                  {buckets.map((b) => <option key={b.id} value={b.id}>{b.id} — {b.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="kind">Where the money came from</label>
                <select id="kind" name="kind" required>
                  <option value="sip">Monthly surplus / transfer</option>
                  <option value="maturity">A bond or deposit that matured</option>
                  <option value="vest">An RSU vest</option>
                  <option value="withdrawal">Money taken OUT of this goal</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="rupees">Amount (₹)</label>
                <input id="rupees" name="rupees" inputMode="decimal" placeholder="324300" required />
              </div>
              {date}
            </div>
            <div className="field">
              <label htmlFor="note">Note</label>
              <input id="note" name="note" placeholder="Sammaan 2026 proceeds into IDFC First savings" />
            </div>
          </>
        )}

        {tab === 'bond' && (bonds.length === 0
          ? <p className="dim">No outstanding bonds on record.</p>
          : (
            <>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="instrumentId">Bond</label>
                  <select id="instrumentId" name="instrumentId" required>
                    {bonds.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="rupees">Amount credited to the bank (₹)</label>
                  <input id="rupees" name="rupees" inputMode="decimal" required />
                  <span className="help">What actually arrived, after any TDS.</span>
                </div>
                {date}
              </div>
              <div className="field">
                <label htmlFor="note">Note</label>
                <input id="note" name="note" />
              </div>
            </>
          ))}

        {tab === 'milestone' && (milestones.length === 0
          ? <p className="dim">Every milestone is already complete.</p>
          : (
            <div className="form-row">
              <div className="field">
                <label htmlFor="id">Milestone</label>
                <select id="id" name="id" required>
                  {milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              {date}
            </div>
          ))}

        {tab === 'note' && (
          <>
            {date}
            <div className="field">
              <label htmlFor="text">What happened</label>
              <textarea id="text" name="text" maxLength={1000} required
                placeholder="Opened an IDFC First savings account for the emergency fund" />
            </div>
          </>
        )}

        <div className="btn-row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            Record it
          </button>
          {message ? <span role="status" className={message.ok ? 'result-ok' : 'result-err'}>{message.text}</span> : null}
        </div>
      </form>
    </div>
  );
}
