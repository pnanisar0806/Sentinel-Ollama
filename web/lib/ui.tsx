import type { ReactNode } from 'react';
import { formatInr, type Paise } from '../../src/money/paise.js';

export function Money({ p, compact }: { p: Paise; compact?: boolean }) {
  return <>{formatInr(p, { compact })}</>;
}

export function Pct({ v }: { v: number }) {
  return <>{`${(v * 100).toFixed(1)}%`}</>;
}

export type Tone = 'green' | 'amber' | 'red' | 'gray' | 'indigo';

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge b-${tone}`}>{children}</span>;
}

export function PageHead({ title, badge, sub }: { title: string; badge?: ReactNode; sub?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="page-title">
        <h1>{title}</h1>
        {badge}
      </div>
      {sub ? <p className="page-sub">{sub}</p> : null}
    </div>
  );
}

export function Card({
  title, aside, tone, children,
}: { title: ReactNode; aside?: ReactNode; tone?: 'ok' | 'warn' | 'bad'; children: ReactNode }) {
  return (
    <section className={`card${tone ? ` card-${tone}` : ''}`}>
      <header className="card-head">
        <span className="card-title">{title}</span>
        {aside ? <span className="card-aside">{aside}</span> : null}
      </header>
      <div className="card-body">{children}</div>
    </section>
  );
}

export type Accent = 'green' | 'red' | 'amber' | 'teal' | 'violet' | 'sky';

export function Stat({ label, value, sub, tone, accent }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone; accent?: Accent }) {
  return (
    <div className={`stat${accent ? ` s-${accent}` : ''}`}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value${tone ? ` st-${tone}` : ''}`}>{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

export interface Col<T> { label: string; value: (row: T) => ReactNode; align?: 'left' | 'right' }

export function DataTable<T extends { key: string }>({
  cols, rows, rowTone,
}: { cols: Col<T>[]; rows: T[]; rowTone?: (row: T) => Tone | undefined }) {
  return (
    <table className="table">
      <thead>
        <tr>{cols.map((c) => <th key={c.label} className={c.align === 'right' ? 'ta-right' : 'ta-left'}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const tone = rowTone?.(r);
          return (
            <tr key={r.key} className={tone ? `tr-${tone}` : undefined}>
              {cols.map((c) => <td key={c.label} className={c.align === 'right' ? 'ta-right' : 'ta-left'}>{c.value(r)}</td>)}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function Notice({ children, tone = 'gray' }: { children: ReactNode; tone?: Tone }) {
  return <div className={`notice n-${tone}`}>{children}</div>;
}

/** A button that exists in the product but is not wired up yet — disabled, with the reason as a hover tooltip. */
export function PendingButton({ label, reason }: { label: string; reason: string }) {
  return (
    <span className="pending-btn" role="button" aria-disabled="true" title={`Not built yet — ${reason}`}>
      {label}
    </span>
  );
}

/** Phase 1 shell body: an honest "this area is planned" with the task it lights up in. */
export function NotYetBuild({
  task, why, points, actions,
}: { task: string; why: ReactNode; points?: string[]; actions?: ReactNode }) {
  return (
    <div className="notyet">
      <p className="notyet-why">{why}</p>
      {points && points.length > 0
        ? <ul className="notyet-points">{points.map((p) => <li key={p}>{p}</li>)}</ul>
        : null}
      {actions ? <div className="notyet-actions">{actions}</div> : null}
      <p className="notyet-task">Builds in Phase 1 — <Badge tone="indigo">{task}</Badge></p>
    </div>
  );
}
/** One colour per asset class, the same everywhere (globals.css --c-*). */
export const CLASS_COLOR: Record<string, string> = {
  EQUITY: 'var(--c-equity)', DEBT: 'var(--c-debt)', GOLD: 'var(--c-gold)', CASH: 'var(--c-cash)',
};
export const CLASS_LABEL: Record<string, string> = { EQUITY: 'Equity', DEBT: 'Debt & EPF', GOLD: 'Gold', CASH: 'Cash' };

/** Asset-class chip in its class colour. */
export function ClassChip({ assetClass }: { assetClass: string }) {
  return (
    <span className="badge" style={{ borderColor: CLASS_COLOR[assetClass], color: CLASS_COLOR[assetClass] }}>
      {CLASS_LABEL[assetClass] ?? assetClass}
    </span>
  );
}

/** Stacked allocation bar with a legend showing each class against its IPS band. */
export function AllocationBar({ drift }: {
  drift: { assetClass: string; actual: number; min: number; max: number; breach: 'OVER' | 'UNDER' | null }[];
}) {
  return (
    <>
      <div className="alloc-bar" role="img"
        aria-label={drift.map((d) => `${CLASS_LABEL[d.assetClass] ?? d.assetClass} ${(d.actual * 100).toFixed(1)}%`).join(', ')}>
        {drift.map((d) => <span key={d.assetClass} style={{ width: `${d.actual * 100}%`, background: CLASS_COLOR[d.assetClass] }} />)}
      </div>
      <div className="alloc-legend">
        {drift.map((d) => (
          <div className="alloc-item" key={d.assetClass}>
            <span className="swatch" style={{ background: CLASS_COLOR[d.assetClass] }} aria-hidden="true" />
            <div>
              <div>{CLASS_LABEL[d.assetClass] ?? d.assetClass}</div>
              <div className="v">{(d.actual * 100).toFixed(1)}%</div>
              <div className="muted">band {(d.min * 100).toFixed(0)}–{(d.max * 100).toFixed(0)}%{' '}
                {d.breach === null ? <span className="tone-green">· in band</span>
                  : <span className={d.breach === 'OVER' ? 'tone-amber' : 'tone-red'}>· {d.breach === 'OVER' ? 'over' : 'under'}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Goal buckets with funded progress. An unallocated bucket says so; it is never ₹0. */
export function GoalList({ buckets }: {
  buckets: { id: string; name: string; balancePaise: Paise | null; fundedRatio: number | null; targetNote: string }[];
}) {
  return (
    <>
      {buckets.map((b) => {
        const ratio = b.fundedRatio === null ? null : Math.min(1, b.fundedRatio);
        return (
          <div className="goal" key={b.id}>
            <div className="goal-top">
              <span className="goal-name">{b.name} <span className="dim">({b.id})</span></span>
              <span className="tnum">
                {b.balancePaise === null ? <span className="dim">not allocated yet</span>
                  : ratio === null ? <Money p={b.balancePaise} compact /> : <>{<Money p={b.balancePaise} compact />} · <Pct v={b.fundedRatio!} /></>}
              </span>
            </div>
            {ratio !== null
              ? <div className="progress" aria-hidden="true"><div className={`fill ${ratio >= 1 ? 'f-green' : 'f-violet'}`} style={{ width: `${ratio * 100}%` }} /></div>
              : null}
            {b.targetNote ? <span className="muted">{b.targetNote}</span> : null}
          </div>
        );
      })}
    </>
  );
}
