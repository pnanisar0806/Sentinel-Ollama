import { createHash } from 'node:crypto';
import type { Db } from '../db/client.js';
import { chooseIndexFund, loadIndexFundRows, type IndexFundType } from '../sources/index-funds.js';
import { IPS_BANDS } from './allocation.js';
import { fundAliases, loadActualMix, loadFundCandidates, loadSignedMix, sameFund, typeOf } from './fund-mix.js';
import { loadFundMoves } from './fund-moves.js';
import { FUND_TYPE_LABEL, byGap, midBps, type FundType } from './fund-types.js';
import { loadLumpSum, openLumpSumPaise } from './lump-sums.js';
import { universeInstrumentId } from './mf-universe.js';
import { EXCHANGE_TRADED, freshQuote, stocksWait, type Candidate, type SizingInput } from './sizing.js';
import { loadSizingInput } from './sizing-input.js';

/**
 * Lump-sum sizing (batch B §3). Every eligible destination is sized **independently** against
 * the whole lump sum — no tranche is shared — and the advisor then picks an ordered subset,
 * which `allocateLumpSum` fills in that order. Only BUYs; the model never states an amount.
 *
 * Wider than the monthly plan on purpose (spec §3 "Scope"): a held fund takes money while its
 * type is below the range max (not the midpoint), a fund not yet held is open (the switch
 * check's pick, or the index fund chooser's for an index type with no top-uppable fund), and
 * gold is open while below its IPS band max. Stocks wait exactly as in `sizeCandidates`.
 *
 * Note for the advisor: this module reaches `fund-mix.ts` (the owner's signature), which the
 * advisor firewall forbids — `src/advisor/` must not import it, not even for a type.
 */
export const LUMP_POLICY = 'lump-v1';

export interface NewFund {
  instrumentId: string; name: string; fundType: FundType; why: string;
  /** The type's actual share and signed range, in bps — the headroom and `Candidate.fund`. */
  actualBps: number; minBps: number; midBps: number; maxBps: number;
}

export interface LumpSizingInput {
  lumpSumId: string;
  remainingPaise: bigint;
  /** `funds` loaded `upToMax`; `reservedPaise` is open orders plus every *other* open lump sum. */
  sizing: SizingInput;
  /** All held equity funds, the base the fund-type shares are of. */
  fundTotalPaise: bigint;
  /** Held value per fund type (the numerator of its share), for the exact room to its max. */
  typeValuePaise: Partial<Record<FundType, bigint>>;
  newFunds: NewFund[];
  /** `goldPaise` is every held GOLD instrument; `actualBps` (floored) is for display only. */
  gold: { instrumentId: string; name: string; kind: string; actualBps: number; maxBps: number; portfolioPaise: bigint; goldPaise: bigint } | null;
}

/** Limits the picks share; `allocateLumpSum` spends them down across parts. */
export interface LumpLimits {
  freeCashPaise: bigint;
  typeRoomPaise: Partial<Record<FundType, bigint>>;
  goldRoomPaise: bigint | null;
}

const INDEX_TYPES: IndexFundType[] = ['NIFTY50', 'NEXT50', 'US'];
const GOLD_MAX_BPS = Math.round(IPS_BANDS.GOLD.max * 10_000);

export async function loadLumpSizingInput(db: Db, lumpSumId: string, asOf: string, now = new Date()): Promise<LumpSizingInput> {
  const lump = await loadLumpSum(db, lumpSumId);
  if (lump === null) throw new Error(`no lump sum ${lumpSumId} (missing or reversed)`);
  const base = await loadSizingInput(db, asOf, now);
  const funds = await loadFundCandidates(db, asOf, { upToMax: true });
  // loadSizingInput reserves every open lump sum, this one included; it is the money being sized.
  const otherLumps = await openLumpSumPaise(db, lumpSumId);
  const sizing: SizingInput = { ...base, funds, reservedPaise: base.reservedPaise - await openLumpSumPaise(db) + otherLumps };

  const mix = await loadActualMix(db);
  const signed = await loadSignedMix(db);
  const newFunds: NewFund[] = [];
  if (signed !== null) {
    const range = new Map(signed.ranges.map((r) => [r.type, r]));
    /** A held copy of the fund, by alias or scheme code: its own verdict ("kept, not topped up", …) stands. */
    const heldCopy = async (instrumentId: string, t: FundType): Promise<boolean> => {
      const held = mix.byType[t].holdings.map((h) => h.instrumentId);
      if (held.length === 0) return false;
      const own = await fundAliases(db, instrumentId);
      for (const h of held) if (sameFund(own, await fundAliases(db, h))) return true;
      if (!instrumentId.startsWith('MFU:')) return false;
      const bySchemeCode = await db.query(
        `select 1 from instruments a join instruments b on b.id = a.id or (a.canonical_id is not null and b.canonical_id = a.canonical_id)
          where a.id = any($1::text[]) and b.scheme_code = $2 limit 1`, [held, instrumentId.slice(4)]);
      return bySchemeCode.length > 0;
    };
    const add = async (instrumentId: string, name: string, t: FundType, why: string): Promise<void> => {
      const r = range.get(t);
      if (r === undefined || !r.newMoney) return;
      if (funds.buys.some((b) => b.instrumentId === instrumentId) || newFunds.some((f) => f.instrumentId === instrumentId)) return;
      if (await heldCopy(instrumentId, t)) return;
      newFunds.push({ instrumentId, name, fundType: t, why, actualBps: mix.byType[t].shareBps, minBps: r.minBps, midBps: midBps(r), maxBps: r.maxBps });
    };
    // The /funds switch check's pick for a held fund: same category, so the held fund's type.
    for (const m of (await loadFundMoves(db, asOf)).moves) {
      if (m.units.kind !== 'move') continue;
      const t = (await typeOf(db, m.instrumentId))?.type;
      if (t !== undefined) await add(m.units.toId, m.units.toName, t, `the switch check's pick over ${m.name}: ${m.units.why}`);
    }
    // An index type no held fund can top up (e.g. Junior BeES and VOO are kept, never topped up).
    const { rows } = await loadIndexFundRows(db);
    for (const t of INDEX_TYPES) {
      if (mix.byType[t].holdings.some((h) => h.topUp)) continue;
      const top = chooseIndexFund(rows, t).top;
      // A ranked row is always a verified AMFI Direct Growth scheme (`chooseIndexFund`).
      if (top !== null) await add(universeInstrumentId(top.amfiSchemeCode!), top.name, t, `the index fund chooser's pick for ${FUND_TYPE_LABEL[t]}`);
    }
  }

  // Gold: the largest held exchange-traded GOLD instrument, while gold is below its band max.
  const goldValue = new Map<string, bigint>();
  for (const h of sizing.holdings) if (h.kind === 'GOLD') goldValue.set(h.instrumentId, (goldValue.get(h.instrumentId) ?? 0n) + h.valuePaise);
  const goldTotal = [...goldValue.values()].reduce((a, b) => a + b, 0n);
  const largest = [...goldValue].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0].localeCompare(b[0])))[0];
  let gold: LumpSizingInput['gold'] = null;
  if (largest !== undefined && goldTotal * 10_000n < BigInt(GOLD_MAX_BPS) * sizing.portfolioPaise) {
    const actualBps = Number((goldTotal * 10_000n) / sizing.portfolioPaise);
    const [i] = await db.query<{ name: string }>(`select name from instruments where id = $1`, [largest[0]]);
    gold = { instrumentId: largest[0], name: i?.name ?? largest[0], kind: 'GOLD', actualBps, maxBps: GOLD_MAX_BPS, portfolioPaise: sizing.portfolioPaise, goldPaise: goldTotal };
  }

  const typeValuePaise = Object.fromEntries(Object.entries(mix.byType).map(([t, v]) => [t, v.valuePaise])) as Record<FundType, bigint>;
  return { lumpSumId, remainingPaise: lump.remainingPaise, sizing, fundTotalPaise: mix.totalPaise, typeValuePaise, newFunds, gold };
}

const min = (...xs: bigint[]): bigint => xs.reduce((m, x) => (x < m ? x : m));
const rupees = (p: bigint) => `₹${p / 100n}`;
type Base = Pick<Candidate, 'instrumentId' | 'name' | 'vehicle' | 'fund'>;

function withLumpId(lumpSumId: string, asOf: string, c: Omit<Candidate, 'id' | 'policyVersion'>): Candidate {
  const key = JSON.stringify([lumpSumId, c.instrumentId, String(c.amountPaise), c.units, asOf, LUMP_POLICY]);
  return { ...c, id: createHash('sha256').update(key).digest('hex').slice(0, 16), policyVersion: LUMP_POLICY };
}

/**
 * Room to a fund type's max in paise: `max × fundTotal − held`, from the exact held value, never
 * the floored share. Conservative: buying grows the fund total too, so the true room is a little larger.
 */
const typeRoom = (i: LumpSizingInput, t: FundType, maxBps: number): bigint =>
  (BigInt(maxBps) * i.fundTotalPaise) / 10_000n - (i.typeValuePaise[t] ?? 0n);
/** Room to gold's band max: bought from bank cash, which is already in the portfolio, so the base does not grow. */
const goldRoom = (g: NonNullable<LumpSizingInput['gold']>): bigint => (BigInt(g.maxBps) * g.portfolioPaise) / 10_000n - g.goldPaise;

/** Pure. What the picks share: free cash, each fund type's room to its max, gold's room. */
export function lumpLimits(i: LumpSizingInput): LumpLimits {
  const s = i.sizing;
  const typeRoomPaise: LumpLimits['typeRoomPaise'] = {};
  for (const f of [...s.funds.buys, ...i.newFunds]) typeRoomPaise[f.fundType] = typeRoom(i, f.fundType, f.maxBps);
  return {
    freeCashPaise: s.cashAvailablePaise === null ? 0n : s.cashAvailablePaise - s.reservedPaise,
    typeRoomPaise,
    goldRoomPaise: i.gold === null ? null : goldRoom(i.gold),
  };
}

/** Pure. Every destination's ceiling is `min(left of the lump sum, max order, free cash, its headroom)`. */
export function sizeLumpSum(i: LumpSizingInput): Candidate[] {
  const s = i.sizing;
  const out: Candidate[] = [];
  const cash = s.cashAvailablePaise === null ? null : s.cashAvailablePaise - s.reservedPaise;
  const schemeCap = (s.portfolioPaise * BigInt(Math.round(s.singleSchemeCapPct * 100))) / 10_000n;
  const stockCap = (s.portfolioPaise * BigInt(Math.round(s.singleStockCapPct * 100))) / 10_000n;

  /**
   * `full` is why there is no headroom; `heldPaise` (funds only) is checked against the
   * single-scheme cap; `blocked` withholds before anything else (stocks waiting on funds).
   */
  const size = (b: Base, kind: string, headroom: bigint, label: string, full: string, heldPaise: bigint | null = null, blocked: string | null = null): void => {
    const push = (c: Partial<Candidate>): void => {
      out.push(withLumpId(i.lumpSumId, s.asOf, {
        action: 'BUY', ...b, status: 'WITHHELD', withheldReason: null, amountPaise: null, units: null, pricePaise: null, quoteAsOf: null,
        basis: '', constraints: [], ...c,
      }));
    };
    const withhold = (reason: string): void => push({ withheldReason: reason });
    if (blocked !== null) return withhold(blocked);
    if (i.remainingPaise <= 0n) return withhold('nothing is left of this lump sum');
    if (cash === null) return withhold('cash available cannot be established');
    if (cash <= 0n) return withhold('no free cash after the emergency fund, open requests and other lump sums');
    if (headroom <= 0n) return withhold(full);
    let amount = min(i.remainingPaise, s.maxOrderPaise, cash, headroom);
    if (amount <= 0n) return withhold('the max order rail is 0');
    // Withheld, never clamped, as in `sizeCandidates`.
    if (heldPaise !== null && heldPaise + amount > schemeCap) return withhold(`would take it above the ${s.singleSchemeCapPct}% single-scheme cap (IPS §3.5)`);
    const basis = `min(lump sum left ${rupees(i.remainingPaise)}, max order ${rupees(s.maxOrderPaise)}, free cash ${rupees(cash)}, ${label} ${rupees(headroom)})`;
    if (!EXCHANGE_TRADED.has(kind)) return push({ status: 'ELIGIBLE', amountPaise: amount, basis });
    const q = freshQuote(s, b.instrumentId);
    if (typeof q === 'string') return withhold(q);
    const n = amount / q.pricePaise;
    if (n === 0n) return withhold(`one unit costs more than the ${rupees(amount)} available`);
    amount = n * q.pricePaise;
    push({ status: 'ELIGIBLE', amountPaise: amount, units: n.toString(), pricePaise: q.pricePaise, quoteAsOf: q.asOf, basis });
  };

  for (const f of [...s.funds.buys].sort(byGap)) {
    size({ instrumentId: f.instrumentId, name: f.name, vehicle: 'FUND',
      fund: { fundType: f.fundType, actualBps: f.actualBps, midBps: f.midBps, minBps: f.minBps, maxBps: f.maxBps, quality: f.quality } },
    f.kind, typeRoom(i, f.fundType, f.maxBps), `${FUND_TYPE_LABEL[f.fundType]} room to its max`, `${FUND_TYPE_LABEL[f.fundType]} is at its range max`, f.heldPaise);
  }
  for (const f of i.newFunds) {
    size({ instrumentId: f.instrumentId, name: f.name, vehicle: 'FUND',
      fund: { fundType: f.fundType, actualBps: f.actualBps, midBps: f.midBps, minBps: f.minBps, maxBps: f.maxBps, quality: f.why } },
    'MF', typeRoom(i, f.fundType, f.maxBps), `${FUND_TYPE_LABEL[f.fundType]} room to its max`, `${FUND_TYPE_LABEL[f.fundType]} is at its range max`, 0n);
  }
  if (i.gold !== null) {
    const g = i.gold;
    size({ instrumentId: g.instrumentId, name: g.name, vehicle: 'FUND', fund: null },
      g.kind, goldRoom(g), `gold room to its ${g.maxBps / 100}% band max`, 'gold is at its IPS band max');
  }
  const wait = stocksWait(s.funds);
  const holding = new Map<string, bigint>(); // one per instrument, summed across accounts
  for (const h of s.holdings) holding.set(h.instrumentId, (holding.get(h.instrumentId) ?? 0n) + h.valuePaise);
  for (const b of [...s.buys].sort((x, y) => y.score - x.score || x.instrumentId.localeCompare(y.instrumentId))) {
    size({ instrumentId: b.instrumentId, name: b.name, vehicle: 'STOCK', fund: null }, b.kind, stockCap - (holding.get(b.instrumentId) ?? 0n),
      'single-stock cap headroom', `already at the ${s.singleStockCapPct}% single-stock cap`, null, wait);
  }
  return out;
}

/**
 * Pure. Walks the advisor's picks in order; each part is `min(its ceiling, what is left)`,
 * floored to whole units for an exchange-traded pick. A part with 0 units is dropped and its
 * money stays for the next pick. Unknown, WITHHELD and repeated ids are skipped. Never a ₹0 part.
 *
 * With `limits` (`lumpLimits`), picks also share them: the total never exceeds free cash, two
 * funds of one type never exceed that type's room together, and gold never its room. Gold is the
 * one lump-sum candidate with vehicle FUND and no `fund`. A stock's cap is per instrument already.
 */
export function allocateLumpSum(
  candidates: Candidate[], chosenIds: string[], remainingPaise: bigint, limits?: LumpLimits,
): { candidate: Candidate; amountPaise: bigint; units: string | null }[] {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const out: { candidate: Candidate; amountPaise: bigint; units: string | null }[] = [];
  const used = new Set<string>();
  const typeRoom = { ...limits?.typeRoomPaise };
  let goldRoom = limits?.goldRoomPaise ?? null;
  let left = limits === undefined ? remainingPaise : min(remainingPaise, limits.freeCashPaise);
  for (const id of chosenIds) {
    if (left <= 0n) break;
    const c = byId.get(id);
    if (c === undefined || c.status !== 'ELIGIBLE' || c.amountPaise === null || used.has(id)) continue;
    used.add(id);
    const t = c.fund?.fundType;
    const isGold = c.vehicle === 'FUND' && c.fund === null;
    let amount = min(c.amountPaise, left);
    if (limits !== undefined && t !== undefined) amount = min(amount, typeRoom[t] ?? 0n);
    if (limits !== undefined && isGold) amount = min(amount, goldRoom ?? 0n);
    let units: string | null = null;
    if (c.pricePaise !== null) {
      const n = amount / c.pricePaise;
      if (n === 0n) continue;
      amount = n * c.pricePaise; units = n.toString();
    }
    if (amount <= 0n) continue;
    out.push({ candidate: c, amountPaise: amount, units });
    left -= amount;
    if (t !== undefined && typeRoom[t] !== undefined) typeRoom[t] -= amount;
    if (isGold && goldRoom !== null) goldRoom -= amount;
  }
  return out;
}
