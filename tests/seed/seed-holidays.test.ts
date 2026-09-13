import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import {
  SEED_HOLIDAYS_2026,
  isTradingDay,
  seedHolidays,
} from '../../src/seed/seed-holidays.js';

let db: Db;
beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
});

describe('the NSE trading calendar', () => {
  it('is seeded with the full year and is idempotent', async () => {
    await seed(db, { asOf: '2026-08-12' });
    const [row] = await db.query<{ n: string }>(`select count(*) as n from holidays`);
    expect(Number(row!.n)).toBe(SEED_HOLIDAYS_2026.length);
    // A re-seed writes nothing new rather than failing on the primary key.
    expect(await seedHolidays(db)).toBe(0);
  });

  it('closes the exchange on a weekday holiday', async () => {
    await seedHolidays(db);
    // Derived from the seed rather than restated: every non-special entry is closed.
    for (const h of SEED_HOLIDAYS_2026.filter((x) => x.specialSession !== true)) {
      expect(await isTradingDay(db, h.date), `${h.date} ${h.note}`).toBe(false);
    }
  });

  it('opens the exchange on the Muhurat Sunday the weekend rule would skip', async () => {
    await seedHolidays(db);
    const muhurat = SEED_HOLIDAYS_2026.find((h) => h.specialSession === true)!;
    expect(new Date(`${muhurat.date}T00:00:00Z`).getUTCDay()).toBe(0); // a Sunday
    expect(await isTradingDay(db, muhurat.date)).toBe(true);
  });

  it('treats an ordinary weekday as open and an ordinary weekend as closed', async () => {
    await seedHolidays(db);
    expect(await isTradingDay(db, '2026-09-15')).toBe(true); // Tuesday
    expect(await isTradingDay(db, '2026-09-12')).toBe(false); // Saturday
    expect(await isTradingDay(db, '2026-09-13')).toBe(false); // Sunday
  });

  it('degrades to the weekend rule when the calendar is empty', async () => {
    // Wrong on ~15 days a year, but wrong in the loud direction: it asks NSE for a file
    // that is not there rather than skipping a day that has one.
    expect(await isTradingDay(db, '2026-09-14')).toBe(true); // Ganesh Chaturthi, unseeded
    expect(await isTradingDay(db, '2026-09-13')).toBe(false);
  });
});
