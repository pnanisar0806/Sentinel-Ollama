import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';

/** Batch C Task 1: holding rules, their exceptions and life events are append-only and self-checking. */
let db: Db;
const META = `'2026-10-31T06:00:00Z', 'owner-web'`;

beforeEach(async () => {
  db = await openDb();
  await runMigrations(db);
  await db.exec(`insert into instruments (id, kind, name) values ('MF:TEST', 'MF', 'Test Fund')`);
});
afterEach(async () => { await db.close(); });

const rule = (kind: string, untilOn = 'null', capBps = 'null') => db.query<{ id: string }>(
  `insert into holding_rules (instrument_id, kind, until_on, cap_bps, occurred_on, as_of, source)
   values ('MF:TEST', '${kind}', ${untilOn}, ${capBps}, '2026-10-31', ${META}) returning id`);

describe('migration 0042 — rules and events', () => {
  it('refuses a HOLD_UNTIL without until_on', async () => {
    await expect(rule('HOLD_UNTIL')).rejects.toThrow();
    await expect(rule('HOLD_UNTIL', `'2027-06-30'`)).resolves.toHaveLength(1);
  });

  it('refuses a CAP_PCT without cap_bps, and cap_bps on any other kind', async () => {
    await expect(rule('CAP_PCT')).rejects.toThrow();
    await expect(rule('NO_ADD', 'null', '500')).rejects.toThrow();
    await expect(rule('CAP_PCT', 'null', '500')).resolves.toHaveLength(1);
  });

  it('an exception names exactly one of month and lump sum', async () => {
    const [r] = await rule('NO_ADD');
    const [l] = await db.query<{ id: string }>(
      `insert into lump_sums (received_on, amount_paise, from_text, as_of, source) values ('2026-10-28', 100, 'bond', ${META}) returning id`);
    const ex = (month: string, lump: string) => db.query(
      `insert into holding_rule_exceptions (rule_id, month, lump_sum_id, note, as_of, source) values ($1, ${month}, ${lump}, 'once', ${META})`,
      [r!.id]);
    await expect(ex(`'2026-11'`, `'${l!.id}'`)).rejects.toThrow();
    await expect(ex('null', 'null')).rejects.toThrow();
    await expect(ex(`'2026-13'`, 'null')).rejects.toThrow();
    await expect(ex(`'2026-11'`, 'null')).resolves.toBeDefined();
    await expect(ex('null', `'${l!.id}'`)).resolves.toBeDefined();
  });

  it('holding_rules is append-only', async () => {
    await rule('NO_REBUY');
    await expect(db.query(`update holding_rules set note = 'x'`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from holding_rules`)).rejects.toThrow(/append-only/);
  });

  it('life_events cannot be truncated, and ENDED needs the event it ends', async () => {
    const [e] = await db.query<{ id: string }>(
      `insert into life_events (kind, occurred_on, amount_paise, as_of, source) values ('WINDFALL', '2026-10-01', 100, ${META}) returning id`);
    await expect(db.query(
      `insert into life_events (kind, occurred_on, as_of, source) values ('ENDED', '2026-10-02', ${META})`)).rejects.toThrow();
    await expect(db.query(
      `insert into life_events (kind, occurred_on, ends_event_id, as_of, source) values ('ENDED', '2026-10-02', $1, ${META})`, [e!.id])).resolves.toBeDefined();
    await expect(db.query(`truncate life_events cascade`)).rejects.toThrow(/append-only/);
  });

  it('a NEEDS_CHANGE review needs its new value', async () => {
    const [e] = await db.query<{ id: string }>(
      `insert into life_events (kind, occurred_on, as_of, source) values ('JOB_LOSS', '2026-10-01', ${META}) returning id`);
    const review = (outcome: string, v: string) => db.query(
      `insert into life_event_reviews (event_id, item_key, outcome, new_value_text, as_of, source) values ($1, 'sip', '${outcome}', ${v}, ${META})`, [e!.id]);
    await expect(review('NEEDS_CHANGE', 'null')).rejects.toThrow();
    await expect(review('NEEDS_CHANGE', `'pause'`)).resolves.toBeDefined();
    await expect(review('STILL_RIGHT', 'null')).resolves.toBeDefined();
  });

  it('log_reversals accepts the three new entities', async () => {
    for (const entity of ['holding_rule', 'holding_rule_exception', 'life_event']) {
      await expect(db.query(
        `insert into log_reversals (entity, entity_id, reason, as_of, source) values ($1, 'x', 'ended early', ${META})`, [entity])).resolves.toBeDefined();
    }
  });
});
