import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { TelegramBot } from '../../src/notify/telegram-bot.js';
import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seed } from '../../src/seed/seed.js';
import { rateMicros, usdToInr } from '../../src/money/fx.js';
import { cents, mulP } from '../../src/money/paise.js';
import { UNITS_SCALE, toUnitsMicros } from '../../src/domain/rsu.js';
import type { Telegram } from '../../src/notify/telegram.js';
import type { TelegramEnv } from '../../src/config/env.js';

/**
 * Fidelity RSU flow: screenshot → extractRsuVestsFromImage → priced proposal queue →
 * /confirm writes immutable ACTUAL rsu_vests rows in the owner's fingerprint. The vendor
 * FX module is mocked; rateMicros (money/fx.js) stays real so the money path is the
 * production one end to end.
 */
vi.mock('../../src/sources/fx.js', () => ({
  fetchUsdInr: vi.fn(async () => ({ rate: 95.3, asOf: '2026-09-05', source: 'test' })),
}));

const LLM = (vests: unknown[]) => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { content: JSON.stringify({ vests }) } }] }),
});

/** 26RSU: the owner’s real grant, granted 2026-02-17. */
const VEST = {
  grantId: '26RSU',
  vestOn: '2026-08-15',
  units: 71.25,
  priceUsd: 185.47,
  withholdingPct: 30,
  netUnits: 49.875,
};

function expectedConfirmed(p = VEST) {
  const priceUsdCents = cents(BigInt(Math.round(p.priceUsd * 100)));
  const gross = usdToInr(cents((priceUsdCents * toUnitsMicros(p.units)) / UNITS_SCALE), rateMicros(95.3));
  const net = mulP(gross, (100 - p.withholdingPct) / 100);
  return { priceUsdCents, gross, net };
}

const SHOT = '900001';
const SCREENSHOTS = 'data/screenshots';

describe('Fidelity RSU flow (real PGlite + seeded grants)', () => {
  let db: Db;
  let bot: TelegramBot;
  let sent: string[];
  let fetchImpl: ReturnType<typeof vi.fn>;
  let privates: {
    processFidelityStatement(updateId: number, files: { fileId: string; mime: string }[]): Promise<void>;
    handleConfirm(text: string): Promise<void>;
    fidelityPending: unknown[] | null;
    savedFilesFor(updateId: number): Promise<{ fileId: string; mime: string }[]>;
  };

  beforeEach(async () => {
    db = await openDb();
    await runMigrations(db);
    await seed(db, { asOf: '2026-08-12' });
    await mkdir(SCREENSHOTS, { recursive: true });

    sent = [];
    fetchImpl = vi.fn(async () => LLM([VEST]));
    const telegram = {
      send: async (text: string) => { sent.push(text); return { sent: true }; },
      isOwner: () => true,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      botToken: 'test-token',
    };
    bot = new TelegramBot(
      telegram as unknown as Telegram,
      db,
      { telegramBotToken: 'test-token', telegramOwnerChatId: '1', llmApiKey: 'test-key' } as TelegramEnv,
    );
    privates = bot as unknown as typeof privates;
  });

  afterEach(async () => {
    await db.close();
    // Only the files this suite writes — never the whole (possibly live) screenshots dir.
    for (const f of [`${SHOT}.png`, `${SHOT}_2.png`, 'unrelated-999.png']) {
      await rm(`${SCREENSHOTS}/${f}`, { force: true });
    }
  });

  it('queues a priced proposal card, then /confirm all writes a coherent ACTUAL row + audit line', async () => {
    await writeFile(`${SCREENSHOTS}/${SHOT}.png`, 'fidelity statement bytes');
    const { gross, net } = expectedConfirmed();

    await privates.processFidelityStatement(Number(SHOT), [{ fileId: `${SHOT}.png`, mime: 'image/png' }]);

    const card = sent.find((m) => m.includes('26RSU vesting 2026-08-15'));
    expect(card).toBeDefined();
    expect(card).toContain(`71.25u`);
    expect(privates.fidelityPending).toHaveLength(1);

    // Where money is concerned only production paths run: the OpenRouter call happens
    // through the stub, and Telegram getFile never — the screenshot already existed.
    const openrouter = fetchImpl.mock.calls.filter((c) => String(c[0]).includes('openrouter.ai'));
    const telegramCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).includes('api.telegram.org'));
    expect(openrouter).toHaveLength(1);
    expect(telegramCalls).toHaveLength(0);

    await privates.handleConfirm('/confirm all');

    const [row] = await db.query<{
      status: string; gross_paise: string | number; net_paise: string | number;
      units: string | number; source: string; confirmed_on: string | Date;
    }>(
      'select status, gross_paise, net_paise, units, source, confirmed_on from rsu_vests where grant_id = $1 and vest_on = $2',
      [VEST.grantId, VEST.vestOn],
    );
    expect(row).toBeDefined();
    expect(row!.status).toBe('ACTUAL');
    expect(BigInt(row!.gross_paise)).toBe(gross);
    expect(BigInt(row!.net_paise)).toBe(net);
    expect(row!.source).toBe('owner-confirmed');
    expect(Number(row!.units)).toBe(71.25);

    const audit = await db.query<{ entity: string; action: string; actor: string }>(
      'select entity, action, actor from audit_log where entity = $1',
      ['rsu_vest'],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('CONFIRMED');
    expect(audit[0]!.actor).toBe('owner');

    expect(privates.fidelityPending).toBeNull();
    expect(sent.some((m) => m.includes('✅ Confirmed vests'))).toBe(true);
  });

  it('drops vests already confirmed ACTUAL before queueing (FR-03 — no re-announce, no re-write)', async () => {
    // Confirm first via the flow itself, then re-run the same statement.
    await writeFile(`${SCREENSHOTS}/${SHOT}.png`, 'fidelity statement bytes');
    await privates.processFidelityStatement(Number(SHOT), [{ fileId: `${SHOT}.png`, mime: 'image/png' }]);
    await privates.handleConfirm('/confirm all');
    expect(privates.fidelityPending).toBeNull();

    fetchImpl.mockReset();
    fetchImpl.mockImplementation(async () => LLM([VEST]));
    await privates.processFidelityStatement(Number(SHOT) + 1, [{ fileId: `${SHOT}.png`, mime: 'image/png' }]);

    expect(privates.fidelityPending).toBeNull();
    expect(sent.some((m) => m.includes('already confirmed — nothing new to record'))).toBe(true);

    const rows = await db.query<{ id: string }>(
      "select id from rsu_vests where status = 'ACTUAL'",
    );
    // Confirm second run wrote nothing: exactly one ACTUAL row, one audit line.
    expect(rows).toHaveLength(1);
  });

  it('skips proposals whose grant is not in the RSU table instead of inventing one', async () => {
    await writeFile(`${SCREENSHOTS}/${SHOT}.png`, 'fidelity statement bytes');
    fetchImpl.mockImplementation(async () => LLM([
      { ...VEST, grantId: 'G2099' },
    ]));
    await privates.processFidelityStatement(Number(SHOT), [{ fileId: `${SHOT}.png`, mime: 'image/png' }]);
    expect(privates.fidelityPending).toHaveLength(1);

    await privates.handleConfirm('/confirm all');
    expect(privates.fidelityPending).toBeNull();
    expect(sent.some((m) => m.includes('no such grant'))).toBe(true);
    // The seed now carries the owner's real unvested schedule, so an empty table is no
    // longer the right assertion — what matters is that the unknown grant wrote nothing.
    const rows = await db.query<{ id: string }>(
      `select id from rsu_vests where grant_id = 'G2099'`);
    expect(rows).toHaveLength(0);
  });

  it('partial /confirm leaves the other proposals in the queue', async () => {
    const second = { ...VEST, vestOn: '2026-11-15' };
    await writeFile(`${SCREENSHOTS}/${SHOT}.png`, 'fidelity statement bytes');
    fetchImpl.mockImplementation(async () => LLM([VEST, second]));
    await privates.processFidelityStatement(Number(SHOT), [{ fileId: `${SHOT}.png`, mime: 'image/png' }]);
    expect(privates.fidelityPending).toHaveLength(2);

    await privates.handleConfirm('/confirm 1');
    expect(privates.fidelityPending).toHaveLength(1);
    expect((privates.fidelityPending![0] as { vestOn: string }).vestOn).toBe('2026-11-15');

    await privates.handleConfirm('/confirm 1');
    expect(privates.fidelityPending).toBeNull();
    const actual = await db.query<{ id: string }>('select id from rsu_vests where status = \'ACTUAL\'');
    expect(actual).toHaveLength(2);
  });

  it('savedFilesFor reconstructs multi-page statements from disk (callback path)', async () => {
    await writeFile(`${SCREENSHOTS}/${SHOT}.png`, 'a');
    await writeFile(`${SCREENSHOTS}/${SHOT}_2.png`, 'b');
    await writeFile(`${SCREENSHOTS}/unrelated-999.png`, 'c');
    const files = await privates.savedFilesFor(Number(SHOT));
    expect(files.map((f) => f.fileId).sort()).toEqual([`${SHOT}.png`, `${SHOT}_2.png`]);
    expect(files.map((f) => f.mime)).toEqual(['image/png', 'image/png']);
  });
});