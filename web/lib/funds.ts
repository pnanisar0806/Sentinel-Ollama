/** Pure display helpers for /funds "Switch check" (fund switch spec §4). */
import { formatInr, type Paise } from '../../src/money/paise.js';
import type { SipAnswer, UnitsAnswer } from '../../src/domain/fund-moves.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** `YYYY-MM` → "Nov 2026". */
const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

/** "move SIP to B" means stop this SIP and start the same amount in B; past units are untouched. */
export function sipText(s: SipAnswer): string {
  switch (s.kind) {
    case 'none': return 'no SIP';
    case 'unknown': return 'unknown'; // the page says why
    case 'keep': return `keep running ${formatInr(s.amountPaise as Paise)}`;
    case 'move': return `move SIP to ${s.toName}`;
    case 'moved': return `moved to ${s.toName} from ${monthLabel(s.firstMonth)}`;
  }
}

export const unitsText = (u: UnitsAnswer): string => (u.kind === 'keep' ? 'keep' : `move to ${u.toName}`);
