import { ASSUMPTIONS } from '../config/assumptions.js';
import type { Db } from '../db/client.js';
import { rateMicros, usdToInr } from '../money/fx.js';
import { addP, cents, dollars, mulP, type Paise } from '../money/paise.js';
import type { RsuGrantSeed } from '../seed/seed-data.js';

const VEST_MONTHS = ['02', '05', '08', '11'] as const;
const VEST_DAY = '15';

/** `rsu_vests.source` for a model-projected row. Owner confirmations overwrite it. */
export const PROJECTED_SOURCE = 'model';
export const CONFIRMED_SOURCE = 'owner-confirmed';

/**
 * Units are `numeric(12,4)` in the schema and genuinely fractional (120/16 = 7.5), so they
 * are carried as integer micro-units internally. Money never rides on a float; units are a
 * quantity, but they multiply money, so they get the same treatment.
 */
const UNITS_SCALE = 1_000_000n;
const toUnitsMicros = (units: number): bigint => BigInt(Math.round(units * Number(UNITS_SCALE)));

export interface VestEvent {
  grantId: string;
  vestOn: string;
  units: number;
  status: 'PROJECTED' | 'ACTUAL';
  grossPaise: Paise;
  netPaise: Paise;
}

/**
 * Quarterly tranche dates for a grant: `vestYears * 4` tranches, on the 15th of
 * Feb/May/Aug/Nov, starting at the first such date strictly after the grant date.
 */
function trancheDates(grantedOn: string, vestYears: number): string[] {
  const grantYear = Number(grantedOn.slice(0, 4));
  const dates: string[] = [];
  for (let y = grantYear; y <= grantYear + vestYears; y++) {
    for (const m of VEST_MONTHS) {
      const date = `${y}-${m}-${VEST_DAY}`;
      if (date > grantedOn) dates.push(date);
    }
  }
  const wanted = vestYears * VEST_MONTHS.length;
  if (dates.length < wanted) {
    throw new Error(`cannot build ${wanted} tranches for a grant dated ${grantedOn}`);
  }
  return dates.slice(0, wanted);
}

/**
 * Cumulative allocation of `total` across `n` tranches: tranche k gets
 * `floor(total*k/n) - floor(total*(k-1)/n)`.
 *
 * The point is that the parts always sum back to the whole. Rounding each tranche
 * independently (`round(price * units/16)` per tranche, as an earlier sketch did) leaves a
 * projection whose 16 parts need not add up to `units x price` — a defect in a system whose
 * first rule is that money is exact.
 */
function allocate(total: bigint, k: number, n: number): bigint {
  return (total * BigInt(k)) / BigInt(n) - (total * BigInt(k - 1)) / BigInt(n);
}

export function projectVests(
  grants: RsuGrantSeed[],
  opts: { priceUsd: number; usdInr: number; from: string; to: string },
): VestEvent[] {
  const micros = rateMicros(opts.usdInr);
  // Parsed from the decimal string, never `Math.round(price * 100)`: 127.54 * 100 is
  // 12753.999999999998 in IEEE-754 and 127.545 * 100 is 12754.500000000002. `dollars()`
  // rounds neither — it parses exactly and rejects sub-cent precision outright.
  const priceCents = dollars(opts.priceUsd);
  const events: VestEvent[] = [];

  for (const grant of grants) {
    const dates = trancheDates(grant.grantedOn, ASSUMPTIONS.rsuVestYears);
    const n = dates.length;
    const unitsMicros = toUnitsMicros(grant.units);
    const grantGross = usdToInr(cents((priceCents * unitsMicros) / UNITS_SCALE), micros);
    const grantNet = mulP(grantGross, ASSUMPTIONS.rsuNetOfWithholding);

    for (let k = 1; k <= n; k++) {
      const vestOn = dates[k - 1]!;
      if (vestOn < opts.from || vestOn > opts.to) continue;
      events.push({
        grantId: grant.id,
        vestOn,
        units: Number(allocate(unitsMicros, k, n)) / Number(UNITS_SCALE),
        status: 'PROJECTED',
        grossPaise: allocate(grantGross, k, n) as Paise,
        netPaise: allocate(grantNet, k, n) as Paise,
      });
    }
  }
  return events.sort((a, b) => a.vestOn.localeCompare(b.vestOn) || a.grantId.localeCompare(b.grantId));
}

/**
 * PRD §15.2 base case: $20k/year refreshers. Pure — the base grants are not mutated, so the
 * no-refresher downside scenario stays available.
 *
 * A year that already carries a REAL grant is skipped. `SEED_RSU_GRANTS` contains a real
 * 285-unit `G2026`; without this check `fromYear: 2026` emitted `REFRESH-2026` beside it and
 * overstated the RSU pipeline by a whole grant. The occupied years are derived from the
 * `grants` argument, never hard-coded, so the guard survives the seed moving.
 *
 * NOTE: the returned refresher grants are hypothetical and have no `rsu_grants` row.
 * `rsu_vests.grant_id` is a foreign key, so vests projected from them cannot be persisted —
 * they are a scenario input for projection only. `rsu_grants.scenario` ('ACTUAL'|'REFRESHER')
 * exists for the day they are persisted; `RsuGrantSeed` carries no such field yet.
 */
export function withRefreshers(
  grants: RsuGrantSeed[],
  opts: { fromYear: number; toYear: number; priceUsd: number },
): RsuGrantSeed[] {
  const occupied = new Set(grants.map((g) => Number(g.grantedOn.slice(0, 4))));
  const extra: RsuGrantSeed[] = [];
  for (let y = opts.fromYear; y <= opts.toYear; y++) {
    if (occupied.has(y)) continue;
    extra.push({
      id: `REFRESH-${y}`,
      grantedOn: `${y}-02-15`,
      units: ASSUMPTIONS.rsuRefresherUsdPerYear / opts.priceUsd,
      note: `Assumed $${ASSUMPTIONS.rsuRefresherUsdPerYear} refresher (PRD §15.2)`,
    });
  }
  return [...grants, ...extra];
}

/**
 * Gross value of every tranche vesting strictly after `asOf`.
 *
 * Sums exactly what it is given: pass a projection whose window stops short of the last
 * tranche and the answer is understated by the clipped tail. Project over the full pipeline.
 */
export function unvestedValue(vests: VestEvent[], asOf: string): Paise {
  return addP(...vests.filter((v) => v.vestOn > asOf).map((v) => v.grossPaise));
}

/**
 * Upserts PROJECTED rows keyed on the `unique (grant_id, vest_on)` constraint. An
 * owner-confirmed ACTUAL is never overwritten (FR-03).
 *
 * FR-03 is enforced **in the SQL**, by the `where rsu_vests.status <> 'ACTUAL'` on the
 * conflict action — not by application control flow. The earlier read-then-write was
 * check-then-act: a `confirmVest` landing between the SELECT and the UPDATE won the race,
 * and because that UPDATE never touched `status` the row was left claiming
 * `status = 'ACTUAL'` while carrying the model's units, money and `source = 'model'` —
 * owner provenance over model numbers, undetectable downstream. One statement, one
 * predicate, no window.
 *
 * The read below is belt-and-braces only: it short-circuits the common case, and the
 * statement that follows is safe on its own.
 *
 * `asOf` is injectable so a run is reproducible; it defaults to now. Rows written here are
 * always PROJECTED and always carry `source = PROJECTED_SOURCE` — there is deliberately no
 * `source` override, since the only other value in use means "the owner confirmed this".
 */
export async function persistVests(
  db: Db,
  vests: VestEvent[],
  opts: { asOf?: string } = {},
): Promise<void> {
  const asOf = opts.asOf ?? new Date().toISOString();
  for (const v of vests) {
    const existing = await db.query<{ status: string }>(
      'select status from rsu_vests where grant_id = $1 and vest_on = $2',
      [v.grantId, v.vestOn],
    );
    if (existing[0]?.status === 'ACTUAL') continue;
    await db.query(
      `insert into rsu_vests
         (grant_id, vest_on, units, status, gross_paise, net_paise, as_of, source)
       values ($1,$2,$3,'PROJECTED',$4,$5,$6,$7)
       on conflict (grant_id, vest_on) do update
          set units = excluded.units, gross_paise = excluded.gross_paise,
              net_paise = excluded.net_paise, as_of = excluded.as_of,
              source = excluded.source
        where rsu_vests.status <> 'ACTUAL'`,
      [v.grantId, v.vestOn, v.units, v.grossPaise.toString(), v.netPaise.toString(),
       asOf, PROJECTED_SOURCE],
    );
  }
}

/**
 * Quarterly reconciliation (FR-03): the owner confirms actual units, price and FX, and the
 * row becomes immutable to the model.
 *
 * `gross_paise` is RECOMPUTED from the confirmed units/price/FX rather than left at its
 * projected value. Writing only `net_paise` left the row's implied withholding rate silently
 * wrong, and anything summing `gross_paise` back out of the table then read a stale mix of
 * one confirmed net and five projected grosses.
 */
export async function confirmVest(
  db: Db,
  id: string,
  actual: { units: number; priceUsdCents: bigint; usdInrMicros: bigint; netPaise: Paise },
  opts: { asOf?: string } = {},
): Promise<void> {
  const asOf = opts.asOf ?? new Date().toISOString();
  // Every input is bounded on BOTH sides. A one-sided `net > gross` test accepted
  // `units: 0` with `netPaise: rupees(-500_000)` — a Rs 5L negative net against a zero
  // gross — which then flows straight into any sum over the table.
  if (actual.units < 0) throw new Error(`negative units ${actual.units} for vest ${id}`);
  if (actual.priceUsdCents < 0n) {
    throw new Error(`negative price ${actual.priceUsdCents} cents for vest ${id}`);
  }
  if (actual.netPaise < 0n) {
    throw new Error(`negative net ${actual.netPaise} for vest ${id}`);
  }
  const grossPaise = usdToInr(
    cents((actual.priceUsdCents * toUnitsMicros(actual.units)) / UNITS_SCALE),
    actual.usdInrMicros,
  );
  if (actual.netPaise > grossPaise) {
    throw new Error(
      `confirmed net ${actual.netPaise} exceeds recomputed gross ${grossPaise} for vest ${id}`,
    );
  }

  // The row update and its audit row are one unit of work: a row confirmed with no audit
  // trail defeats the point of an append-only audit table, and the audit row can never be
  // back-filled because the table refuses UPDATE.
  await db.withTransaction(async (tx) => {
    const updated = await tx.query<{ id: string }>(
      // `confirmed_on` is derived from the injectable `asOf`, never `current_date`: this
      // function takes `asOf` precisely so a run is reproducible, and a DB clock would make
      // the stored date depend on the day the confirmation happened to be replayed.
      `update rsu_vests
          set status = 'ACTUAL', units = $2, price_usd_cents = $3, usdinr_micros = $4,
              gross_paise = $5, net_paise = $6, confirmed_on = ($7)::text::date,
              as_of = ($7)::text::timestamptz, source = $8
        where id = $1
        returning id`,
      [id, actual.units, actual.priceUsdCents.toString(), actual.usdInrMicros.toString(),
       grossPaise.toString(), actual.netPaise.toString(), asOf, CONFIRMED_SOURCE],
    );
    if (updated.length === 0) throw new Error(`no rsu_vests row with id ${id}`);

    await tx.query(
      `insert into audit_log (entity, entity_id, action, actor, payload)
       values ('rsu_vest', $1, 'CONFIRMED', 'owner', $2::jsonb)`,
      [id, JSON.stringify({
        units: actual.units,
        priceUsdCents: actual.priceUsdCents.toString(),
        usdInrMicros: actual.usdInrMicros.toString(),
        grossPaise: grossPaise.toString(),
        netPaise: actual.netPaise.toString(),
      })],
    );
  });
}
