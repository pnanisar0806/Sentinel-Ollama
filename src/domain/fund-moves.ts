import type { Db } from '../db/client.js';
import { chooseIndexFund, loadIndexFundRows, type IndexFundType } from '../sources/index-funds.js';
import { LTCG_EXEMPTION_PER_FY } from './cleanup.js';
import { fundAliases, sameFund, typeOf } from './fund-mix.js';
import { indexChallenger } from './index-switch.js';
import { loadMfMetadata } from './mf-metadata.js';
import { heldFunds } from './mf-ranking.js';
import { evaluateSwitches, type SwitchCandidate } from './mf-switch.js';
import { universeInstrumentId } from './mf-universe.js';
import { loadPositions } from './networth.js';
import { loadActiveSipMoves } from './owner-log.js';
import { loadSipCommitment, sipUnknownReason } from './sips.js';

/**
 * Fund switch spec §4: two answers per held fund — one for its SIP (new money, no tax) and
 * one for its accumulated units (a sale that realises gains). Both come from the same
 * challenger and the same bar; the units answer differs only by showing what the move costs.
 * Never a rupee tax estimate: Sentinel has no fund purchase dates, so the long/short split
 * is unknown.
 */
export type SipAnswer =
  | { kind: 'none' }
  /** The SIP feed is stale or its total unknown: Sentinel cannot say whether a SIP runs. */
  | { kind: 'unknown'; reason: string }
  | { kind: 'keep'; amountPaise: bigint }
  | { kind: 'move'; amountPaise: bigint; toId: string; toName: string; why: string }
  | { kind: 'moved'; moveId: string; amountPaise: bigint; toId: string; toName: string; firstMonth: string; loggedOn: string };
export type UnitsAnswer =
  | { kind: 'keep'; why: string }
  | { kind: 'move'; toId: string; toName: string; why: string; valuePaise: bigint; investedPaise: bigint | null; gainPaise: bigint | null };
export interface FundMove { instrumentId: string; name: string; category: string; isIndex: boolean; sip: SipAnswer; units: UnitsAnswer }

/** Index funds are compared only with funds tracking the same index (§4.4), on cost. */
const INDEX_TYPES: ReadonlySet<string> = new Set<IndexFundType>(['NIFTY50', 'NEXT50', 'US']);

export async function loadFundMoves(db: Db, asOf: string): Promise<{ moves: FundMove[]; ltcgExemptionPaise: bigint }> {
  const positions = (await loadPositions(db)).filter((p) => p.kind === 'MF');
  const held = await heldFunds(db, positions); // one per position, same order

  // One fund per instrument (a fund held in two accounts is one holding). Invested is
  // INDmoney's total invested per account (src/sources/indmoney.ts), so it sums; one
  // unknown account makes the fund's invested unknown, never 0. A cost carried over from a
  // retired seed row predates the SIP units bought since, so it is unknown here too.
  const funds = new Map<string, { h: (typeof held)[number]; valuePaise: bigint; investedPaise: bigint | null }>();
  held.forEach((h, i) => {
    const p = positions[i]!;
    const cost = p.costFromSeed ? null : p.avgCostPaise;
    const f = funds.get(h.instrumentId);
    if (!f) funds.set(h.instrumentId, { h, valuePaise: h.valuePaise, investedPaise: cost });
    else {
      f.valuePaise += h.valuePaise;
      f.investedPaise = f.investedPaise === null || cost === null ? null : f.investedPaise + cost;
    }
  });

  // SIPs and logged moves join a fund through its aliases (`fundAliases`: canonical id, ISINs,
  // a feed row's own ISIN), as the SIP card does, so a feed or a move filed under the seed
  // MF:* id reaches the live IND:* holding.
  const commitment = await loadSipCommitment(db, asOf);
  const sipUnknown = commitment.totalPaise === null ? sipUnknownReason(commitment) : null;
  const isinOf = new Map((await db.query<{ sip_id: string; isin: string }>(
    `select distinct sip_id, isin from sips where isin is not null and sip_id = any($1::text[])`, [commitment.sips.map((s) => s.sipId)],
  )).map((r) => [r.sip_id, r.isin]));
  const sips = await Promise.all(commitment.sips.map(async (s) => ({
    amountPaise: s.amountPaise, aliases: await fundAliases(db, s.instrumentId, isinOf.get(s.sipId) ?? null) })));
  const moved = await Promise.all((await loadActiveSipMoves(db)).map(async (m) => ({ m, aliases: await fundAliases(db, m.fromInstrumentId) })));

  const index = (await loadIndexFundRows(db)).rows;
  const metadata = await loadMfMetadata(db);
  let switches: SwitchCandidate[] | null = null;

  const moves: FundMove[] = [];
  for (const [id, { h, valuePaise, investedPaise }] of funds) {
    const typing = await typeOf(db, id);
    const isIndex = typing !== null && INDEX_TYPES.has(typing.type);
    let to: { id: string; name: string } | null;
    let why: string;
    if (isIndex) {
      const indId = id.startsWith('IND:') ? id : null;
      const own = indId === null ? undefined : index.find((r) => r.indmoneyFundId === indId.slice(4));
      const expenseRatioBps = own !== undefined ? own.expenseRatioBps
        : (metadata.get(id) ?? metadata.get(h.navInstrumentId))?.expenseRatioBps ?? null;
      const r = indexChallenger({ indmoneyFundId: indId, expenseRatioBps }, chooseIndexFund(index, typing.type as IndexFundType));
      // A ranked challenger is always a verified AMFI Direct Growth scheme (`chooseIndexFund`).
      to = r.challenger && { id: universeInstrumentId(r.challenger.amfiSchemeCode!), name: r.challenger.name };
      why = r.reason;
    } else {
      switches ??= await evaluateSwitches(db, asOf.slice(0, 10));
      const s = switches.find((x) => x.heldInstrumentId === id);
      to = !s || s.challengerId === null ? null : { id: s.challengerId, name: s.challengerName ?? s.challengerId };
      why = s?.reason ?? 'not in the switch check';
    }

    const own = await fundAliases(db, id);
    const m = moved.find((x) => sameFund(x.aliases, own))?.m; // newest first
    const mine = sips.filter((s) => sameFund(s.aliases, own));
    const amountPaise = mine.length === 0 ? undefined : mine.reduce((a, s) => a + s.amountPaise, 0n);
    const sip: SipAnswer = m ? { kind: 'moved', moveId: m.id, amountPaise: m.amountPaise, toId: m.toInstrumentId, toName: m.toName, firstMonth: m.firstMonth, loggedOn: m.on }
      : sipUnknown !== null ? { kind: 'unknown', reason: sipUnknown }
      : amountPaise === undefined ? { kind: 'none' }
      : to ? { kind: 'move', amountPaise, toId: to.id, toName: to.name, why }
      : { kind: 'keep', amountPaise };
    const units: UnitsAnswer = to
      ? { kind: 'move', toId: to.id, toName: to.name, why, valuePaise, investedPaise,
          gainPaise: investedPaise === null ? null : valuePaise - investedPaise }
      : { kind: 'keep', why };
    moves.push({ instrumentId: id, name: h.name, category: h.category ?? 'uncategorised', isIndex, sip, units });
  }
  return { moves, ltcgExemptionPaise: LTCG_EXEMPTION_PER_FY };
}
