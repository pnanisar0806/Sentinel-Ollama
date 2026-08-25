import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import {
  parseCostCommand,
  insertOwnerCostLot,
  saveStatementPhoto,
} from '../../src/sources/owner-ingest.js';
import { paise } from '../../src/money/paise.js';

const NOW = '2026-08-25T10:00:00.000Z';

describe('parseCostCommand', () => {
  it('parses index, money and optional acquired date', () => {
    const c = parseCostCommand('/cost 3 47255.50 2024-06-15', 20);
    expect(c.index).toBe(2); // 1-based on screen, 0-based internally
    expect(c.costPaise).toBe(4_725_550n);
    expect(c.acquiredOn).toBe('2024-06-15');
  });

  it('accepts Rs symbols, commas and defaults the date to today', () => {
    const c = parseCostCommand('/cost 12 ₹47,255.50', 20, new Date(NOW));
    expect(c.index).toBe(11);
    expect(c.costPaise).toBe(4_725_550n);
    expect(c.acquiredOn).toBe('2026-08-25');
  });

  it('rejects an out-of-range line number by name', () => {
    expect(() => parseCostCommand('/cost 99 100', 20))
      .toThrow(/no position 99.*\/holdings/s);
  });

  it('rejects non-positive costs — a cost basis is never zero or negative', () => {
    expect(() => parseCostCommand('/cost 1 0', 20)).toThrow(/positive/);
    expect(() => parseCostCommand('/cost 1 -5', 20)).toThrow(/positive/);
  });

  it('rejects garbage money instead of coercing it toward zero', () => {
    expect(() => parseCostCommand('/cost 1 abc', 20)).toThrow(/invalid rupee/);
  });

  it('rejects a malformed date rather than silently storing one', () => {
    expect(() => parseCostCommand('/cost 1 100 15-06-2024', 20)).toThrow(/YYYY-MM-DD/);
  });
});

describe('insertOwnerCostLot', () => {
  let db: Db;
  it('writes an open owner-sourced lot plus an audit row, in one transaction', async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-24' });

    const { lotId } = await insertOwnerCostLot(db, {
      instrumentId: 'NSE:GOLDBEES',
      account: 'zerodha',
      quantity: 2616,
      costPaise: paise(6_300_000n),
      acquiredOn: '2024-01-15',
      now: NOW,
    });

    const lots = await db.query<Record<string, unknown>>(
      `select * from lots where id = $1::uuid`, [lotId],
    );
    expect(lots).toHaveLength(1);
    const lot = lots[0]!;
    expect(lot.instrument_id).toBe('NSE:GOLDBEES');
    expect(lot.account).toBe('zerodha');
    expect(lot.cost_paise).toBe(6_300_000);
    // numeric(20,6) surfaces as a string from PGlite — widen before comparing.
    expect(Number(lot.quantity)).toBe(2616);
    expect(lot.closed_on).toBeNull();
    expect(lot.seeded).toBe(true);
    expect(lot.source).toBe('owner-telegram');
    expect((lot.as_of as Date).toISOString()).toBe(NOW);

    const audits = await db.query<{ entity: string; entity_id: string; action: string; actor: string; payload: Record<string, unknown> }>(
      `select entity, entity_id, action, actor, payload from audit_log where entity = 'lots'`,
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entity_id).toBe(lotId);
    expect(audits[0]!.action).toBe('ingest');
    expect(audits[0]!.actor).toBe('owner');
    expect(audits[0]!.payload).toMatchObject({ via: 'telegram', costPaise: '6300000' });

    await db.close();
  });

  it('refuses a lot whose instrument does not exist (FK is load-bearing)', async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-24' });
    await expect(insertOwnerCostLot(db, {
      instrumentId: 'NOPE:NOPE', account: 'x', costPaise: paise(1n),
      acquiredOn: '2024-01-01', now: NOW,
    })).rejects.toThrow();
    await db.close();
  });
});

describe('insertOwnerCostLot reconciliation — upload must not duplicate', () => {
  // Owner-reported hazard (2026-08-25): re-uploading statements re-recorded costs,
  // refilling lots with redundant open rows. Contract: same value = no-op,
  // changed value = supersede (close old, write new), new position = create.
  it('creates once, then reports unchanged WITHOUT writing a second lot', async () => {
    const db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-24' });

    const first = await insertOwnerCostLot(db, {
      instrumentId: 'NSE:GOLDBEES', account: 'zerodha',
      costPaise: paise(6_300_000n), acquiredOn: '2024-01-15', now: NOW,
    });
    expect(first.outcome).toBe('created');

    const second = await insertOwnerCostLot(db, {
      instrumentId: 'NSE:GOLDBEES', account: 'zerodha',
      costPaise: paise(6_300_000n), acquiredOn: '2026-08-25', now: NOW,
    });
    expect(second.outcome).toBe('unchanged');
    expect(second.lotId).toBe(first.lotId);

    const open = await db.query(
      `select id from lots where source = 'owner-telegram' and closed_on is null`,
    );
    expect(open).toHaveLength(1);
    await db.close();
  });

  it('supersedes on a changed value — old lot closes, exactly one open remains', async () => {
    const db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-24' });

    const before = await insertOwnerCostLot(db, {
      instrumentId: 'NSE:GOLDBEES', account: 'zerodha',
      costPaise: paise(6_300_000n), acquiredOn: '2024-01-15', now: NOW,
    });
    const after = await insertOwnerCostLot(db, {
      instrumentId: 'NSE:GOLDBEES', account: 'zerodha',
      costPaise: paise(7_100_000n), acquiredOn: '2024-01-15', now: NOW,
    });

    expect(after.outcome).toBe('superseded');
    expect(after.lotId).not.toBe(before.lotId);
    expect(after.previousCostPaise).toBe(6_300_000n);

    const lots = await db.query<{ id: string; cost_paise: number; closed_on: string | null }>(
      `select id, cost_paise, closed_on from lots
       where source = 'owner-telegram' order by as_of`,
    );
    expect(lots).toHaveLength(2);
    expect(lots[0]!.closed_on).not.toBeNull();     // old value closed…
    expect(lots[1]!.closed_on).toBeNull();          // …new value open
    expect(lots[1]!.cost_paise).toBe(7_100_000);    // ₹71,000 in paise

    const audits = await db.query<{ action: string; payload: Record<string, unknown> }>(
      `select action, payload from audit_log where entity = 'lots' order by action`,
    );
    expect(audits.map((a) => a.action)).toEqual(['ingest', 'ingest']);
    await db.close();
  });

  it('refuses a second open owner lot even from RAW SQL — the index, not app code, enforces it', async () => {
    const db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-24' });
    await insertOwnerCostLot(db, {
      instrumentId: 'NSE:GOLDBEES', account: 'zerodha',
      costPaise: paise(6_300_000n), acquiredOn: '2024-01-15', now: NOW,
    });

    await expect(db.query(
      `insert into lots (instrument_id, account, acquired_on, quantity, cost_paise, closed_on, seeded, as_of, source)
       values ('NSE:GOLDBEES', 'zerodha', '2024-01-15', 1, 999, null, true, $1, 'owner-telegram')`,
      [NOW],
    )).rejects.toThrow();

    // Closing the first makes room again — disposal/supersession lifecycle intact.
    await db.query(`update lots set closed_on = '2026-08-25' where source = 'owner-telegram'`);
    await expect(db.query(
      `insert into lots (instrument_id, account, acquired_on, quantity, cost_paise, closed_on, seeded, as_of, source)
       values ('NSE:GOLDBEES', 'zerodha', '2024-01-15', 1, 999, null, true, $1, 'owner-telegram')`,
      [NOW],
    )).resolves.toBeTruthy();
    await db.close();
  });
});

describe('saveStatementPhoto', () => {
  const DIR = 'data/screenshots/.test-tmp';

  afterEach(async () => {
    await rm(DIR, { recursive: true, force: true });
  });

  it('resolves the file, downloads the bytes and stores them under the update id', async () => {
    const bytes = new Uint8Array([1, 2, 3, 42]);
    const calls: string[] = [];
    const fetchImpl = (async (url: string | URL | RequestInfo, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'statement/x.jpg' } }), { status: 200 });
      }
      return new Response(bytes, { status: 200 });
    }) as typeof fetch;

    const out = await saveStatementPhoto({
      fetchImpl,
      botToken: 'T',
      fileId: 'FID',
      dir: DIR,
      updateId: 777,
    });

    expect(out).toMatch(/777\.jpg$/);
    expect(calls[0]).toContain('/getFile');
    expect(calls[1]).toContain('/file/botT/statement/x.jpg');
    const stored = await readFileBytes(out);
    expect([...stored]).toEqual([...bytes]);
  });

  it('surfaces a provider error instead of writing a corrupt file', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ok: false, description: 'file not found' }), { status: 200 })
    ) as typeof fetch;
    await expect(saveStatementPhoto({
      fetchImpl, botToken: 'T', fileId: 'BAD', dir: DIR, updateId: 1,
    })).rejects.toThrow(/file not found/);
  });
});

async function readFileBytes(path: string): Promise<Uint8Array> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path);
}
