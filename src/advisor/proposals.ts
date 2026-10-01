import type { Db } from '../db/client.js';

/**
 * The advisor's evidence writer (Phase 2.5 Task 1). This module and the rest of
 * src/advisor/ may write only the advisor tables — tests/advisor/firewall.test.ts
 * enforces it. A proposal is never an order and never approval: turning a signed
 * proposal into a paper request happens outside src/advisor/, through the gate-aware
 * platform code.
 */

type ProposalKind = 'ADVISE' | 'WATCHLIST_REVISION' | 'COMMENTARY' | 'RATING_REVIEW';
type ProposalStatus = 'OPEN' | 'SIGNED' | 'DISMISSED';

interface NewProposal {
  kind: ProposalKind;
  payload: object;
  inputSnapshot: object;
  evidenceIds: string[];
  /** NULL when the proposal is a deterministic no-action and no model was called. */
  model: string | null;
  requestId?: string | null;
  promptVersion: string;
  schemaVersion: string;
  asOf: string;
}

export async function recordProposal(db: Db, p: NewProposal): Promise<number> {
  const [row] = await db.query<{ id: string }>(
    `insert into advisor_proposals
       (kind, payload, input_snapshot, evidence_ids, model, request_id, prompt_version, schema_version, as_of)
     values ($1, $2::jsonb, $3::jsonb, $4, $5, $6, $7, $8, $9) returning id`,
    [p.kind, JSON.stringify(p.payload), JSON.stringify(p.inputSnapshot), p.evidenceIds, p.model,
     p.requestId ?? null, p.promptVersion, p.schemaVersion, p.asOf],
  );
  return Number(row!.id);
}

/** The owner's sign-off or dismissal. Once per proposal; the proposal row is never edited. */
export async function decideProposal(db: Db, id: number, decision: 'SIGNED' | 'DISMISSED', note: string): Promise<void> {
  const [existing] = await db.query<{ decision: string }>(`select decision from advisor_decisions where proposal_id = $1`, [id]);
  if (existing) throw new Error(`proposal ${id} is already ${existing.decision.toLowerCase()}`);
  await db.withTransaction(async (tx) => {
    await tx.query(`insert into advisor_decisions (proposal_id, decision, note) values ($1, $2, $3)`, [id, decision, note]);
    await tx.query(
      `insert into audit_log (entity, entity_id, action, actor, payload) values ('advisor_proposal', $1, $2, 'owner', $3::jsonb)`,
      [String(id), decision, JSON.stringify({ note })],
    );
  });
}

export interface StoredProposal {
  id: number; kind: ProposalKind; payload: Record<string, unknown>; evidenceIds: string[];
  model: string | null; asOf: string; status: ProposalStatus; note: string | null;
}

export async function loadProposals(db: Db, kind?: ProposalKind, limit = 50): Promise<StoredProposal[]> {
  const rows = await db.query<{
    id: string; kind: ProposalKind; payload: unknown; evidence_ids: string[]; model: string | null;
    as_of: string | Date; decision: string | null; note: string | null;
  }>(
    `select p.id, p.kind, p.payload, p.evidence_ids, p.model, p.as_of, d.decision, d.note
       from advisor_proposals p left join advisor_decisions d on d.proposal_id = p.id
      where $1::text is null or p.kind = $1
      order by p.created_at desc, p.id desc limit $2`,
    [kind ?? null, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id), kind: r.kind,
    payload: (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload) as Record<string, unknown>,
    evidenceIds: r.evidence_ids ?? [], model: r.model, asOf: new Date(r.as_of).toISOString(),
    status: (r.decision ?? 'OPEN') as ProposalStatus, note: r.note,
  }));
}

interface LlmCall {
  seam: string; model: string; latencyMs: number | null;
  outcome: 'ok' | 'unavailable' | 'invalid' | 'error';
  /** NULL when the provider did not report it. Never invented as 0. */
  promptTokens: number | null; completionTokens: number | null; error: string | null;
}

export async function recordLlmCall(db: Db, c: LlmCall): Promise<void> {
  await db.query(
    `insert into llm_calls (seam, model, latency_ms, outcome, prompt_tokens, completion_tokens, error)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [c.seam, c.model, c.latencyMs, c.outcome, c.promptTokens, c.completionTokens, c.error],
  );
}
