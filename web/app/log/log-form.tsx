'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type Tab = 'goal' | 'earmark' | 'spend' | 'sale' | 'purchase' | 'sip_move' | 'bond' | 'milestone' | 'note';

const TABS: { id: Tab; label: string }[] = [
  { id: 'goal', label: 'Money into a goal' },
  { id: 'earmark', label: 'Earmark money' },
  { id: 'spend', label: 'Money spent' },
  { id: 'sale', label: 'A sale I made' },
  { id: 'purchase', label: 'Purchase outside Sentinel' },
  { id: 'sip_move', label: 'Move a SIP' },
  { id: 'bond', label: 'Bond matured' },
  { id: 'milestone', label: 'Milestone done' },
  { id: 'note', label: 'Anything else' },
];

/** Money arrives already formatted by the server page: an unknown is text, never ₹0. */
type Pot = { id: string; name: string; held: string };
type Label = { label: string; held: string };

const POTS = ['B2', 'B3', 'B4', 'SP'];

type SipMoveOptions = {
  from: { instrumentId: string; name: string; category: string }[];
  toByCategory: Record<string, { instrumentId: string; name: string }[]>;
};

async function post(body: object): Promise<{ ok: boolean; text: string }> {
  const res = await fetch('/api/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json() as { message?: string; error?: string };
  return { ok: res.ok, text: json.message ?? json.error ?? `failed (${res.status})` };
}

/**
 * One form per kind of thing the owner did. Validation is server-side in the domain;
 * this only gathers the fields and reports what the server said, verbatim.
 */
export default function LogForm({ buckets, bonds, holdings, milestones, today, sellable, pots, spLabels, idleCash, sipMoves }: {
  buckets: { id: string; name: string }[];
  holdings: { id: string; name: string }[];
  bonds: { id: string; name: string }[];
  milestones: { id: string; name: string }[];
  today: string;
  sellable: { id: string; name: string; kind: string }[];
  pots: Pot[];
  spLabels: Label[];
  idleCash: string;
  sipMoves: SipMoveOptions;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('goal');
  // The picks that change which fields a form shows; cleared with the form.
  const [pick, setPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const go = (t: Tab) => { setTab(t); setPick({}); setMessage(null); };
  const choose = (k: string) => (e: React.ChangeEvent<HTMLSelectElement>) => { const v = e.target.value; setPick((p) => ({ ...p, [k]: v })); };
  const potName = (id: string) => (id === 'FI' ? 'FI (unassigned money)' : id === 'BANK' ? 'My bank, not earmarked' : pots.find((p) => p.id === id)?.name ?? id);
  const held = (id: string) => pots.find((p) => p.id === id)?.held;
  const noLabels = spLabels.length === 0;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const target = e.currentTarget;
    const body = Object.fromEntries(new FormData(target).entries());
    setBusy(true);
    setMessage(null);
    try {
      const result = await post({ action: tab, ...body });
      setMessage(result);
      if (result.ok) { target.reset(); setPick({}); router.refresh(); }
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

  // Taking money out of Planned spending picks an open pot, so a typo cannot open a new one.
  const labelPicker = (
    <div className="field">
      <label htmlFor="label">Planned spending pot</label>
      <select id="label" name="label" required>
        {spLabels.map((l) => <option key={l.label} value={l.label}>{l.label} · {l.held}</option>)}
      </select>
    </div>
  );
  // Money into Planned spending: an open pot, or a new one.
  const labelInput = (
    <div className="field">
      <label htmlFor="label">Planned spending pot</label>
      <input id="label" name="label" list="sp-labels" maxLength={80} required placeholder="Himachal trip" />
      <datalist id="sp-labels">{spLabels.map((l) => <option key={l.label} value={l.label} />)}</datalist>
      <span className="help">Pick an open pot or name a new one.</span>
    </div>
  );
  const note = (
    <div className="field">
      <label htmlFor="note">Note</label>
      <input id="note" name="note" />
    </div>
  );

  const earmarkFrom = pick['from'] ?? 'FI';
  const earmarkTo = pick['to'] ?? 'SP';
  const spendFrom = pick['from'] ?? (noLabels ? 'BANK' : 'SP');
  const sold = sellable.find((h) => h.id === (pick['instrumentId'] ?? sellable[0]?.id));
  const saleTo = pick['destination'] ?? '';
  const moveFrom = sipMoves.from.find((f) => f.instrumentId === (pick['fromInstrumentId'] ?? sipMoves.from[0]?.instrumentId));
  const moveTo = moveFrom ? (sipMoves.toByCategory[moveFrom.category] ?? []).filter((f) => f.instrumentId !== moveFrom.instrumentId) : [];
  // The domain refuses a first month before last month (IST); the picker says so up front.
  const [ty, tm] = today.split('-').map(Number) as [number, number];
  const minMonth = tm === 1 ? `${ty - 1}-12` : `${ty}-${String(tm - 1).padStart(2, '0')}`;

  return (
    <div className="form">
      <div className="tabs" role="tablist" aria-label="What did you do?">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => go(t.id)}>
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

        {tab === 'earmark' && (
          <>
            <p className="dim">
              Set money aside for a goal or a known expense, or send what is left back to FI (the money not assigned to
              any goal). Only money already in a goal can leave it. Into the emergency fund or Planned spending from FI,
              the house or education, it needs that much bank cash not already set aside: {idleCash} now.
            </p>
            <div className="form-row">
              <div className="field">
                <label htmlFor="from">From</label>
                <select id="from" name="from" defaultValue="FI" onChange={choose('from')} required>
                  {['FI', ...POTS].map((id) => (
                    <option key={id} value={id} disabled={id === 'SP' && noLabels}>{potName(id)}{id === 'SP' && noLabels ? ' (nothing earmarked)' : ''}</option>
                  ))}
                </select>
                {held(earmarkFrom) && earmarkFrom !== 'SP' ? <span className="help">Holds {held(earmarkFrom)}</span> : null}
              </div>
              <div className="field">
                <label htmlFor="to">To</label>
                <select id="to" name="to" defaultValue="SP" onChange={choose('to')} required>
                  {['FI', ...POTS].map((id) => <option key={id} value={id}>{potName(id)}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="rupees">Amount (₹)</label>
                <input id="rupees" name="rupees" inputMode="decimal" placeholder="250000" required />
              </div>
              {date}
            </div>
            {earmarkFrom === 'SP' ? labelPicker : earmarkTo === 'SP' ? (
              <div className="form-row">
                {labelInput}
                <div className="field">
                  <label htmlFor="expectedOn">Expected date (optional)</label>
                  <input id="expectedOn" name="expectedOn" type="date" />
                </div>
              </div>
            ) : null}
            {note}
          </>
        )}

        {tab === 'spend' && (
          <>
            <p className="dim">
              Money you spent. Paid from Planned spending or a goal, that pot shrinks by it. Paid from your bank without
              an earmark, it is a timeline entry only: the bank balance sync already sees the money leave.
            </p>
            <div className="form-row">
              <div className="field">
                <label htmlFor="purpose">What it was for</label>
                <input id="purpose" name="purpose" maxLength={120} required placeholder="Himachal trip hotels" />
              </div>
              <div className="field">
                <label htmlFor="from">Paid from</label>
                <select id="from" name="from" defaultValue={spendFrom} onChange={choose('from')} required>
                  {[...POTS, 'BANK'].map((id) => (
                    <option key={id} value={id} disabled={id === 'SP' && noLabels}>{potName(id)}{id === 'SP' && noLabels ? ' (nothing earmarked)' : ''}</option>
                  ))}
                </select>
                {held(spendFrom) && spendFrom !== 'SP' ? <span className="help">Holds {held(spendFrom)}</span> : null}
              </div>
              <div className="field">
                <label htmlFor="rupees">Amount (₹)</label>
                <input id="rupees" name="rupees" inputMode="decimal" required />
              </div>
              {date}
            </div>
            {spendFrom === 'SP' ? labelPicker : null}
            {note}
          </>
        )}

        {tab === 'sale' && (
          <>
            <p className="dim">
              A sale or redemption you made yourself: a record, never an order. It does not change this month&apos;s
              budget. Log an RSU sale once the money reaches your Indian bank. A bond that matured goes on the{' '}
              <button type="button" className="btn btn-sm" onClick={() => go('bond')}>Bond matured</button> form instead.
            </p>
            {sellable.length === 0
              ? <p className="dim">No holdings on record to sell.</p>
              : (
                <>
                  <div className="form-row">
                    <div className="field">
                      <label htmlFor="instrumentId">Holding</label>
                      <select id="instrumentId" name="instrumentId" defaultValue={sellable[0]!.id} onChange={choose('instrumentId')} required>
                        {sellable.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor="units">Units sold{sold?.kind === 'MF' ? ' (optional for a fund)' : ''}</label>
                      <input id="units" name="units" inputMode="decimal" required={sold?.kind !== 'MF'} />
                    </div>
                    <div className="field">
                      <label htmlFor="rupees">Amount received (₹)</label>
                      <input id="rupees" name="rupees" inputMode="decimal" required />
                      <span className="help">What reached the bank, after charges and any tax withheld.</span>
                    </div>
                    {date}
                  </div>
                  <div className="form-row">
                    <div className="field">
                      <label htmlFor="destination">Where the money went</label>
                      <select id="destination" name="destination" defaultValue="" onChange={choose('destination')}>
                        <option value="">Stayed in my bank</option>
                        {POTS.map((id) => <option key={id} value={id}>Into {potName(id)}</option>)}
                      </select>
                    </div>
                    {saleTo === 'SP' ? labelInput : null}
                  </div>
                  {note}
                </>
              )}
          </>
        )}

        {tab === 'purchase' && (
          <>
            <p className="dim">
              A buy you made yourself, outside Sentinel. It counts against that month&apos;s remaining-to-invest.
              An order Sentinel proposed is marked on Approvals instead — logging it here too would count it twice.
              SIP instalments are already counted in the SIP commitment: never log them here.
              It updates the monthly budget immediately. Holdings and the allocation bar update from
              the daily holdings sync, not from this form; the IPS target bands never change.
              Only log buys paid from this month&apos;s budget. A buy funded by a maturity, an RSU vest or a
              redemption is not logged here.
            </p>
            <div className="form-row">
              <div className="field">
                <label htmlFor="description">What you bought</label>
                <input id="description" name="description" maxLength={200} required placeholder="Zerodha Gold ETF" />
              </div>
              <div className="field">
                <label htmlFor="instrumentId">Holding (optional)</label>
                <select id="instrumentId" name="instrumentId" defaultValue="">
                  <option value="">— not linked —</option>
                  {holdings.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="rupees">Amount paid (₹)</label>
                <input id="rupees" name="rupees" inputMode="decimal" required />
              </div>
              <div className="field">
                <label htmlFor="units">Units (optional)</label>
                <input id="units" name="units" inputMode="decimal" />
              </div>
              {date}
            </div>
            {note}
          </>
        )}

        {tab === 'sip_move' && (
          <>
            <p className="dim">
              You moved a monthly SIP from one fund to another in the same category. Sentinel records it; the SIP itself
              is changed where you hold it. Only funds with a known category are offered, and the new fund must share it.
            </p>
            {!moveFrom
              ? <p className="dim">No held fund with a known category on record.</p>
              : (
                <>
                  <div className="form-row">
                    <div className="field">
                      <label htmlFor="fromInstrumentId">From</label>
                      <select id="fromInstrumentId" name="fromInstrumentId" defaultValue={moveFrom.instrumentId} onChange={choose('fromInstrumentId')} required>
                        {sipMoves.from.map((f) => <option key={f.instrumentId} value={f.instrumentId}>{f.name}</option>)}
                      </select>
                      <span className="help">{moveFrom.category}</span>
                    </div>
                    <div className="field">
                      {moveTo.length === 0
                        ? <><span>To</span><span className="help">No other fund in this category on record.</span></>
                        : (
                          <>
                          <label htmlFor="toInstrumentId">To</label>
                          <select id="toInstrumentId" name="toInstrumentId" key={moveFrom.instrumentId} required>
                            {moveTo.map((f) => <option key={f.instrumentId} value={f.instrumentId}>{f.name}</option>)}
                          </select>
                          </>
                        )}
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="field">
                      <label htmlFor="rupees">Monthly amount (₹)</label>
                      <input id="rupees" name="rupees" inputMode="decimal" required />
                    </div>
                    <div className="field">
                      <label htmlFor="firstMonth">First month of the new SIP</label>
                      <input id="firstMonth" name="firstMonth" type="month" min={minMonth} defaultValue={today.slice(0, 7)} required />
                    </div>
                    {date}
                  </div>
                  {note}
                </>
              )}
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
              {note}
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
          <button className="btn btn-primary" type="submit" disabled={busy || (tab === 'sip_move' && moveTo.length === 0)}>
            {busy ? <span className="spinner" aria-hidden="true" /> : null}
            Record it
          </button>
          {message ? <span role="status" className={message.ok ? 'result-ok' : 'result-err'}>{message.text}</span> : null}
        </div>
      </form>
    </div>
  );
}

/**
 * Reverse a timeline entry: a reason, then a confirmation naming exactly what is undone.
 * The original stays; the domain refuses anything it may not reverse, shown verbatim.
 */
export function ReverseControl({ entity, entityId, summary }: { entity: string; entityId: string; summary: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const id = `reason-${entity}-${entityId}`;

  if (!open) return <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>Reverse</button>;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
    setBusy(true);
    setMessage(null);
    try {
      const result = await post({ action: 'reverse', entity, entityId, reason });
      setMessage(result);
      if (result.ok) router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit} style={{ marginTop: 8 }}>
      <p className="dim" style={{ margin: 0 }}>
        This undoes: <strong>{summary}</strong>. The entry stays on the timeline, struck through; log the right one afterwards.
      </p>
      <div className="field">
        <label htmlFor={id}>Why it is being reversed</label>
        <input id={id} name="reason" maxLength={500} required placeholder="Entered the wrong amount" />
      </div>
      <div className="btn-row">
        <button className="btn btn-sm btn-danger" type="submit" disabled={busy}>
          {busy ? <span className="spinner" aria-hidden="true" /> : null}
          Reverse it
        </button>
        <button className="btn btn-sm" type="button" onClick={() => { setOpen(false); setMessage(null); }} disabled={busy}>Cancel</button>
        {message ? <span role="status" className={message.ok ? 'result-ok' : 'result-err'}>{message.text}</span> : null}
      </div>
    </form>
  );
}
