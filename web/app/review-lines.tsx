'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ReviewLine } from '../../src/domain/life-events';

export const EVENT_LABEL: Record<string, string> = {
  SALARY_CHANGE: 'Salary change', JOB_LOSS: 'Job loss / career break', NEW_DEPENDENT: 'New dependent',
  WINDFALL: 'Inheritance or windfall', RETIREMENT_AGE: 'Retirement-age change', MEDICAL_EXPENSE: 'Major medical expense',
};

/**
 * Batch C review lines on the Overview. A constant or goal line closes with **Still right** or
 * takes the new value with **Needs changing** (it then waits for a code change). A rail line
 * changes only through the signed editor on Cleanup, so it links there instead of taking text.
 */
export default function ReviewLines({ lines }: { lines: ReviewLine[] }) {
  return (
    <ul className="timeline">
      {lines.map((l) => <Line key={`${l.eventId}|${l.key}`} l={l} />)}
    </ul>
  );
}

function Line({ l }: { l: ReviewLine }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `review-${l.eventId}-${l.key}`;

  async function send(outcome: 'STILL_RIGHT' | 'NEEDS_CHANGE', newValueText?: string) {
    setBusy(true);
    setError(null);
    const r = await fetch('/api/log', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'review_line', eventId: l.eventId, key: l.key, outcome, newValueText }),
    }).then(async (res) => ({ ok: res.ok, json: await res.json() as { error?: string } }))
      .catch((e) => ({ ok: false, json: { error: String(e) } }));
    setBusy(false);
    if (r.ok) { setEditing(false); router.refresh(); } else setError(r.json.error ?? 'failed');
  }

  return (
    <li>
      <span className="tnum dim">{l.eventOn}</span>
      <span className="dim">{EVENT_LABEL[l.eventKind] ?? l.eventKind}</span>
      <span>
        <strong>{l.label}</strong> · now <span className="tnum">{l.current ?? '—'}</span>
        {l.state === 'NEEDS_CHANGE' ? <> · you said: <span className="tnum">{l.newValueText}</span></> : null}
        <div className="btn-row" style={{ marginTop: 6 }}>
          <button className="btn btn-sm" type="button" disabled={busy} onClick={() => send('STILL_RIGHT')}>
            {l.state === 'NEEDS_CHANGE' ? 'Changed in code — close' : 'Still right'}
          </button>
          {l.state === 'NEEDS_CHANGE' ? null : l.kind === 'rail'
            ? <Link className="btn btn-sm" href="/cleanup">Change it on Cleanup</Link>
            : !editing
              ? <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setEditing(true)}>Needs changing</button>
              : (
                <form className="btn-row" onSubmit={(e) => { e.preventDefault(); void send('NEEDS_CHANGE', String(new FormData(e.currentTarget).get('v') ?? '')); }}>
                  <label htmlFor={id} className="dim">New value</label>
                  <input id={id} name="v" maxLength={500} required autoFocus />
                  <button className="btn btn-sm btn-primary" type="submit" disabled={busy}>Save</button>
                  <button className="btn btn-sm" type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
                </form>
              )}
          {error ? <span role="status" className="result-err">{error}</span> : null}
        </div>
      </span>
    </li>
  );
}
