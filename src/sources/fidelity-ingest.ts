import { UNITS_SCALE, toUnitsMicros } from '../domain/rsu.js';
import { extractJsonFromImage } from './llm-extract.js';
import { rateMicros, usdToInr } from '../money/fx.js';
import { cents, mulP, type Cents, type Paise } from '../money/paise.js';

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
  /** Units after withholding — display info only; every money computation below uses
   *  gross units and `withholdingPct`, so this stays optional. */
  netUnits?: number;
}

export interface FidelityProposal {
  grantId: string;
  vestOn: string;
  units: number;
  priceUsdCents: Cents;
  usdInrMicros: bigint;
  grossPaise: Paise;
  netPaise: Paise;
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
 * Convert Fidelity vest events into priced proposals for the /confirm queue. All integer
 * math, sharing `confirmVest`'s own conventions so the confirmation never red-lights:
 * `unitsMicros = units * 1e6` (UNITS_SCALE in rsu.ts), USD gross = priceUsdCents x
 * unitsMicros / 1e6, then `usdToInr` at `rateMicros(usdInrRate)`. net = gross x
 * (100 - withholdingPct)/100 via `mulP`, so net always sits at or below the recomputed
 * gross that `confirmVest` checks.
 */
export function fidelityVestsToProposals(
  vests: FidelityRsuVest[],
  usdInrRate: number
): FidelityProposal[] {
  const usdInrMicros = rateMicros(usdInrRate);
  return vests.map((v) => {
    // The price arrives as a JSON float from the LLM, so it is quantized to cents here
    // (never parsed as a decimal string — there is none). Units share the same treatment.
    const priceUsdCents = cents(BigInt(Math.round(v.priceUsd * 100)));
    const unitsMicros = toUnitsMicros(v.units);
    const grossPaise = usdToInr(cents((priceUsdCents * unitsMicros) / UNITS_SCALE), usdInrMicros);
    const netPaise = mulP(grossPaise, (100 - v.withholdingPct) / 100);

    return {
      grantId: v.grantId,
      vestOn: v.vestOn,
      units: v.units,
      priceUsdCents,
      usdInrMicros,
      grossPaise,
      netPaise,
      acquiredOn: v.vestOn,
      confidence: 'HIGH',
    };
  });
}

/**
 * Maps whatever JSON the shared OpenRouter pass returned for the Fidelity prompt onto
 * `FidelityRsuVest[]`. A vest is only usable when every number it commits to is present
 * and sane — a missing grantId, an unparseable date, non-positive units or a price or
 * withholding outside their bounds DROPS the vest (FR-02), never guesses. `netUnits`,
 * when the model could not read it, falls back to the prompt's own defining formula.
 */
export async function extractRsuVestsFromImage(deps: {
  fetchImpl: typeof fetch;
  apiKey: string;
  /** Explicit model override; when absent the free-model chain is walked. */
  model?: string;
  /** One or more pages of the same statement — all sent in a single request. */
  images: { base64: string; mimeType: string }[];
}): Promise<FidelityRsuVest[]> {
  const parsed = await extractJsonFromImage({
    fetchImpl: deps.fetchImpl,
    apiKey: deps.apiKey,
    ...(deps.model ? { model: deps.model } : {}),
    images: deps.images,
    prompt: FIDELITY_EXTRACTION_PROMPT,
  });
  if (typeof parsed !== 'object' || parsed === null) return [];
  const vests = (parsed as Record<string, unknown>).vests;
  if (!Array.isArray(vests)) return [];

  const out: FidelityRsuVest[] = [];
  for (const v of vests) {
    if (typeof v !== 'object' || v === null) continue;
    const r = v as Record<string, unknown>;
    if (typeof r.grantId !== 'string' || !r.grantId.trim()) continue;
    if (typeof r.vestOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(r.vestOn)) continue;
    if (typeof r.units !== 'number' || !Number.isFinite(r.units) || r.units <= 0) continue;
    if (typeof r.priceUsd !== 'number' || !Number.isFinite(r.priceUsd) || r.priceUsd < 0) continue;
    if (typeof r.withholdingPct !== 'number' || !Number.isFinite(r.withholdingPct)
      || r.withholdingPct < 0 || r.withholdingPct > 100) continue;
    const netUnits = typeof r.netUnits === 'number' && Number.isFinite(r.netUnits) && r.netUnits >= 0
      ? r.netUnits
      : Number((r.units * (1 - r.withholdingPct / 100)).toFixed(4));
    out.push({
      grantId: r.grantId,
      vestOn: r.vestOn,
      units: r.units,
      priceUsd: r.priceUsd,
      withholdingPct: r.withholdingPct,
      netUnits,
    });
  }
  return out;
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