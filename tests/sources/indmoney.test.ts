import { describe, expect, it } from 'vitest';
import { FileIndmoneySource } from '../../src/sources/indmoney.js';
import { rupees } from '../../src/money/paise.js';

const source = new FileIndmoneySource('tests/fixtures/indmoney-snapshot.json');

describe('FileIndmoneySource', () => {
  it('reads the owner-refreshed snapshot and reports its own asOf', async () => {
    const { rows, asOf } = await source.fetch();
    expect(asOf).toBe('2026-08-12T18:30:00+05:30');
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.instrumentId === 'MF:PPFC')!.valuePaise).toBe(rupees(241_000));
  });

  it('treats a Zerodha-linked zero cost as unknown, per the documented INDmoney gap', async () => {
    const { rows } = await source.fetch();
    expect(rows.find((r) => r.instrumentId === 'NSE:NIFTYBEES')!.avgCostPaise).toBeNull();
    expect(rows.find((r) => r.instrumentId === 'MF:PPFC')!.avgCostPaise).toBe(rupees(180_000));
  });

  it('tags every row to the indmoney account', async () => {
    const { rows } = await source.fetch();
    expect(rows.every((r) => r.account === 'indmoney')).toBe(true);
  });

  it('fails loudly when the snapshot file is missing rather than syncing nothing', async () => {
    await expect(new FileIndmoneySource('tests/fixtures/nope.json').fetch())
      .rejects.toThrow(/indmoney snapshot/i);
  });
});