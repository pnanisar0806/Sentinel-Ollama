import { describe, expect, it } from 'vitest';
import { TelegramBot } from '../../src/notify/telegram-bot.js';
import type { Db } from '../../src/db/client.js';
import type { TelegramEnv } from '../../src/config/env.js';
import type { Telegram } from '../../src/notify/telegram.js';
import { displayOrder } from '../../src/notify/telegram-bot.js';
import type { Paise } from '../../src/money/paise.js';

/**
 * Live-test findings 2026-08-25: /holdings renders alphabetically while /cost resolved
 * against loadPositions' NATURAL order — line N named one instrument and wrote another's
 * cost. And a partial /confirm left confirmed proposals in the pending list, so a repeat
 * /confirm (or a later /confirm all) double-wrote lots. These tests pin both.
 */

interface RowShape {
  instrument_id: string;
  kind: string;
  name: string;
  account: string;
  value_paise: number;
  avg_cost_paise: number | null;
  currency: string;
  issuer: string | null;
  sector: string | null;
  is_employer: boolean;
  as_of: string;
  source: string;
  canonical_id: string | null;
}

const row = (id: string, name: string): RowShape => ({
  instrument_id: id,
  kind: 'MF',
  name,
  account: 'zerodha',
  value_paise: 100_000,
  avg_cost_paise: null,
  currency: 'INR',
  issuer: null,
  sector: null,
  is_employer: false,
  as_of: '2026-08-25T10:00:00Z',
  source: 'indmoney',
  canonical_id: null,
});

/** Natural order deliberately ≠ alphabetical: display says line 2 is Beta,
 *  but unsorted index 1 is Alpha — the exact divergence that mis-wrote costs. */
const ROWS: RowShape[] = [
  row('IDX:ZEBRA', 'Zebra Fund'),
  row('IDX:ALPHA', 'Alpha Fund'),
  row('IDX:BETA', 'Beta Fund'),
];

function makeDeps(rows: RowShape[]) {
  const sent: string[] = [];
  const lotInserts: unknown[][] = [];
  const stub: {
    query(sql: string, params?: unknown[]): Promise<unknown[]>;
    exec(sql: string): Promise<void>;
    withTransaction<T>(fn: (tx: never) => Promise<T>): Promise<T>;
    close(): Promise<void>;
  } = {
    query: async (sql, params) => {
      if (sql.includes('from holdings h')) return rows;
      if (sql.trim().startsWith('insert into lots')) {
        lotInserts.push(params ?? []);
        return [{ id: `lot-${lotInserts.length}` }];
      }
      return [];
    },
    exec: async () => {},
    withTransaction: async (fn) => fn(stub as never),
    close: async () => {},
  };
  const telegram = {
    send: async (text: string) => {
      sent.push(text);
      return undefined;
    },
    isOwner: () => true,
  };
  const bot = new TelegramBot(
    telegram as unknown as Telegram,
    stub as unknown as Db,
    {} as TelegramEnv,
  );
  const privates = bot as unknown as {
    handleHoldings(): Promise<void>;
    handleCost(text: string): Promise<void>;
    handleConfirm(text: string): Promise<void>;
    pending: ({ line: number | null; name: string; costPaise: Paise; acquiredOn: string; confidence: 'high' | 'low'; instrumentId: string | null; account: string | null }[]) | null;
  };
  return { bot, privates, sent, lotInserts };
}

describe('displayOrder', () => {
  it('orders by name with instrumentId fallback, without mutating the input', () => {
    const input = [
      { name: 'Zulu', instrumentId: 'C' },
      { name: null, instrumentId: 'Aardvark' },
      { name: '', instrumentId: 'Beta' },
      { name: 'Apple', instrumentId: 'D' },
    ];
    const snapshot = [...input];
    const out = displayOrder(input);
    expect(out.map((p) => p.name || p.instrumentId)).toEqual([
      'Aardvark',
      'Apple',
      'Beta',
      'Zulu',
    ]);
    expect(input).toEqual(snapshot);
  });
});

describe('/cost resolves against the line numbers /holdings displayed', () => {
  it('writes the cost to the instrument shown at that line, not to natural order', async () => {
    const { privates, lotInserts } = makeDeps(ROWS);

    await privates.handleHoldings();
    void privates; // handled below via fresh deps so sends don't interfere

    const { privates: p2, sent, lotInserts: lots2 } = makeDeps(ROWS);
    await p2.handleHoldings();
    expect(sent.join('\n')).toContain('1. Alpha Fund');
    expect(sent.join('\n')).toContain('2. Beta Fund');
    expect(sent.join('\n')).toContain('3. Zebra Fund');

    await p2.handleCost('/cost 2 123456');
    expect(lots2).toHaveLength(1);
    // params: instrument_id, account, acquired_on, quantity, cost_paise, now
    expect(lots2[0]![0]).toBe('IDX:BETA');
    expect(lots2[0]![4]).toBe('12345600');
    void lotInserts;
  });
});

describe('/confirm partial writes', () => {
  const proposal = (name: string, id: string | null) => ({
    line: null,
    name,
    costPaise: 100n as Paise,
    acquiredOn: '2026-01-01',
    confidence: 'high' as const,
    instrumentId: id,
    account: id === null ? null : 'zerodha',
  });

  it('removes written entries from pending so they cannot be written twice', async () => {
    const { privates, lotInserts } = makeDeps([]);
    privates.pending = [
      proposal('A', 'IDX:A'),
      proposal('B', 'IDX:B'),
      proposal('C', 'IDX:C'),
    ];

    await privates.handleConfirm('/confirm 2');
    expect(lotInserts).toHaveLength(1);
    expect(lotInserts[0]![0]).toBe('IDX:B');
    expect(privates.pending!.map((p) => p.instrumentId)).toEqual(['IDX:A', 'IDX:C']);

    await privates.handleConfirm('/confirm all');
    expect(lotInserts).toHaveLength(3);
    expect(lotInserts.map((l) => l![0]).sort()).toEqual(['IDX:A', 'IDX:B', 'IDX:C']);
    expect(privates.pending).toBeNull();
  });

  it('drops unmatched proposals from pending after reporting them', async () => {
    const { privates, lotInserts, sent } = makeDeps([]);
    privates.pending = [proposal('Ghost', null), proposal('Real', 'IDX:REAL')];

    await privates.handleConfirm('/confirm all');
    expect(lotInserts).toHaveLength(1);
    expect(lotInserts[0]![0]).toBe('IDX:REAL');
    expect(sent.join('\n')).toContain('Skipped');
    expect(privates.pending).toBeNull();
  });
});
