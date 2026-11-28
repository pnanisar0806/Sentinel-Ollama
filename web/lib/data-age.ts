/** Open list #29 (owner, 2026-11-20): the Overview and /freshness lines for INDmoney data that stopped changing. */
import { formatInr, type Paise } from '../../src/money/paise.js';
import type { BalanceAge, DataAge } from '../../src/domain/data-age.js';
import { dayLabel } from './cashflow';

const unchanged = (what: string, a: BalanceAge): string =>
  `${what} ${formatInr(a.amountPaise as Paise)} is unchanged since ${dayLabel(a.lastChangedOn)} (${a.daysUnchanged} days).`;

/** Warn-only lines, one per stale bank, one for EPF, one for every fund whose SIP units did not rise. Empty when all is fresh. */
export function dataAgeNotices(d: DataAge): string[] {
  const out: string[] = [];
  for (const b of d.banks) {
    if (b.age.stale) {
      out.push(`${unchanged(`${b.label} balance`, b.age)} INDmoney refreshes it only when you open its app: open INDmoney and pull to refresh, and the next sync picks it up.`);
    }
  }
  if (d.epf?.stale) out.push(`${unchanged('EPF', d.epf)} INDmoney updates EPF only when it is refreshed in its app: open EPF in INDmoney and refresh it.`);
  const lagging = d.sipUnits.filter((s) => s.stale);
  if (lagging.length > 0) {
    out.push(`SIP units not updated: ${lagging.map((s) => `${s.fundName} (${dayLabel(s.instalmentOn)} instalment)`).join(', ')}. `
      + 'The fund mix undercounts them until INDmoney picks the units up: open INDmoney and refresh.');
  }
  return out;
}
