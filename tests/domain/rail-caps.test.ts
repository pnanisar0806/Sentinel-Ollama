import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { IPS_V1_TEXT } from '../../src/config/ips-v1.js';
import { CAP_RAILS, DEFAULT_OWNER_RAILS, loadCaps } from '../../src/domain/rail-values.js';
import { CAPS, concentration } from '../../src/domain/allocation.js';
import { checkPortfolioRails } from '../../src/domain/rails.js';
import type { Position } from '../../src/domain/networth.js';
import { rupees, type Paise } from '../../src/money/paise.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await seed(db, { asOf: '2026-08-12' });
});

/** IPS §3.5, read from the signed text itself: the side the defaults are checked against. */
function ipsCapPct(label: RegExp): number {
  const line = IPS_V1_TEXT.split('\n').find((l) => label.test(l));
  if (line === undefined) throw new Error(`IPS line not found: ${label}`);
  return Number(/≤(\d+(?:\.\d+)?)%/.exec(line)![1]);
}

const pos = (id: string, value: Paise, extra: Partial<Position> = {}): Position => ({
  instrumentId: id, name: id, kind: 'EQUITY', valuePaise: value, sector: null, currency: 'INR', account: 'zerodha',
  source: 'test', asOf: new Date().toISOString(), assetClass: 'EQUITY', issuer: null, isEmployer: false, avgCostPaise: null,
  ...extra,
});

describe('concentration caps are owner rails (open list #4)', () => {
  it('the default rails are the IPS §3.5 caps', () => {
    expect(DEFAULT_OWNER_RAILS[CAP_RAILS.singleStock]).toBe(ipsCapPct(/Any single stock:/));
    expect(DEFAULT_OWNER_RAILS[CAP_RAILS.singleIssuer]).toBe(ipsCapPct(/Any single issuer/));
    expect(DEFAULT_OWNER_RAILS[CAP_RAILS.singleMfScheme]).toBe(ipsCapPct(/Any single MF scheme:/));
    expect(DEFAULT_OWNER_RAILS[CAP_RAILS.singleSector]).toBe(ipsCapPct(/Any single sector/));
    expect(DEFAULT_OWNER_RAILS[CAP_RAILS.employer]).toBe(ipsCapPct(/Employer stock/));
  });

  it('CAPS is the defaults as fractions, and a fresh database loads the same', async () => {
    for (const [k, key] of Object.entries(CAP_RAILS)) {
      expect(CAPS[k as keyof typeof CAPS]).toBeCloseTo(Number(DEFAULT_OWNER_RAILS[key]) / 100, 10);
    }
    expect(await loadCaps(db)).toEqual(CAPS);
  });

  it('loadCaps reads settings_rails, fractional percents included', async () => {
    await db.query(`update settings_rails set value = '5'::jsonb where key = 'employer_cap_pct'`);
    await db.query(`update settings_rails set value = '12.5'::jsonb where key = 'sector_cap_pct'`);
    const caps = await loadCaps(db);
    expect(caps.employer).toBeCloseTo(0.05, 10);
    expect(caps.singleSector).toBeCloseTo(0.125, 10);
  });

  it('concentration measures against the caps it is given', () => {
    const positions = [pos('US:NOW', rupees(8_000), { isEmployer: true }), pos('NSE:X', rupees(92_000))];
    const employer = (b: string[]) => b.filter((x) => x.startsWith('Employer cap'));
    expect(employer(concentration(positions).breaches)).toHaveLength(0);
    expect(employer(concentration(positions, { ...CAPS, employer: 0.05 }).breaches)).toHaveLength(1);
  });

  it('checkPortfolioRails enforces the cap stored in settings_rails', async () => {
    const positions = [pos('US:NOW', rupees(8_000), { isEmployer: true }), pos('NSE:X', rupees(92_000), { kind: 'MF', assetClass: 'EQUITY' })];
    const employer = async () => (await checkPortfolioRails(db, positions, rupees(100_000)))
      .filter((v) => v.code === 'CONCENTRATION_BREACH' && v.detail.startsWith('Employer cap'));
    expect(await employer()).toHaveLength(0);
    await db.query(`update settings_rails set value = '5'::jsonb where key = 'employer_cap_pct'`);
    expect(await employer()).toHaveLength(1);
  });

  it('migration 0044 corrects the four seeded rails that contradicted the PRD, and only those', async () => {
    const set = (k: string, v: number) => db.query(`update settings_rails set value = $2::jsonb where key = $1`, [k, JSON.stringify(v)]);
    await set('employer_cap_pct', 25); await set('mf_scheme_cap_pct', 10);
    await set('sector_cap_pct', 20); await set('issuer_cap_pct', 15);
    await set('single_stock_cap_pct', 7); // an owner's own value is never overwritten
    await db.exec(await readFile(new URL('../../migrations/0044_cap_rails_prd.sql', import.meta.url), 'utf8'));
    const rows = await db.query<{ key: string; value: number }>(`select key, value from settings_rails where key like '%cap_pct' and key <> 'cash_ceiling_pct'`);
    expect(Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]))).toEqual({
      employer_cap_pct: 10, mf_scheme_cap_pct: 35, sector_cap_pct: 25, issuer_cap_pct: 10, single_stock_cap_pct: 7,
    });
  });
});
