import type { Db } from '../db/client.js';
import { SMALLCASES, SMALLCASE_AS_OF, SMALLCASE_SOURCE } from '../config/smallcases.js';

/**
 * Persists the owner's smallcase decomposition into `smallcase_positions`.
 *
 * `holdings` already carries the correct per-instrument totals from the live sync. What
 * it cannot express is that 2,616 GOLDBEES are 1,453 in Equity & Gold and 1,163 in
 * Timeless — so without this, "exit Timeless" has no share count and no cleanup
 * recommendation about a smallcase can be sized.
 *
 * Idempotent on `(smallcase, instrument_id, as_of)`: the table is append-only, so a
 * re-run must add nothing rather than duplicate a position.
 *
 * Skips any constituent whose instrument is not in `instruments` rather than failing the
 * whole seed. The decomposition is captured from the smallcase app and the instrument
 * universe from INDmoney, so a name can legitimately appear in one before the other;
 * a skipped row is reported rather than silently dropped.
 */
export async function seedSmallcases(db: Db): Promise<{ inserted: number; skipped: string[] }> {
  let inserted = 0;
  const skipped: string[] = [];

  for (const sc of SMALLCASES) {
    for (const k of sc.constituents) {
      const [known] = await db.query<{ id: string }>(
        'select id from instruments where id = $1', [k.instrumentId],
      );
      if (!known) {
        skipped.push(`${sc.name}/${k.instrumentId}`);
        continue;
      }
      const rows = await db.query<{ id: string }>(
        `insert into smallcase_positions
           (smallcase, instrument_id, as_of, units, avg_buy_price_paise, source)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (smallcase, instrument_id, as_of) do nothing
         returning id`,
        [sc.name, k.instrumentId, SMALLCASE_AS_OF, k.units,
         k.avgBuyPricePaise.toString(), SMALLCASE_SOURCE],
      );
      if (rows.length > 0) inserted += 1;
    }
  }
  return { inserted, skipped };
}

export interface SmallcasePosition {
  smallcase: string;
  instrumentId: string;
  units: number;
  avgBuyPricePaise: bigint | null;
}

/** The most recent decomposition on record, grouped by smallcase. */
export async function loadSmallcasePositions(db: Db): Promise<Map<string, SmallcasePosition[]>> {
  const rows = await db.query<{
    smallcase: string; instrument_id: string; units: string; avg_buy_price_paise: string | null;
  }>(
    `select smallcase, instrument_id, units, avg_buy_price_paise
       from smallcase_positions
      where as_of = (select max(as_of) from smallcase_positions)
      order by smallcase, instrument_id`,
  );
  const out = new Map<string, SmallcasePosition[]>();
  for (const r of rows) {
    const list = out.get(r.smallcase) ?? [];
    list.push({
      smallcase: r.smallcase,
      instrumentId: r.instrument_id,
      units: Number(r.units),
      avgBuyPricePaise: r.avg_buy_price_paise === null ? null : BigInt(r.avg_buy_price_paise),
    });
    out.set(r.smallcase, list);
  }
  return out;
}
