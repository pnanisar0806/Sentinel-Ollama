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

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <div className="stat">
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