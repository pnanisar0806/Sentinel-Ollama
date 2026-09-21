import type { Db } from '../db/client.js';
import { paise, type Paise } from '../money/paise.js';
import { ASSUMPTIONS } from '../config/assumptions.js';
import { mulP } from '../money/paise.js';

/**
 * The owner's real ServiceNow RSU position, from Fidelity NetBenefits.
 *
 * Source: "Fidelity NetBenefits - Awards Details", captured 2026-09-21 23:35 IST, NOW at
 * $135.47. Six grants, 1,105 units granted in total, 400 still unvested.
 *
 * It replaces `SEED_RSU_GRANTS`, which was an approximation: the total of 1,105 was
 * right and **every grant but the last was wrong** — G2021 said 2021-11-15/120 units
 * where the real 12RUIN5012 is 2020-08-17/240, and so on down the list. `projectVests`
 * then spread each invented grant over uniform quarterly tranches, which is not how
 * these vest either: 25RUST vests ANNUALLY on 15 Feb and the two 21RUIN4A* grants
 * semi-annually. That is why the digest announced roughly ₹4L vesting on 15 Nov 2026
 * when the real tranche is 18 units.
 *
 * Units and dates are Fidelity's, transcribed. They do not move.
 */
export interface ActualGrant {
  id: string;
  grantedOn: string;
  units: number;
  cadence: 'QUARTERLY' | 'SEMI_ANNUAL' | 'ANNUAL';
  note: string;
}

export const FIDELITY_GRANTS: ActualGrant[] = [
  { id: '12RUIN5012', grantedOn: '2020-08-17', units: 240, cadence: 'QUARTERLY', note: 'Fully distributed' },
  { id: '21RUIN4A', grantedOn: '2022-02-15', units: 185, cadence: 'SEMI_ANNUAL', note: 'Fully distributed' },
  { id: '21RUIN4A1', grantedOn: '2023-02-15', units: 170, cadence: 'SEMI_ANNUAL', note: 'Vests 17 Feb / 17 Aug' },
  { id: '21RUIN4A3', grantedOn: '2024-02-15', units: 130, cadence: 'SEMI_ANNUAL', note: 'Vests 07 Feb / 07 Aug' },
  { id: '25RUST', grantedOn: '2025-02-18', units: 95, cadence: 'ANNUAL', note: 'Vests 15 Feb' },
  { id: '26RSU', grantedOn: '2026-02-17', units: 285, cadence: 'QUARTERLY', note: 'Vests 15 Feb/May/Aug/Nov' },
];

export interface ActualVest {
  grantId: string;
  vestOn: string;
  units: number;
  /** The tranche's outstanding value AS THE STATEMENT PRINTS IT, in paise. */
  grossPaise: bigint;
}

/**
 * Fidelity prints a value per tranche, and those values are used verbatim.
 *
 * They are NOT derived by multiplying a per-unit figure: the implied unit value is
 * ₹12,980.0583, which is not a whole paise, so 18 × a rounded unit gives ₹2,33,640.90
 * against the statement's ₹2,33,641.05. The document's own numbers are the evidence.
 *
 * The five distinct tranche sizes each map to one value throughout the statement:
 * 25 → ₹3,24,501.45, 20 → ₹2,59,601.16, 18 → ₹2,33,641.05, 17 → ₹2,20,660.99,
 * 15 → ₹1,94,700.87.
 */
const V25 = 32_450_145n;
const V20 = 25_960_116n;
const V18 = 23_364_105n;
const V17 = 22_066_099n;
const V15 = 19_470_087n;

/**
 * Every tranche Fidelity lists as Unvested, in date order. 400 units across 21 tranches.
 *
 * Distributed tranches are deliberately absent: they are no longer a pipeline, and the
 * shares they produced are already in `holdings` as the US:NOW position.
 */
export const FIDELITY_UNVESTED: ActualVest[] = [
  { grantId: '26RSU', vestOn: '2026-11-15', units: 18, grossPaise: V18 },
  { grantId: '21RUIN4A3', vestOn: '2027-02-07', units: 15, grossPaise: V15 },
  { grantId: '25RUST', vestOn: '2027-02-15', units: 25, grossPaise: V25 },
  { grantId: '26RSU', vestOn: '2027-02-15', units: 18, grossPaise: V18 },
  { grantId: '21RUIN4A1', vestOn: '2027-02-17', units: 25, grossPaise: V25 },
  { grantId: '26RSU', vestOn: '2027-05-15', units: 18, grossPaise: V18 },
  { grantId: '21RUIN4A3', vestOn: '2027-08-07', units: 15, grossPaise: V15 },
  { grantId: '26RSU', vestOn: '2027-08-15', units: 17, grossPaise: V17 },
  { grantId: '26RSU', vestOn: '2027-11-15', units: 18, grossPaise: V18 },
  { grantId: '21RUIN4A3', vestOn: '2028-02-07', units: 20, grossPaise: V20 },
  { grantId: '25RUST', vestOn: '2028-02-15', units: 25, grossPaise: V25 },
  { grantId: '26RSU', vestOn: '2028-02-15', units: 18, grossPaise: V18 },
  { grantId: '26RSU', vestOn: '2028-05-15', units: 18, grossPaise: V18 },
  { grantId: '26RSU', vestOn: '2028-08-15', units: 18, grossPaise: V18 },
  { grantId: '26RSU', vestOn: '2028-11-15', units: 17, grossPaise: V17 },
  { grantId: '25RUST', vestOn: '2029-02-15', units: 25, grossPaise: V25 },
  { grantId: '26RSU', vestOn: '2029-02-15', units: 18, grossPaise: V18 },
  { grantId: '26RSU', vestOn: '2029-05-15', units: 18, grossPaise: V18 },
  { grantId: '26RSU', vestOn: '2029-08-15', units: 18, grossPaise: V18 },
  { grantId: '26RSU', vestOn: '2029-11-15', units: 18, grossPaise: V18 },
  { grantId: '26RSU', vestOn: '2030-02-15', units: 18, grossPaise: V18 },
];

export const FIDELITY_AS_OF = '2026-09-21';
export const FIDELITY_SOURCE = 'fidelity-awards-details';

/**
 * What the statement's header prints as Total outstanding.
 *
 * The 21 tranche values sum to ₹51,92,023.28 — **six paise more**. That is Fidelity's
 * own rounding: it rounds each tranche to the paisa and computes the header from the
 * unrounded unit value. The gap is documented rather than closed, because closing it
 * would mean altering one of the two figures the statement actually prints. Owner
 * true-up if it ever matters; at six paise on ₹51.9L it does not.
 */
export const FIDELITY_TOTAL_OUTSTANDING_PAISE = 519_202_322n;
export const FIDELITY_TRANCHE_SUM_PAISE = 519_202_328n;

export function grossFor(v: ActualVest): Paise {
  return paise(v.grossPaise);
}

/**
 * Replaces the projected pipeline with Fidelity's own schedule.
 *
 * An owner-CONFIRMED vest (`status = 'ACTUAL'`) is never touched: FR-03 says a
 * projection may not overwrite one, and a statement of what is still unvested says
 * nothing about a tranche the owner has already reconciled.
 */
export async function seedActualRsu(db: Db): Promise<{ grants: number; vests: number }> {
  let grants = 0;
  for (const g of FIDELITY_GRANTS) {
    const rows = await db.query<{ id: string }>(
      `insert into rsu_grants (id, granted_on, units, cadence, scenario, note)
       values ($1, $2, $3, $4, 'ACTUAL', $5)
       on conflict (id) do update
          set granted_on = excluded.granted_on, units = excluded.units,
              cadence = excluded.cadence, note = excluded.note
       returning id`,
      [g.id, g.grantedOn, g.units, g.cadence, g.note],
    );
    grants += rows.length;
  }

  let vests = 0;
  for (const v of FIDELITY_UNVESTED) {
    const gross = grossFor(v);
    const net = mulP(gross, ASSUMPTIONS.rsuNetOfWithholding);
    const rows = await db.query<{ id: string }>(
      `insert into rsu_vests
         (grant_id, vest_on, units, status, gross_paise, net_paise, as_of, source)
       values ($1, $2, $3, 'PROJECTED', $4, $5, $6, $7)
       on conflict (grant_id, vest_on) do update
          set units = excluded.units, gross_paise = excluded.gross_paise,
              net_paise = excluded.net_paise, as_of = excluded.as_of,
              source = excluded.source
        where rsu_vests.status <> 'ACTUAL'
       returning id`,
      [v.grantId, v.vestOn, v.units, gross.toString(), net.toString(),
       `${FIDELITY_AS_OF}T18:05:00Z`, FIDELITY_SOURCE],
    );
    vests += rows.length;
  }
  return { grants, vests };
}
