import type { Db } from '../../src/db/client.js';

/**
 * Piece 3 Task 3: stocks that pass every one of the five checks unless a test overrides a
 * field. Four Chemicals peers plus the stocks themselves sit in one Screener upload, every
 * one at ₹2000 / EPS 100 = P/E 20, so the sector median is 20 over ≥ 5 peers.
 */
export const GATE_AS_OF = '2026-10-26';
export const GATE_NOW = new Date('2026-10-26T06:00:00Z');
export const CLEAN: Record<string, string> = {
  EPS: '100', 'Pledged %': '0', 'Profit 5Y CAGR': '20', 'Sales 5Y CAGR': '15',
  'CFO 5Y': '90', 'PAT 5Y': '100', 'Promoter Chg 1Y': '0',
};

export async function seedGateStocks(
  db: Db, stocks: { id: string; composite: number; data?: Record<string, string> }[], peerData: Record<string, string> = {},
): Promise<void> {
  const peers = ['NSE:PEER1', 'NSE:PEER2', 'NSE:PEER3', 'NSE:PEER4'];
  const all = [...peers.map((id) => ({ id, composite: null as number | null, data: peerData })), ...stocks];
  const [u] = await db.query<{ id: number }>(
    `insert into screener_uploads (as_of, filename, source) values ('2026-10-20', 'gate', 'screener-screen') returning id`);
  for (const [n, s] of all.entries()) {
    await db.query(`insert into instruments (id, kind, name, currency, sector, isin) values ($1, 'EQUITY', $2, 'INR', 'Chemicals', $3)`,
      [s.id, `${s.id.slice(4)} Ltd`, `INE${String(n).padStart(7, '0')}01`]);
    await db.query(`insert into prices_eod (instrument_id, trade_date, close_paise, source, as_of) values ($1, '2026-10-23', 200000, 'nse-bhavcopy', now())`, [s.id]);
    await db.query(`insert into fundamentals (upload_id, instrument_id, data, de_ratio) values ($1, $2, $3, 0.1)`,
      [u!.id, s.id, JSON.stringify({ ...CLEAN, ...s.data })]);
    if (s.composite !== null) {
      await db.query(`insert into signal_scores (instrument_id, score_date, composite, quality_passed) values ($1, '2026-10-25', $2, true)`,
        [s.id, s.composite]);
    }
  }
}

/** A successful three-year governance backfill with nothing found, completed at `now`. */
export async function clearGovernance(db: Db, id: string, now: Date): Promise<void> {
  await db.query(
    `insert into news_fetch_runs (instrument_id, scope_key, window_from, window_to, state, seen, stored, started_at, completed_at, as_of)
     values ($1, 'x', ($2::timestamptz - interval '3 years')::date, $2::date, 'success_empty', 0, 0, $2, $2, $2)`,
    [id, now.toISOString()]);
}
