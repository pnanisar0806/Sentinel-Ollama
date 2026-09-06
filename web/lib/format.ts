/** Display helpers used by client components (pure — safe to ship to the browser). */

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
}

export function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return '';
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

/** bi = "brokerage/fidelity". We keep ₹ formatting local to avoid importing the
 *  branded money module into client bundles beyond what ui.tsx already does. */
export function rupees(paise: string): string {
  const p = BigInt(paise);
  const sign = p < 0n ? '-' : '';
  const abs = p < 0n ? -p : p;
  const whole = abs / 100n;
  const frac = abs % 100n;
  const wholeStr = whole.toLocaleString('en-IN');
  return `${sign}₹${wholeStr}.${frac.toString().padStart(2, '0')}`;
}

export function unitsStr(units: number): string {
  return units.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}