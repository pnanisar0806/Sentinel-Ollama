import type { Db } from '../../src/db/client.js';

/** One stored passkey. The public key and id are base64url, exactly as WebAuthn reports. */
export interface StoredPasskey {
  id: string;
  publicKey: string;
  counter: number;
  transports: string[];
  label: string;
}

export async function listPasskeys(db: Db): Promise<StoredPasskey[]> {
  const rows = await db.query<{
    id: string; public_key: string; counter: string | number; transports: unknown; label: string;
  }>(`select id, public_key, counter, transports, label from web_passkeys order by created_at`);
  return rows.map((r) => ({
    id: r.id,
    publicKey: r.public_key,
    counter: Number(r.counter),
    transports: (typeof r.transports === 'string' ? JSON.parse(r.transports) : r.transports) as string[],
    label: r.label,
  }));
}

export async function findPasskey(db: Db, id: string): Promise<StoredPasskey | null> {
  return (await listPasskeys(db)).find((p) => p.id === id) ?? null;
}

export async function savePasskey(db: Db, p: StoredPasskey): Promise<void> {
  await db.query(
    `insert into web_passkeys (id, public_key, counter, transports, label)
     values ($1, $2, $3, $4::jsonb, $5)`,
    [p.id, p.publicKey, p.counter, JSON.stringify(p.transports), p.label],
  );
}

/**
 * Records a successful login's signature counter.
 *
 * WebAuthn authenticators increment the counter on every use; a counter that goes
 * BACKWARDS means two devices hold the same private key — a cloned authenticator. The
 * library refuses that case before we get here, so this only ever moves forward.
 */
export async function touchPasskey(db: Db, id: string, counter: number): Promise<void> {
  await db.query(
    `update web_passkeys set counter = $2, last_used_at = now() where id = $1`,
    [id, counter],
  );
}

/** Login and registration go to the append-only audit log. */
export async function auditAuth(
  db: Db, action: 'PASSKEY_REGISTERED' | 'LOGIN' | 'LOGIN_FAILED' | 'LOGOUT', detail: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `insert into audit_log (entity, entity_id, action, actor, payload)
     values ('web_auth', $1, $2, 'owner', $3::jsonb)`,
    [String(detail['credentialId'] ?? 'owner'), action, JSON.stringify(detail)],
  );
}
