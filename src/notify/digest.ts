import type { Db } from '../db/client.js';
import { allocationDrift, concentration, type DriftRow } from '../domain/allocation.js';
import { evaluateRails, loadOwnerRails, type RailBreach } from '../domain/rails.js';
import { bucketStatuses, milestoneStatuses, type BucketStatus, type MilestoneStatus } from '../domain/buckets.js';
import { fundedStatus } from '../domain/funded-status.js';
import { escapeMarkdown } from './telegram.js';
import { currentIps } from '../domain/ips.js';
import { loadPositions, netWorth, outstandingLiabilities } from '../domain/networth.js';
import { projectVests, type VestEvent } from '../domain/rsu.js';
import { assessStaleness, type StalenessRow } from '../sources/staleness.js';
import { fetchLiveRsuInputs, type LiveRsuInputs } from '../sources/rsu-live.js';
import { ASSUMPTIONS } from '../config/assumptions.js';
import { formatInr, type Paise } from '../money/paise.js';

export interface DigestInput {
  businessDate: string;
  assetsPaise: Paise;
  liabilitiesPaise: Paise;
  netPaise: Paise;
  previousNetPaise: Paise | null;
  byAccount: [string, Paise][];
  drift: DriftRow[];
  breaches: string[];
  /** Owner's own rules. Reported apart from IPS breaches — he can change these. */
  railBreaches: RailBreach[];
  buckets: BucketStatus[];
  milestones: MilestoneStatus[];
  staleness: StalenessRow[];
  nextVest: VestEvent | null;
  ipsVersion: number;
  funded: { floorRatio: number; stretchRatio: number };
}

/**
 * Net worth on the most recent business date STRICTLY before this one.
 *
 * This was hard-coded `null` with a comment saying day-change "lights up on day two" —
 * so "day-over-day starts tomorrow" printed every day forever and tomorrow never came.
 * Returns null only when there genuinely is no earlier snapshot.
 *
 * Liabilities are held at today's figure deliberately: the comparison is of the asset
 * side moving, and re-deriving a past month's loan schedule would report a change that
 * is really just amortisation.
 */
async function previousNet(
  db: Db,
  businessDate: string,
  liabilitiesPaise: Paise,
): Promise<Paise | null> {
  const [row] = await db.query<{ business_date: string | Date }>(
    `select max(business_date) as business_date from snapshots where business_date < $1`,
    [businessDate],
  );
  const raw = row?.business_date;
  if (!raw) return null;
  const previousDate = raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw).slice(0, 10);

  const positions = await loadPositions(db, previousDate);
  if (positions.length === 0) return null;
  return netWorth(positions, liabilitiesPaise).netPaise;
}

export async function buildDigestInput(db: Db, now: string): Promise<DigestInput> {
  const businessDate = now.slice(0, 10);
  const positions = await loadPositions(db);
  const liabilities = await outstandingLiabilities(db, `${businessDate.slice(0, 7)}-01`);
  const nw = netWorth(positions, liabilities);

  const grants = await db.query<{ id: string; granted_on: Date | string; units: string; note: string }>(
    'select id, granted_on, units, note from rsu_grants',
  );

  // Fetch live NOW price + USD/INR for fresh RSU projection
  let liveInputs: { nowPriceCents: bigint; usdInr: number; asOf: string } | null = null;
  try {
    liveInputs = await fetchLiveRsuInputs();
  } catch (e) {
    // Fall back to seed values if live fetch fails; staleness engine will flag it
    console.warn('Live RSU price/FX fetch failed, falling back to seed values:', e);
  }

  const priceUsd = liveInputs ? Number(liveInputs.nowPriceCents) / 100 : ASSUMPTIONS.seedNowPriceUsd;
  const usdInr = liveInputs ? liveInputs.usdInr : ASSUMPTIONS.seedUsdInr;

  const vests = projectVests(
    grants.map((g) => ({
      id: g.id,
      grantedOn: g.granted_on instanceof Date ? g.granted_on.toISOString().slice(0, 10) : String(g.granted_on).slice(0, 10),
      units: Number(g.units),
      note: g.note,
    })),
    {
      priceUsd,
      usdInr,
      from: businessDate,
      to: `${Number(businessDate.slice(0, 4)) + 1}-12-31`,
    },
  );

  return {
    businessDate,
    assetsPaise: nw.assetsPaise,
    liabilitiesPaise: nw.liabilitiesPaise,
    netPaise: nw.netPaise,
    previousNetPaise: await previousNet(db, businessDate, nw.liabilitiesPaise),
    byAccount: [...nw.byAccount.entries()],
    drift: allocationDrift(nw.byAssetClass, nw.assetsPaise),
    breaches: concentration(positions).breaches,
    railBreaches: evaluateRails(await loadOwnerRails(db), nw.byAssetClass, nw.assetsPaise),
    buckets: await bucketStatuses(db),
    milestones: await milestoneStatuses(db, businessDate),
    staleness: await assessStaleness(db, now),
    nextVest: vests[0] ?? null,
    ipsVersion: (await currentIps(db)).version,
    funded: fundedStatus(nw.assetsPaise),
  };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

/** Pure: state in, markdown out. No I/O, no LLM — Phase 1 adds narration on top. */
export function composeDigest(d: DigestInput): string {
  const lines: string[] = [];

  lines.push(`*Sentinel — ${d.businessDate}*  _(IPS v${d.ipsVersion})_`, '');

  lines.push('*Net worth*');
  lines.push(`Assets: ${formatInr(d.assetsPaise, { compact: true })}`);
  lines.push(`Liabilities: ${formatInr(d.liabilitiesPaise, { compact: true })}`);
  lines.push(`*Net: ${formatInr(d.netPaise, { compact: true })}*`);
  if (d.previousNetPaise !== null) {
    const change = (d.netPaise - d.previousNetPaise) as Paise;
    lines.push(`Change since last sync: ${formatInr(change, { compact: true })}`);
  } else {
    lines.push('_Change: first snapshot — day-over-day starts tomorrow._');
  }
  lines.push('');

  lines.push('*By account*');
  for (const [account, value] of d.byAccount.sort((a, b) => Number(b[1] - a[1]))) {
    const label = account === 'fidelity' ? 'fidelity (ServiceNow NOW)' : account;
    lines.push(`• ${label}: ${formatInr(value, { compact: true })}`);
  }
  lines.push('');

  lines.push('*Allocation vs IPS §3.3*');
  for (const row of d.drift) {
    const flag = row.breach ? ` ⚠️ ${escapeMarkdown(row.breach)} by ${formatInr(row.driftPaise, { compact: true })}` : '';
    lines.push(`• ${row.assetClass}: ${pct(row.actual)} (band ${pct(row.min)}–${pct(row.max)})${flag}`);
  }
  lines.push('');

  if (d.railBreaches.length) {
    // Deliberately its own section. An owner rail must never read as an IPS clause:
    // he is entitled to change these, and the IPS he is held to at a -20% drawdown
    // is not something he can change in a drawdown.
    lines.push('*Your own rails (not IPS)*');
    for (const b of d.railBreaches) lines.push(`• ⚠️ ${escapeMarkdown(b.message)}`);
    lines.push('');
  }

  if (d.breaches.length) {
    lines.push('*Concentration breaches (IPS §3.5)*');
    // Breach strings carry instrument, issuer and scheme names straight from the DB.
    for (const b of d.breaches) lines.push(`• ⚠️ ${escapeMarkdown(b)}`);
    lines.push('');
  }

  lines.push('*Buckets*');
  for (const b of d.buckets) {
    const funded = b.fundedRatio === null
      ? b.targetNote
      : `${pct(b.fundedRatio)} of ${formatInr(b.targetPaise!, { compact: true })}`;
    // An unallocated bucket says so. It never reports Rs 0.
    const balance = b.balancePaise === null
      ? 'not yet allocated'
      : formatInr(b.balancePaise, { compact: true });
    lines.push(`• ${escapeMarkdown(b.name)}: ${balance} — ${escapeMarkdown(funded)}`);
  }
  lines.push('');

  const openMilestones = d.milestones.filter((m) => !m.completedOn);
  if (openMilestones.length) {
    lines.push('*Protection milestones — still open*');
    for (const m of openMilestones) {
      lines.push(`• ❗ ${escapeMarkdown(m.name)}: ${escapeMarkdown(m.spec)} _(${m.daysOutstanding} days outstanding)_`);
    }
    lines.push('');
  }

  if (d.nextVest) {
    lines.push('*Next RSU vest*');
    lines.push(
      `${d.nextVest.vestOn}: ~${formatInr(d.nextVest.netPaise, { compact: true })} net (projected)`,
      '',
    );
  }

  lines.push('*Data freshness*');
  const stale = d.staleness.filter((s) => s.stale);
  if (stale.length === 0) {
    lines.push('✅ All sources fresh.');
  } else {
    for (const s of stale) {
      lines.push(`🔴 STALE: ${s.source} — ${s.ageHours.toFixed(0)}h old (limit ${s.limitHours}h)`);
    }
    lines.push('_Recommendations for affected instruments are blocked (FR-31)._');
  }
  lines.push('');

  lines.push('*Pending approvals*');
  lines.push('None — Phase 0 is advisory reporting only.');
  lines.push('');

  lines.push(
    `_Funded status (reporting only, never a risk input): ${pct(d.funded.floorRatio)} of the FI floor._`,
  );

  return lines.join('\n');
}