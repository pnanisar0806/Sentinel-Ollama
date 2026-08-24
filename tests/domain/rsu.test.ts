import { beforeEach, describe, expect, it } from 'vitest';
import { ASSUMPTIONS } from '../../src/config/assumptions.js';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  confirmVest, persistVests, projectVests, unvestedValue, withRefreshers,
} from '../../src/domain/rsu.js';
import { rateMicros, usdToInr } from '../../src/money/fx.js';
import { addP, cents, dollars, mulP, rupees, type Paise } from '../../src/money/paise.js';
import { SEED_RSU_GRANTS } from '../../src/seed/seed-data.js';
import { seed } from '../../src/seed/seed.js';

const opts = {
  priceUsd: ASSUMPTIONS.seedNowPriceUsd,
  usdInr: ASSUMPTIONS.seedUsdInr,
  from: '2026-09-01',
  to: '2030-12-31',
};

/** Every tranche any seed grant will ever produce. Nothing is clipped by the window. */
const FULL_WINDOW = { ...opts, from: '2000-01-01', to: '2099-12-31' };
const TRANCHES = ASSUMPTIONS.rsuVestYears * 4;

describe('vest projection', () => {
  const vests = projectVests(SEED_RSU_GRANTS, opts);
  const all = projectVests(SEED_RSU_GRANTS, FULL_WINDOW);

  it('vests quarterly on the 15th of Feb, May, Aug and Nov', () => {
    const months = new Set(all.map((v) => v.vestOn.slice(5)));
    expect([...months].sort()).toEqual(['02-15', '05-15', '08-15', '11-15']);
  });

  it('gives every grant exactly 16 tranches spanning four years', () => {
    for (const g of SEED_RSU_GRANTS) {
      const mine = all.filter((v) => v.grantId === g.id);
      expect(mine).toHaveLength(TRANCHES);
      const first = mine[0]!.vestOn;
      const last = mine.at(-1)!.vestOn;
      expect(first > g.grantedOn).toBe(true);
      // 16 quarterly tranches span 15 quarters = 45 months from the first to the last.
      expect(monthIndex(last) - monthIndex(first)).toBe((TRANCHES - 1) * 3);
    }
  });

  it('marks every projected vest PROJECTED, never ACTUAL', () => {
    expect(vests.every((v) => v.status === 'PROJECTED')).toBe(true);
  });

  it('excludes vests outside the requested window', () => {
    expect(vests.every((v) => v.vestOn >= opts.from && v.vestOn <= opts.to)).toBe(true);
    expect(all.length).toBeGreaterThan(vests.length);
  });

  it('reconciles each grant\'s 16 tranches back to the whole-grant units, gross and net', () => {
    const micros = rateMicros(opts.usdInr);
    const priceCents = dollars(opts.priceUsd);
    let checked = 0;
    for (const g of SEED_RSU_GRANTS) {
      const mine = all.filter((v) => v.grantId === g.id);
      // The whole computed independently of the tranche split: price x units, then FX.
      const wholeGross = usdToInr(
        cents((priceCents * BigInt(Math.round(g.units * 1_000_000))) / 1_000_000n),
        micros,
      );
      const wholeNet = mulP(wholeGross, ASSUMPTIONS.rsuNetOfWithholding);

      expect(mine.reduce((s, v) => s + v.units, 0)).toBeCloseTo(g.units, 6);
      expect(addP(...mine.map((v) => v.grossPaise))).toBe(wholeGross);
      expect(addP(...mine.map((v) => v.netPaise))).toBe(wholeNet);
      checked++;
    }
    expect(checked).toBe(SEED_RSU_GRANTS.length);
  });

  it('nets the whole RSU pipeline down to exactly 70% of gross', () => {
    const gross = addP(...all.map((v) => v.grossPaise));
    const net = addP(...all.map((v) => v.netPaise));
    // Derived from the seed, not written twice: 1,105 units at $127.54 x 95.3.
    const totalUnits = SEED_RSU_GRANTS.reduce((s, g) => s + g.units, 0);
    expect(gross).toBe(
      usdToInr(cents(dollars(opts.priceUsd) * BigInt(totalUnits)), rateMicros(opts.usdInr)),
    );
    // Per-grant truncation means the pipeline net is the sum of 6 grant nets, not one mulP.
    expect(net).toBe(
      addP(...SEED_RSU_GRANTS.map((g) => mulP(
        usdToInr(cents(dollars(opts.priceUsd) * BigInt(g.units)), rateMicros(opts.usdInr)),
        ASSUMPTIONS.rsuNetOfWithholding,
      ))),
    );
    expect(Number(net) / Number(gross)).toBeCloseTo(ASSUMPTIONS.rsuNetOfWithholding, 6);
  });

  it('refuses a USD price that is not representable in whole cents', () => {
    // Math.round(127.545 * 100) silently yields 12755 (and 127.54*100 is
    // 12753.999999999998 in IEEE-754). Money must be parsed, never floated.
    expect(() => projectVests(SEED_RSU_GRANTS, { ...opts, priceUsd: 127.545 }))
      .toThrow(/not representable/);
  });

  it('values the unvested pipeline at exactly 469.375 units / Rs 57,05,047.56', () => {
    const asOf = '2026-09-01';
    // Deliberately the UNCLIPPED projection: `unvestedValue` sums whatever it is given, so
    // a window that stops short of the last tranche silently understates the pipeline.
    const projected = all;

    // Sanity: the full pipeline adds up to the seeded grant total (derived, not a literal),
    // so the unvested slice below is a real subset and not a windowing artifact.
    expect(projected.reduce((s, v) => s + v.units, 0))
      .toBeCloseTo(SEED_RSU_GRANTS.reduce((s, g) => s + g.units, 0), 6);

    const unvestedUnits = projected
      .filter((v) => v.vestOn > asOf)
      .reduce((s, v) => s + v.units, 0);
    expect(unvestedUnits).toBeCloseTo(469.375, 6);
    expect(unvestedValue(projected, asOf)).toBe(570_504_756n as Paise);
  });

  it('treats a vest ON the as-of date as already vested, not unvested', () => {
    // The headline as-of (2026-09-01) is not a vest date, so `>` vs `>=` is unobservable
    // there. Pin the boundary on a date that IS a tranche date, derived from the projection.
    const asOf = all[Math.floor(all.length / 2)]!.vestOn;
    const onDate = all.filter((v) => v.vestOn === asOf);
    expect(onDate.length).toBeGreaterThan(0); // the boundary is actually exercised

    const strictlyAfter = addP(...all.filter((v) => v.vestOn > asOf).map((v) => v.grossPaise));
    const onDateSum = addP(...onDate.map((v) => v.grossPaise));
    expect(onDateSum > 0n).toBe(true);

    expect(unvestedValue(all, asOf)).toBe(strictlyAfter);
    // ...and that is strictly less than the inclusive reading, so `>=` cannot also pass.
    expect(unvestedValue(all, asOf)).not.toBe(addP(strictlyAfter, onDateSum));
  });
});

describe('refresher scenario', () => {
  it('adds one $20k grant per year on top of the base grants', () => {
    const withR = withRefreshers(SEED_RSU_GRANTS, {
      fromYear: 2027, toYear: 2030, priceUsd: ASSUMPTIONS.seedNowPriceUsd,
    });
    expect(withR).toHaveLength(SEED_RSU_GRANTS.length + 4);
    const refresher = withR.find((g) => g.id === 'REFRESH-2027')!;
    expect(refresher.units).toBeCloseTo(20_000 / ASSUMPTIONS.seedNowPriceUsd, 2);
  });

  it('never double-counts a year that already carries a real grant', () => {
    const realYears = new Set(SEED_RSU_GRANTS.map((g) => Number(g.grantedOn.slice(0, 4))));
    const fromYear = Math.max(...realYears); // 2026 today — derived, never a literal.
    const toYear = fromYear + 3;
    const withR = withRefreshers(SEED_RSU_GRANTS, {
      fromYear, toYear, priceUsd: ASSUMPTIONS.seedNowPriceUsd,
    });

    const overlap = [...Array(toYear - fromYear + 1).keys()]
      .map((i) => fromYear + i)
      .filter((y) => realYears.has(y));
    expect(overlap.length).toBeGreaterThan(0); // the hazard is actually exercised
    expect(withR).toHaveLength(SEED_RSU_GRANTS.length + (toYear - fromYear + 1) - overlap.length);
    for (const y of overlap) expect(withR.some((g) => g.id === `REFRESH-${y}`)).toBe(false);

    // And the pipeline is not inflated: total units for an overlapped year stay the
    // real grant's units alone.
    for (const y of overlap) {
      const units = withR
        .filter((g) => g.grantedOn.startsWith(String(y)))
        .reduce((s, g) => s + g.units, 0);
      const real = SEED_RSU_GRANTS
        .filter((g) => g.grantedOn.startsWith(String(y)))
        .reduce((s, g) => s + g.units, 0);
      expect(units).toBe(real);
    }
  });

  it('leaves the base grants untouched so the no-refresher downside stays available', () => {
    const before = JSON.stringify(SEED_RSU_GRANTS);
    withRefreshers(SEED_RSU_GRANTS, { fromYear: 2027, toYear: 2030, priceUsd: 127.54 });
    expect(JSON.stringify(SEED_RSU_GRANTS)).toBe(before);
  });
});

describe('persistence and reconciliation', () => {
  let db: Db;
  const AS_OF = '2026-09-01T00:00:00+05:30';

  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
  });

  it('stamps every row with a pinned as_of and a source', async () => {
    const vests = projectVests(SEED_RSU_GRANTS, opts);
    await persistVests(db, vests, { asOf: AS_OF });
    const rows = await db.query<{ n: string }>(
      'select count(*) as n from rsu_vests where as_of is not null and source <> \'\'',
    );
    expect(Number(rows[0]!.n)).toBe(vests.length);
    const distinct = await db.query<{ as_of: string | Date; source: string }>(
      'select distinct as_of, source from rsu_vests',
    );
    expect(distinct).toHaveLength(1);
    expect(distinct[0]!.source).toBe('model');
    // The pinned instant must actually reach the row — asserting only that the run is
    // internally consistent would pass just as happily with `new Date()`, which is exactly
    // the non-determinism this parameter exists to remove.
    expect(new Date(distinct[0]!.as_of).toISOString()).toBe(new Date(AS_OF).toISOString());
  });

  it('upserts projected vests idempotently and updates them in place', async () => {
    const vests = projectVests(SEED_RSU_GRANTS, opts);
    await persistVests(db, vests, { asOf: AS_OF });
    await persistVests(db, vests, { asOf: AS_OF });
    const counted = async () =>
      Number((await db.query<{ n: string }>('select count(*) as n from rsu_vests'))[0]!.n);
    expect(await counted()).toBe(vests.length);

    // Idempotent row COUNT is not the same as a working upsert: move a projection input
    // and prove the stored value actually followed it.
    const key = vests[0]!;
    const before = await grossFor(db, key.grantId, key.vestOn);
    const cheaper = projectVests(SEED_RSU_GRANTS, { ...opts, priceUsd: 100 });
    await persistVests(db, cheaper, { asOf: AS_OF });
    expect(await counted()).toBe(vests.length);
    const after = await grossFor(db, key.grantId, key.vestOn);
    expect(after).not.toBe(before);
    expect(after).toBe(
      cheaper.find((v) => v.grantId === key.grantId && v.vestOn === key.vestOn)!.grossPaise,
    );
  });

  it('never lets a re-projection overwrite an owner-confirmed ACTUAL', async () => {
    const vests = projectVests(SEED_RSU_GRANTS, opts);
    await persistVests(db, vests, { asOf: AS_OF });
    const [row] = await db.query<{ id: string; grant_id: string; vest_on: string }>(
      'select id, grant_id, vest_on from rsu_vests order by vest_on, grant_id limit 1',
    );
    await confirmVest(db, row!.id, {
      units: 9,
      priceUsdCents: 15_000n,
      usdInrMicros: 96_000_000n,
      netPaise: rupees(90_720),
    }, { asOf: AS_OF });

    await persistVests(db, projectVests(SEED_RSU_GRANTS, { ...opts, priceUsd: 100 }), {
      asOf: '2027-01-01T00:00:00+05:30',
    });

    // NB: PGlite hands bigint columns back as JS numbers, not strings — always widen
    // through BigInt() rather than comparing against a string literal.
    const [after] = await db.query<{
      status: string; net_paise: string | number; gross_paise: string | number;
      units: string | number; source: string;
    }>(
      'select status, net_paise, gross_paise, units, source from rsu_vests where id = $1',
      [row!.id],
    );
    expect(after!.status).toBe('ACTUAL');
    expect(BigInt(after!.net_paise)).toBe(rupees(90_720));
    expect(Number(after!.units)).toBe(9);
    expect(after!.source).toBe('owner-confirmed');
  });

  it('recomputes gross_paise on confirmation so the withholding rate stays coherent', async () => {
    const vests = projectVests(SEED_RSU_GRANTS, opts);
    await persistVests(db, vests, { asOf: AS_OF });
    const [row] = await db.query<{ id: string; grant_id: string; vest_on: string }>(
      'select id, grant_id, vest_on from rsu_vests order by vest_on, grant_id limit 1',
    );
    const projectedGross = await grossFor(db, row!.grant_id, row!.vest_on);

    const actual = {
      units: 9,
      priceUsdCents: 15_000n,
      usdInrMicros: 96_000_000n,
      netPaise: rupees(90_720),
    };
    await confirmVest(db, row!.id, actual, { asOf: AS_OF });

    // 9 units x $150.00 = $1,350.00 = 135,000 cents; x 96.0 = Rs 1,29,600.
    const expected = usdToInr(
      cents((actual.priceUsdCents * BigInt(Math.round(actual.units * 1_000_000))) / 1_000_000n),
      actual.usdInrMicros,
    );
    const stored = await grossFor(db, row!.grant_id, row!.vest_on);
    expect(stored).toBe(expected);
    expect(stored).not.toBe(projectedGross);
    // 90,720 / 1,29,600 = the 0.70 the owner actually withheld at.
    expect(Number(actual.netPaise) / Number(stored)).toBeCloseTo(0.70, 6);
  });

  it('refuses to confirm a vest whose net exceeds its recomputed gross', async () => {
    await persistVests(db, projectVests(SEED_RSU_GRANTS, opts), { asOf: AS_OF });
    const [row] = await db.query<{ id: string }>('select id from rsu_vests limit 1');
    await expect(confirmVest(db, row!.id, {
      units: 9, priceUsdCents: 15_000n, usdInrMicros: 96_000_000n, netPaise: rupees(200_000),
    })).rejects.toThrow(/net .* gross/i);
  });

  it('refuses to confirm a vest id that does not exist', async () => {
    await expect(confirmVest(db, '00000000-0000-0000-0000-000000000000', {
      units: 1, priceUsdCents: 100n, usdInrMicros: 96_000_000n, netPaise: rupees(1),
    })).rejects.toThrow(/no rsu_vests row/i);
  });

  it('refuses a confirmation carrying a negative net, units or price', async () => {
    await persistVests(db, projectVests(SEED_RSU_GRANTS, opts), { asOf: AS_OF });
    const [row] = await db.query<{ id: string }>('select id from rsu_vests limit 1');
    const ok = { units: 9, priceUsdCents: 15_000n, usdInrMicros: 96_000_000n,
                 netPaise: rupees(90_720) };

    // A zero gross with a Rs 5L negative net passed the one-sided `net > gross` check.
    await expect(confirmVest(db, row!.id, { ...ok, units: 0, netPaise: rupees(-500_000) }))
      .rejects.toThrow(/negative/i);
    await expect(confirmVest(db, row!.id, { ...ok, netPaise: rupees(-1) }))
      .rejects.toThrow(/negative/i);
    await expect(confirmVest(db, row!.id, { ...ok, units: -9 }))
      .rejects.toThrow(/negative/i);
    await expect(confirmVest(db, row!.id, { ...ok, priceUsdCents: -15_000n }))
      .rejects.toThrow(/negative/i);

    // Positive control: the same shape without the negatives still confirms.
    await confirmVest(db, row!.id, ok, { asOf: AS_OF });
    const [after] = await db.query<{ status: string; confirmed_on: string | Date }>(
      'select status, confirmed_on from rsu_vests where id = $1', [row!.id],
    );
    expect(after!.status).toBe('ACTUAL');
    // confirmed_on comes from the injected asOf, not the DB clock: `current_date` would
    // make a replayed confirmation stamp a different date every day it is re-run.
    expect(isoDate(after!.confirmed_on)).toBe(AS_OF.slice(0, 10));
    expect(isoDate(after!.confirmed_on)).not.toBe(isoDate(new Date()));
  });

  it('rolls the confirmation back if its audit row cannot be written', async () => {
    await persistVests(db, projectVests(SEED_RSU_GRANTS, opts), { asOf: AS_OF });
    const [row] = await db.query<{ id: string }>('select id from rsu_vests limit 1');

    // A row confirmed with no audit trail defeats the point of an append-only audit table.
    const auditDown: Db = {
      query: (sql: string, params?: unknown[]) => db.query(sql, params),
      exec: (sql: string) => db.exec(sql),
      withTransaction: <T>(fn: (tx: Db) => Promise<T>) => db.withTransaction((tx) => fn({
        query: <U = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<U[]> =>
          /insert into audit_log/i.test(sql)
            ? Promise.reject(new Error('audit sink down'))
            : tx.query<U>(sql, params),
        exec: (sql: string) => tx.exec(sql),
        withTransaction: <U>(f: (t: Db) => Promise<U>) => tx.withTransaction(f),
        close: () => Promise.resolve(),
      })),
      close: () => Promise.resolve(),
    };

    await expect(confirmVest(auditDown, row!.id, {
      units: 9, priceUsdCents: 15_000n, usdInrMicros: 96_000_000n, netPaise: rupees(90_720),
    }, { asOf: AS_OF })).rejects.toThrow(/audit sink down/);

    const [after] = await db.query<{ status: string; source: string }>(
      'select status, source from rsu_vests where id = $1', [row!.id],
    );
    expect(after!.status).toBe('PROJECTED');
    expect(after!.source).toBe('model');
    const audit = await db.query<{ n: string }>(
      'select count(*) as n from audit_log where entity = $1', ['rsu_vest'],
    );
    expect(Number(audit[0]!.n)).toBe(0);
  });

  it('never lets a projected upsert win a race against a concurrent confirmation', async () => {
    // FR-03 must hold in the SQL, not in application control flow. This proxy drives a real
    // owner confirmation into the window between persistVests' status read and its write.
    const vests = projectVests(SEED_RSU_GRANTS, opts);
    await persistVests(db, vests, { asOf: AS_OF });
    const key = vests[0]!;
    const [row] = await db.query<{ id: string }>(
      'select id from rsu_vests where grant_id = $1 and vest_on = $2', [key.grantId, key.vestOn],
    );
    const confirmed = { units: 9, priceUsdCents: 15_000n, usdInrMicros: 96_000_000n,
                        netPaise: rupees(90_720) };

    let raced = false;
    const racing: Db = {
      query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const out = await db.query<T>(sql, params);
        if (!raced && /from rsu_vests/.test(sql) && /^\s*select/i.test(sql)
            && params?.[0] === key.grantId && params?.[1] === key.vestOn) {
          raced = true;
          await confirmVest(db, row!.id, confirmed, { asOf: AS_OF });
        }
        return out;
      },
      exec: (sql: string) => db.exec(sql),
      withTransaction: <T>(fn: (tx: Db) => Promise<T>) => db.withTransaction(fn),
      close: () => Promise.resolve(),
    };

    await persistVests(racing, projectVests(SEED_RSU_GRANTS, { ...opts, priceUsd: 100 }), {
      asOf: '2027-01-01T00:00:00+05:30',
    });
    expect(raced).toBe(true); // the window was actually entered

    const [after] = await db.query<{
      status: string; units: string | number; net_paise: string | number;
      gross_paise: string | number; source: string; as_of: string | Date;
    }>(
      `select status, units, net_paise, gross_paise, source, as_of
         from rsu_vests where id = $1`, [row!.id],
    );
    expect(after!.status).toBe('ACTUAL');
    expect(Number(after!.units)).toBe(confirmed.units);
    expect(BigInt(after!.net_paise)).toBe(confirmed.netPaise);
    expect(BigInt(after!.gross_paise)).toBe(usdToInr(
      cents(confirmed.priceUsdCents * BigInt(confirmed.units)), confirmed.usdInrMicros,
    ));
    // Provenance must not be reverted to the model's either: a row claiming owner
    // confirmation while carrying model numbers is undetectable downstream.
    expect(after!.source).toBe('owner-confirmed');
    expect(new Date(after!.as_of).toISOString()).toBe(new Date(AS_OF).toISOString());
  });
});

/** A `date` column comes back as a Date from one driver and a string from another. */
function isoDate(d: string | Date): string {
  return typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

/** Months since year 0, so a tranche span can be asserted without date arithmetic. */
function monthIndex(date: string): number {
  const [y, m] = date.split('-').map(Number) as [number, number];
  return y * 12 + m;
}

async function grossFor(db: Db, grantId: string, vestOn: string): Promise<bigint> {
  const [r] = await db.query<{ gross_paise: string | number }>(
    'select gross_paise from rsu_vests where grant_id = $1 and vest_on = $2',
    [grantId, vestOn],
  );
  return BigInt(r!.gross_paise);
}
