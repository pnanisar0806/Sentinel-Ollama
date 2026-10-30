import type { Db } from '../db/client.js';
import { formatInr, type Paise } from '../money/paise.js';
import { chooseIndexFund, loadIndexFundRows } from '../sources/index-funds.js';
import {
  FUND_TYPE_BY_ISIN, FUND_TYPE_LABEL, fundAliases, loadActualMix, loadSignedMix, neverCut, sameFund, suggestSips, typeOf,
  type ActualMix, type FundType, type SipInput, type SipSuggestion,
} from './fund-mix.js';
import { loadFundMoves } from './fund-moves.js';
import { loadActiveSipMoves } from './owner-log.js';
import { railPaise } from './rail-values.js';
import { loadFreeEnvelope, loadSipCommitment, type FreeEnvelope } from './sips.js';

const ROUND_PAISE = 10_000n; // ₹100

export type SipSuggestions =
  | { rows: SipSuggestion[]; currentPaise: bigint; suggestedPaise: bigint; budgetPaise: bigint; setAsidePaise: bigint; capped: boolean }
  | { rows: null; reason: string };

/**
 * /funds "Suggested SIPs" (Piece 3 Task 9; batch B §5): the live SIPs re-split toward the signed mix, never
 * below a current SIP, never into a fund the switch check says to leave (owner, 2026-10-28), and the total
 * never above `monthly_budget_paise` (owner, 2026-10-30) less the goal set-aside, which is never invested.
 * A SIP is typed by its own ISIN first, then by its instrument. An unknown SIP total withholds
 * the whole suggestion with the envelope's reason — never computed from a null read as 0.
 * A logged SIP move (fund switch §3) stops its "from" SIP (dropped even while the feed still lists
 * it) and leaves that fund; the "to" fund stands in at the logged amount, `logged: true`, until the
 * feed shows that SIP; then the feed amount wins. The total counts the moved money once.
 */
export async function loadSipSuggestions(d: Db, now: string): Promise<SipSuggestions> {
  const signed = await loadSignedMix(d);
  if (signed === null) return { rows: null, reason: 'approve the fund mix first' };
  const c = await loadSipCommitment(d, now);
  if (c.totalPaise === null) return { rows: null, reason: (await loadFreeEnvelope(d, now)).reason ?? 'SIP commitment unknown' };
  if (c.sips.length === 0) return { rows: null, reason: 'no active SIP on record — the indmoney-sips sync fills it' };
  const isin = new Map((await d.query<{ sip_id: string; isin: string }>(
    `select distinct sip_id, isin from sips where isin is not null and sip_id = any($1::text[])`, [c.sips.map((s) => s.sipId)],
  )).map((r) => [r.sip_id, r.isin]));
  const moves = await Promise.all((await loadActiveSipMoves(d)).map(async (m) => ({
    ...m, from: await fundAliases(d, m.fromInstrumentId), to: await fundAliases(d, m.toInstrumentId) })));
  // Funds to leave: a logged move's "from" (listed first, so it wins), then every fund the /funds
  // switch check (active and index, fund switch §4) says to move, with the pick's name.
  const leavers: { from: string[]; toName: string }[] = [...moves, ...await Promise.all((await loadFundMoves(d, now)).moves
    .flatMap((f) => (f.units.kind === 'move' ? [{ id: f.instrumentId, toName: f.units.toName }] : []))
    .map(async (f) => ({ from: await fundAliases(d, f.id), toName: f.toName })))];
  // Spec §3: a moved SIP's new fund is in the same AMFI category, so an untyped "to" takes the "from" type.
  const typed = async (instrumentId: string, isinOf: string | null, aliases: string[]) => {
    const t = FUND_TYPE_BY_ISIN[isinOf ?? ''] ?? await typeOf(d, instrumentId);
    const m = t === null ? moves.find((x) => sameFund(x.to, aliases)) : undefined;
    return m ? await typeOf(d, m.fromInstrumentId) : t;
  };
  const sips: SipInput[] = [];
  const feed: string[][] = [];
  for (const s of c.sips) {
    const aliases = leavers.length === 0 ? [] : await fundAliases(d, s.instrumentId, isin.get(s.sipId) ?? null);
    feed.push(aliases);
    // A moved SIP was stopped: the feed may still list it (lag), but its money now runs in the "to" fund.
    if (moves.some((m) => sameFund(m.from, aliases))) continue;
    const t = await typed(s.instrumentId, isin.get(s.sipId) ?? null, aliases);
    sips.push({ instrumentId: s.instrumentId, fundName: s.fundName, type: t?.type ?? null, topUp: t?.topUp ?? false, amountPaise: s.amountPaise });
  }
  // A move whose new fund the feed does not show yet: its logged amount stands in until the feed does.
  for (const m of moves.filter((x) => !feed.some((f) => sameFund(f, x.to)))) {
    const t = await typed(m.toInstrumentId, null, m.to);
    sips.push({ instrumentId: m.toInstrumentId, fundName: m.toName, type: t?.type ?? null, topUp: t?.topUp ?? false, amountPaise: m.amountPaise, logged: true });
  }
  const actual = await loadActualMix(d);
  const types = Object.keys(FUND_TYPE_LABEL) as FundType[];
  // A US / Next 50 new-fund row is named from the chooser's top pick (Task 10).
  const { rows: indexRows } = await loadIndexFundRows(d);
  const choices = (['US', 'NEXT50'] as const).map((t) => chooseIndexFund(indexRows, t));
  // A fund to leave gets no new money, under every id it appears as (feed SIP or holding); its type names the pick.
  const leaving: Record<string, string> = {};
  const leave = (id: string, own: string[]) => { const m = leavers.find((x) => sameFund(x.from, own)); if (m) leaving[id] = m.toName; };
  c.sips.forEach((s, i) => leave(s.instrumentId, feed[i]!));
  for (const h of leavers.length === 0 ? [] : types.flatMap((t) => actual.byType[t].holdings)) leave(h.instrumentId, await fundAliases(d, h.instrumentId));
  const budgetPaise = await railPaise(d, 'monthly_budget_paise');
  const setAsidePaise = await railPaise(d, 'goal_setaside_monthly_paise');
  const { rows, capped } = capToBudget(neverCut(suggestSips({
    sips, ranges: signed.ranges,
    actualBps: Object.fromEntries(types.map((t) => [t, actual.byType[t].shareBps])) as Record<FundType, number>,
    heldByType: Object.fromEntries(types.map((t) => [t, actual.byType[t].holdings])) as Record<FundType, ActualMix['byType'][FundType]['holdings']>,
    newFundNames: Object.fromEntries(choices.flatMap((x) => (x.top ? [[x.fundType, x.top.name]] : []))),
    leaving,
  })), investablePaise(budgetPaise, setAsidePaise));
  return {
    rows, capped, budgetPaise, setAsidePaise,
    currentPaise: sips.reduce((a, s) => a + s.amountPaise, 0n),
    suggestedPaise: rows.reduce((a, r) => a + r.suggestedPaise, 0n),
  };
}

/**
 * Batch B §5: a suggested SIP total never exceeds the monthly budget, and no SIP is cut. Over budget, the
 * increases share the room left by current SIPs pro rata, each floored to ₹100; the rounding remainder is
 * left unallocated. No room: no increase at all.
 */
export function capToBudget(rows: SipSuggestion[], budgetPaise: bigint): { rows: SipSuggestion[]; capped: boolean } {
  if (rows.reduce((a, r) => a + r.suggestedPaise, 0n) <= budgetPaise) return { rows, capped: false };
  const room = budgetPaise - rows.reduce((a, r) => a + r.currentPaise, 0n);
  const budget = formatInr(budgetPaise as Paise);
  const incOf = (r: SipSuggestion) => (r.suggestedPaise > r.currentPaise ? r.suggestedPaise - r.currentPaise : 0n);
  const allInc = rows.reduce((a, r) => a + incOf(r), 0n);
  return {
    capped: true,
    rows: rows.map((r) => {
      const inc = incOf(r);
      if (inc === 0n) return r;
      if (room <= 0n) return { ...r, suggestedPaise: r.currentPaise, reason: `${r.reason}; no increase — current SIPs already use the ${budget} budget` };
      const scaled = ((inc * room) / allInc / ROUND_PAISE) * ROUND_PAISE;
      return { ...r, suggestedPaise: r.currentPaise + scaled, reason: `${r.reason}; scaled to fit the ${budget} monthly budget` };
    }),
  };
}

/** What the SIP card may fill: the budget less the goal set-aside (CLAUDE.md: the set-aside is never invested). */
const investablePaise = (budgetPaise: bigint, setAsidePaise: bigint): bigint =>
  (budgetPaise > setAsidePaise ? budgetPaise - setAsidePaise : 0n);

/** The SIP card's cap, named: the plain budget, or what is invested once the set-aside is taken out. */
export function sipCapLabel(budgetPaise: bigint, setAsidePaise: bigint): string {
  const inr = (p: bigint) => formatInr(p as Paise);
  return setAsidePaise > 0n
    ? `the ${inr(investablePaise(budgetPaise, setAsidePaise))} you invest each month (budget ${inr(budgetPaise)} less ${inr(setAsidePaise)} set aside for house and emergency)`
    : `the ${inr(budgetPaise)} budget`;
}

/** Batch B §5: the SIP card's cap sentence; when current SIPs alone fill the cap, it says no increase is suggested. */
export function sipCapSentence(s: { currentPaise: bigint; budgetPaise: bigint; setAsidePaise: bigint; capped: boolean }): string {
  const label = sipCapLabel(s.budgetPaise, s.setAsidePaise);
  return s.currentPaise >= investablePaise(s.budgetPaise, s.setAsidePaise)
    ? `Current SIPs already use ${label}; no increase is suggested.`
    : `No SIP is ever suggested below its current amount, and increases are capped so the suggested total stays within ${label}${s.capped ? ' — this month they were scaled down to fit' : ''}.`;
}

/** Batch B §6: the tactical cap binds when it is below the free money (budget − SIPs − set-aside). Unknown SIPs: no warning. */
export function tacticalCapBinds(e: Pick<FreeEnvelope, 'budgetPaise' | 'tacticalPaise' | 'sipTotalPaise' | 'setAsidePaise'>): { capPaise: bigint; freePaise: bigint } | null {
  if (e.sipTotalPaise === null) return null;
  const freePaise = e.budgetPaise - e.sipTotalPaise - e.setAsidePaise;
  return e.tacticalPaise < freePaise ? { capPaise: e.tacticalPaise, freePaise } : null;
}
