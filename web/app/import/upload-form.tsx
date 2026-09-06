'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { IngestKind } from '../../lib/ingest.js';
import { Notice } from '../../lib/ui.js';

export default function UploadForm({ llmConfigured }: { llmConfigured: boolean }) {
  const router = useRouter();
  const [kind, setKind] = useState<IngestKind>('brokerage');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const input = inputRef.current;
    if (!input?.files?.length) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      const fd = new FormData();
      fd.append('kind', kind);
      for (const f of Array.from(input.files)) fd.append('files', f);
      const res = await fetch('/api/import', { method: 'POST', body: fd });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = (body && typeof body === 'object' && 'error' in body
          ? String((body as { error: unknown }).error)
          : `Upload failed (${res.status})`);
        setError(msg);
        return;
      }
      const b = body as { id?: string; status?: string };
      input.value = '';
      if (b.status === 'unusable') {
        setInfo('Filing archived; the LLM is not configured so this upload could not be read. See "History" below.');
      } else {
        setInfo('Extracted — review the proposals below. Nothing has been written yet.');
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" id="statement" onSubmit={onSubmit}>
      <div className="import-form">
        <div className="import-kind" role="group" aria-label="Statement type">
          <button
            type="button"
            className={kind === 'brokerage' ? 'active' : undefined}
            onClick={() => setKind('brokerage')}
          >
            Brokerage / Kite
          </button>
          <button
            type="button"
            className={kind === 'fidelity' ? 'active' : undefined}
            onClick={() => setKind('fidelity')}
          >
            Fidelity RSU
          </button>
        </div>
        <input
          className="import-file"
          ref={inputRef}
          type="file"
          accept="image/*,.jpg,.jpeg,.png,.pdf"
          multiple
          onChange={() => { setError(null); setInfo(null); }}
        />
        <div className="btn-row">
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? (<><span className="spinner" /> Extracting…</>) : kind === 'brokerage' ? 'Extract brokerage costs' : 'Extract Fidelity vests'}
          </button>
          <span className="import-selected">
            {kind === 'brokerage'
              ? 'Predicts average-cost lots & acquired dates for your holdings.'
              : 'Predicts upcoming RSU vest amounts, priced at the live FX rate.'}
          </span>
        </div>
        {error ? <Notice tone="red">{error}</Notice> : null}
        {info ? <Notice tone="green">{info}</Notice> : null}
        {!llmConfigured ? (
          <p className="muted">LLM is not configured right now — the statements will be filed but not read.</p>
        ) : null}
      </div>
    </form>
  );
}