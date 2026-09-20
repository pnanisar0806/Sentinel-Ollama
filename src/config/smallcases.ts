import { rupees, type Paise } from '../money/paise.js';

/**
 * The owner's four smallcases, decomposed to constituents.
 *
 * Captured from the smallcase app's own constituent screens on 2026-09-20 and verified
 * against INDmoney: smallcase ₹5,61,275 + direct ₹2,27,617 + Reliance Power at Groww
 * ₹2,387.69 = ₹7,91,279.69 against INDmoney's IND_STOCK total of ₹7,91,280.11, a
 * difference of 42 paise.
 *
 * The app's four line items sum to ₹5,61,273 while its own header reads ₹5,61,275 — a ₹2
 * rounding artifact, each line being shown to the whole rupee. The line items are what is
 * recorded here; nothing is tuned to make the header match.
 *
 * **Not derived from `data/docs/Smallcase/smallcase_orders.xlsx`.** That export holds
 * only a single 2026-07-15 rebalance batch for Timeless and Dividend Aristocrats, with
 * no opening `Invest`, and reading it as complete produced the wrong conclusion that the
 * smallcases had been selling the owner's directly-bought shares. The app screens are
 * ground truth; the order export is not.
 *
 * Every share count here matches the live INDmoney holding exactly, which is what
 * establishes that these holdings are wholly smallcase-owned. The one exception is
 * Pidilite: 19 of the 21 held shares are in Dividend Aristocrats and 2 are direct.
 */

export interface SmallcaseConstituent {
  instrumentId: string;
  units: number;
  /** The app's reported average buy price for this constituent. */
  avgBuyPricePaise: Paise;
}

export interface SmallcaseHolding {
  name: string;
  /** Current value per the app, for reconciliation only — never a valuation input. */
  currentValuePaise: Paise;
  constituents: SmallcaseConstituent[];
}

export const SMALLCASE_AS_OF = '2026-09-20';
export const SMALLCASE_SOURCE = 'smallcase-app';

const c = (instrumentId: string, units: number, avgRupees: string): SmallcaseConstituent =>
  ({ instrumentId, units, avgBuyPricePaise: rupees(avgRupees) });

export const SMALLCASES: SmallcaseHolding[] = [
  {
    name: 'Dividend Aristocrats Model',
    currentValuePaise: rupees('296363'),
    constituents: [
      c('IND:INDS01789', 7, '3295.06'),   // Sundaram Finance
      c('IND:INDS03891', 7, '3292.91'),   // Schaeffler India
      c('IND:INDS01632', 6, '3808.39'),   // KEI Industries
      c('IND:INDS00200', 19, '1324.21'),  // Pidilite — 2 more held directly
      c('IND:INDS00128', 34, '655.62'),   // Kirloskar Pneumatic
      c('IND:INDS03291', 14, '2349.94'),  // ZF Commercial Vehicle
      c('IND:INDS01052', 23, '1254.40'),  // Reliance Industries
      c('IND:INDS00083', 7, '5154.40'),   // CRISIL
      c('IND:INDS00365', 63, '546.78'),   // Berger Paints
      c('IND:INDS00972', 113, '319.74'),  // ITC
    ],
  },
  {
    name: 'Equity & Gold Asset Allocation',
    currentValuePaise: rupees('108269'),
    constituents: [
      c('IND:INDS29570', 1453, '21.83'),  // Zerodha Gold ETF
      c('IND:INDS19182', 275, '243.85'),  // Nifty 50 BeES
    ],
  },
  {
    name: 'Timeless Asset Allocation',
    currentValuePaise: rupees('88915'),
    constituents: [
      c('IND:INDS29570', 1163, '21.91'),  // Zerodha Gold ETF
      c('IND:INDS20619', 34, '722.18'),   // Nifty Next 50 Junior BeES
      c('IND:INDS28892', 140, '111.96'),  // Zerodha Nifty 1D Rate Liquid ETF
      c('IND:INDS19182', 68, '275.85'),   // Nifty 50 BeES
    ],
  },
  {
    name: 'House of Mahindra Tracker',
    currentValuePaise: rupees('67726'),
    constituents: [
      c('IND:INDS01150', 5, '2467.95'),   // Mahindra & Mahindra
      c('IND:INDS01694', 43, '287.05'),   // M&M Financial
      c('IND:INDS01469', 14, '1420.22'),  // Tech Mahindra
      c('IND:INDS02342', 43, '463.58'),   // Mahindra Lifespace
    ],
  },
];

/**
 * Units held through smallcases, per instrument, summed across every smallcase.
 * GOLDBEES and NIFTYBEES each appear in two, which is exactly why a flat
 * instrument-to-smallcase map would not do.
 */
export function smallcaseUnitsByInstrument(): Map<string, number> {
  const out = new Map<string, number>();
  for (const sc of SMALLCASES) {
    for (const k of sc.constituents) {
      out.set(k.instrumentId, (out.get(k.instrumentId) ?? 0) + k.units);
    }
  }
  return out;
}
