'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { BrokerageProposal, FidelityProposal, UploadRow } from '../../lib/ingest.js';
import { fmtDateTime, relTime, rupees, unitsStr } from '../../lib/format.js';
import { Badge, Card, DataTable, Notice, type Col, type Tone } from '../../lib/ui.js';

const STATUS_LABEL: Record<UploadRow['status'], { label: string; tone: Tone; badge: string }> = {
  proposed: { label: 'Pending your decision', tone: 'indigo', badge: 'b-indigo' },
  confirmed: { label: 'Confirmed & written', tone: 'green', badge: 'b-green' },
  rejected: { label: 'Rejected', tone: 'gray', badge: 'b-gray' },
  unusable: { label: 'Not readable (LLM)', tone: 'amber', badge: 'b-amber' },
};

export default function ReviewPanel({ upload }: { upload: UploadRow }) {
  const router = useRouter();
  const [select, setSelect] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = STATUS_LABEL[upload.status];

  const props = upload.proposals;
  const selectable = useMemo(
    () => new Set(props.map((_, i) => i).filter((i) => !(props[i]!.kind === 'brokerage' && props[i]!.instrumentId === null))),
    [props],
  );

  const confirmed = [...select].filter((i) => selectable.has(i));

  async function doAction(action: 'confirm' | 'reject') {
    const idx = action === 'confirm' ? (confirmed.length ? confirmed.map((i) => i + 1) : props.map((_, i) => i + 1)) : [];
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/import/${upload.id}/${action}`, {
        method: 'POST',
        headers: idx.length ? { 'Content-Type': 'application/json' } : undefined,
        body: idx.length ? JSON.stringify({ indexes: idx }) : undefined,
      });
      const body: unknown = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((body && typeof body === 'object' && 'error' in body)
          ? String((body as { error: unknown }).error)
          : `Action failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title={
        <>
          <Badge tone={upload.kind === 'brokerage' ? 'indigo' : 'green'}>
            {upload.kind === 'brokerage' ? 'Brokerage / Kite' : 'Fidelity RSU'}
          </Badge>{' '}
          {upload.fileName}
        </>
      }
      aside={
        upload.status === 'proposed'
          ? `${props.length} proposal(s) · ${relTime(upload.createdAt)}`
          : `${fmtDateTime(upload.createdAt)}${upload.resolvedAt ? ` · resolved ${relTime(upload.resolvedAt)}` : ''}`
      }
    >
      {upload.status === 'unusable' && upload.error ? (
        <Notice tone="red">{upload.error}</Notice>
      ) : null}

      {upload.status === 'proposed' && props.length === 0 ? (
        <Notice tone="amber">Extraction returned no proposals — the statement was filed but nothing was recognized. Reject it so it is archived as unusable, or try again with better pages.</Notice>
      ) : null}

      <div style={{ marginBottom: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <span className="muted">{upload.pageCount} page(s) · filed from this upload</span>
      </div>

      {props.length > 0 ? <ProposalTable upload={upload} select={select} setSelect={setSelect} /> : null}

      {upload.status === 'proposed' && props.length > 0 ? (
        <div className="btn-row" style={{ marginTop: 14 }}>
          <button
            className="btn btn-primary btn-sm"
            disabled={busy || confirmed.length === 0}
            onClick={() => doAction('confirm')}
          >
            {busy ? 'Working…' : `Confirm ${confirmed.length === 0 ? 'nothing' : confirmed.length === props.length ? 'all' : confirmed.length}`}
          </button>
          <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => doAction('reject')}>
            Reject all
          </button>
          {confirmed.length === 0 && props.length > 0 ? (
            <span className="muted">Tick the proposals you want written — unchecked rows are skipped, not rejected.</span>
          ) : null}
        </div>
      ) : null}

      {error ? <Notice tone="red">{error}</Notice> : null}

      {upload.summary ? <pre className="upload-summary">{upload.summary}</pre> : null}
    </Card>
  );
}

interface PropRow {
  key: string;
  checkbox: boolean;
  checked: boolean;
  what: string;
  right1: string;
  right2: string;
  dim: string;
  conflict: string | null;
}

function ProposalTable({
  upload,
  select,
  setSelect,
}: {
  upload: UploadRow;
  select: Set<number>;
  setSelect: (s: Set<number>) => void;
}) {
  const cols: Col<PropRow>[] = [
    { label: '', value: (r) => (r.checkbox
      ? <input type="checkbox" checked={r.checked} onChange={() => toggle(select, setSelect, r.key)} aria-label={`Proposal ${r.key}`} />
      : <span className="muted" title="No matching holding — would be skipped">&mdash;</span>
    ) },
    { label: upload.kind === 'brokerage' ? 'Holding' : 'Grant / vest', value: (r) => r.what },
    { label: 'Date', value: (r) => r.right1 },
    { label: 'Amount', value: (r) => <span className="tnum">{r.right2}</span>, align: 'right' },
    { label: '', value: (r) => (r.conflict ? <Badge tone="amber" >conflict</Badge> : r.dim ? <span className="tone-dim">{r.dim}</span> : null) },
  ];

  const rows: PropRow[] = upload.proposals.map((p, i) => {
    const k = String(i + 1);
    if (p.kind === 'brokerage') return brokerageRow(p, i, select, k);
    return fidelityRow(p, i, select, k);
  });

  return <DataTable rows={rows} cols={cols} />;
}

function toggle(select: Set<number>, setSelect: (s: Set<number>) => void, key: string) {
  const i = Number(key) - 1;
  const next = new Set(select);
  if (next.has(i)) next.delete(i); else next.add(i);
  setSelect(next);
}

function brokerageRow(p: BrokerageProposal, i: number, select: Set<number>, k: string): PropRow {
  const ok = p.instrumentId !== null;
  return {
    key: k,
    checkbox: ok,
    checked: ok && select.has(i),
    what: p.instrumentId !== null ? `${p.name} · ${p.account}` : `${p.name} — no matching holding`,
    right1: p.acquiredOn || '',
    right2: rupees(p.costPaise),
    dim: p.confidence || '',
    conflict: p.conflictWithCost ? `another proposal says ${rupees(p.conflictWithCost)}` : null,
  };
}

function fidelityRow(p: FidelityProposal, i: number, select: Set<number>, k: string): PropRow {
  return {
    key: k,
    checkbox: true,
    checked: select.has(i),
    what: `${p.grantId} vesting ${p.vestOn}`,
    right1: `${unitsStr(p.units)} units`,
    right2: `net ${rupees(p.netPaise)}`,
    dim: p.confidence || '',
    conflict: null,
  };
}