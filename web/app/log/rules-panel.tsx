'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { postLog, type Msg } from '../allow-once';

/** Labelled by the page: `label` is the rule's own words, each exception's `scope` its month or lump sum. */
export type RuleRow = { id: string; name: string; label: string; note: string; on: string; exceptions: { id: string; scope: string }[] };

/**
 * Batch C "Holding rules" tab: the rules in force and their Allow onces. Ending a rule early, or
 * undoing an Allow once, is a reversal with a reason — the row stays on record, never edited.
 */
export default function RulesPanel({ rules }: { rules: RuleRow[] }) {
  return (
    <div className="form">
      <p className="dim">
        A rule refuses advice that breaks it; it never sells, pauses a SIP or changes a number by itself. Add one on Holdings or
        Mutual funds (<em>Add rule</em> on the fund). A hold-until rule ends by itself after its date.
      </p>
      {rules.length === 0
        ? <p className="dim">No rule is on. Rules you add on Holdings or Mutual funds are listed here until you end them.</p>
        : (
          <ul className="timeline">
            {rules.map((r) => (
              <li key={r.id}>
                <span className="tnum dim">{r.on}</span>
                <span className="dim">since</span>
                <span>
                  <strong>{r.name}</strong>: {r.label}{r.note ? <span className="dim"> — {r.note}</span> : null}
                  <EndControl entity="holding_rule" entityId={r.id} label="End now" confirm={`End the ${r.label} rule on ${r.name}`} />
                  {r.exceptions.map((e) => (
                    <div key={e.id} style={{ marginTop: 8 }}>
                      <span className="dim">Allowed once {e.scope}</span>
                      <EndControl entity="holding_rule_exception" entityId={e.id} label="Undo" confirm={`Undo the Allow once ${e.scope}`} />
                    </div>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
    </div>
  );
}

function EndControl({ entity, entityId, label, confirm }: { entity: string; entityId: string; label: string; confirm: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const id = `end-${entity}-${entityId}`;

  if (!open) return <div className="rule-ctl"><button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>{label}</button></div>;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
    setBusy(true); setMsg(null);
    const r = await postLog({ action: 'reverse', entity, entityId, reason }).catch((err) => ({ ok: false, text: String(err) }));
    setMsg(r); setBusy(false);
    if (r.ok) router.refresh();
  }

  return (
    <form className="rule-ctl" onSubmit={submit}>
      <div className="field">
        <label htmlFor={id}>{confirm}: why?</label>
        <input id={id} name="reason" maxLength={500} required placeholder="Changed my mind" />
      </div>
      <div className="btn-row">
        <button className="btn btn-sm btn-danger" type="submit" disabled={busy}>{busy ? 'Saving…' : label}</button>
        <button className="btn btn-sm" type="button" disabled={busy} onClick={() => { setOpen(false); setMsg(null); }}>Cancel</button>
      </div>
      {msg ? <span role="status" className={msg.ok ? 'result-ok' : 'result-err'}>{msg.text}</span> : null}
    </form>
  );
}
