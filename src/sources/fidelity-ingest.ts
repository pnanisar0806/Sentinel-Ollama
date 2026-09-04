import type { LlmProposal } from './llm-extract.js';

/**
 * Fidelity NetBenefits RSU statement extraction.
 * Fidelity statements show vesting events with:
 * - Grant ID / Award number
 * - Vest date
 * - Units vested
 * - Price per unit at vest
 * - Withholding (typically 30% for US)
 */
export interface FidelityRsuVest {
  grantId: string;
  vestOn: string;
  units: number;
  priceUsd: number;
  withholdingPct: number;
  netUnits: number;
}

export interface FidelityProposal {
  grantId: string;
  vestOn: string;
  units: number;
  priceUsdCents: bigint;
  usdInrMicros: bigint;
  grossPaise: bigint;
  netPaise: bigint;
  acquiredOn: string;
  confidence: string;
}

/**
 * Prompt for extracting Fidelity RSU vest events from a statement image.
 * The output feeds directly into `confirmVest` in rsu.ts.
 */
export const FIDELITY_EXTRACTION_PROMPT = `
You are extracting RSU vesting events from a Fidelity NetBenefits statement screenshot.
Output ONLY valid JSON matching this TypeScript interface:

type FidelityRsuVest = {
  grantId: string;        // e.g., "G2026", "RSU-2024-001", "Award #12345"
  vestOn: string;         // "YYYY-MM-DD" (vest date)
  units: number;          // units vested this tranche
  priceUsd: number;       // price per unit at vest (e.g., 185.47)
  withholdingPct: number; // withholding percentage (e.g., 30 for 30%)
  netUnits: number;       // units after withholding
};

type Output = { vests: FidelityRsuVest[] };

Rules:
- Each vest event = one row in the statement's vesting table
- Grant ID: use the award/grant identifier Fidelity shows (may be alphanumeric)
- Date: parse to YYYY-MM-DD; Fidelity typically shows MM/DD/YYYY
- Price: the market price at vest (not grant price)
- Withholding: usually 30% for US federal; if not shown, use 30
- Net units = units * (1 - withholdingPct/100), rounded to 4 decimals
- If a field is unreadable, use null (not 0)
- Do NOT invent vest events not visible in the image
- The statement may show multiple grants; extract ALL vest events

Example output:
{
  "vests": [
    {
      "grantId": "G2026",
      "vestOn": "2026-08-15",
      "units": 71.25,
      "priceUsd": 185.47,
      "withholdingPct": 30,
      "netUnits": 49.875
    }
  ]
}
`;

/**
 * Convert Fidelity vest events to the internal LlmProposal format
 * for the existing /confirm flow.
 */
export function fidelityVestsToProposals(
  vests: FidelityRsuVest[],
  usdInrRate: number
): FidelityProposal[] {
  return vests.map((v) => {
    const priceCents = BigInt(Math.round(v.priceUsd * 100));
    const usdInrMicros = BigInt(Math.round(usdInrRate * 1_000_000));
    const grossUsdCents = priceCents * BigInt(Math.round(v.units * 10000));
    const grossInrPaise = (grossUsdCents * usdInrMicros) / 1_000_000n;
    const netInrPaise = (grossInrPaise * BigInt(Math.round((100 - v.withholdingPct) * 100))) / 10000n;

    return {
      grantId: v.grantId,
      vestOn: v.vestOn,
      units: v.units,
      priceUsdCents: priceCents,
      usdInrMicros,
      grossPaise: grossInrPaise,
      netPaise: netInrPaise,
      acquiredOn: v.vestOn,
      confidence: 'HIGH',
    };
  });
}

/**
 * Check if a proposal already exists in the database (by grant_id + vest_on).
 * Fidelity vests are immutable once confirmed (FR-03).
 */
export async function checkFidelityVestExists(
  db: { query<T = { id: string }>(sql: string, params: unknown[]): Promise<T[]> },
  grantId: string,
  vestOn: string
): Promise<boolean> {
  const rows = await db.query<{ id: string }>(
    `select id from rsu_vests where grant_id = $1 and vest_on = $2 and status = 'ACTUAL'`,
    [grantId, vestOn],
  );
  return rows.length > 0;
}