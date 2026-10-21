/**
 * Owner-stated SIP instalments the INDmoney feed cannot see (R1, 2026-10-16: HDFC Mid Cap
 * ₹3,001 debited 12 Oct 2026 and stopped before SIP tracking began 14 Oct). One row per fund
 * per IST month, append-only. `loadSipCommitment` counts each only in its own month and only
 * for what the feed does not already carry for that fund — never on top of it. The readers
 * (`loadOwnerSipPayments`, `sipInstrumentKey`) live in sips.ts; this module only writes.
 */
import type { Db } from '../db/client.js';
import { istDate, loadOwnerSipPayments, sipInstrumentKey } from './sips.js';

type PaymentInput = { instrumentId: string; paidOn: string; amountPaise: bigint; note?: string; source: string };

export async function recordSipPayment(db: Db, input: PaymentInput, now = new Date().toISOString()): Promise<void> {
  const { instrumentId, paidOn, amountPaise, source } = input;
  const note = (input.note ?? '').trim();
  if (typeof instrumentId !== 'string' || !instrumentId.trim()) throw new Error('a mutual fund is required');
  if (typeof amountPaise !== 'bigint' || amountPaise <= 0n || amountPaise > 9_223_372_036_854_775_807n) throw new Error('the amount must be positive whole paise within the storage limit');
  if (typeof paidOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || new Date(`${paidOn}T00:00:00Z`).toISOString().slice(0, 10) !== paidOn) throw new Error('a valid calendar date is required');
  if (!Number.isFinite(Date.parse(now))) throw new Error('a valid as_of timestamp is required');
  if (paidOn > istDate(now)) throw new Error('a paid instalment cannot be in the future');
  if (typeof source !== 'string' || !source.trim()) throw new Error('a source is required');
  if (note.length > 1000) throw new Error('note must be text up to 1,000 characters');
  await db.withTransaction(async (tx) => {
    if (!(await tx.query(`select id from instruments where id=$1 and kind='MF'`, [instrumentId])).length) throw new Error('select an existing mutual fund');
    // unique (instrument_id, month) cannot see an alias; check by key, holding the key row's lock.
    const key = await sipInstrumentKey(tx, instrumentId);
    await tx.query(`select id from instruments where id=$1 for update`, [key]);
    for (const p of await loadOwnerSipPayments(tx, `${paidOn}T12:00:00+05:30`)) {
      if (await sipInstrumentKey(tx, p.instrumentId) === key) throw new Error('a SIP payment is already recorded for this fund this month');
    }
    const [row] = await tx.query<{ id: string }>(
      `insert into owner_sip_payments (instrument_id,paid_on,month,amount_paise,note,as_of,source)
       values ($1,$2,$3,$4,$5,$6,$7) returning id::text`,
      [instrumentId, paidOn, paidOn.slice(0, 7), amountPaise.toString(), note, now, source.trim()]);
    await tx.query(`insert into audit_log (entity,entity_id,action,actor,payload) values ('owner_sip_payment',$1,'RECORDED','owner',$2::jsonb)`,
      [row!.id, JSON.stringify({ instrumentId, paidOn, amountPaise: amountPaise.toString(), note, asOf: now, source: source.trim() })]);
  });
}
