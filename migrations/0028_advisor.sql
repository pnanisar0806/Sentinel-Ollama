-- Phase 2.5 Task 1: the advisor's own evidence (docs/superpowers/plans/2026-09-17-sentinel-phase-2.5.md).
--
-- The LLM advisor writes ONLY these tables. It never writes recommendations or orders:
-- a signed proposal is handed to the existing gate-aware platform code outside
-- src/advisor/ (tests/advisor/firewall.test.ts). Every table is append-only; a proposal's
-- status is derived from decision rows, never updated in place.

create table advisor_proposals (
  id              bigserial primary key,
  kind            text not null check (kind in ('ADVISE','WATCHLIST_REVISION','COMMENTARY','RATING_REVIEW')),
  -- What the advisor proposed, validated against its schema before it is stored.
  payload         jsonb not null,
  -- Exactly what it was shown, so the decision can be replayed as a recorded artifact.
  input_snapshot  jsonb not null,
  evidence_ids    text[] not null default '{}',
  model           text,           -- NULL for a deterministic no-action (no LLM call made)
  request_id      text,
  prompt_version  text not null,
  schema_version  text not null,
  as_of           timestamptz not null,
  source          text not null default 'advisor',
  created_at      timestamptz not null default now()
);
create index advisor_proposals_kind_idx on advisor_proposals (kind, created_at desc);

create table advisor_decisions (
  id              bigserial primary key,
  proposal_id     bigint not null references advisor_proposals(id),
  decision        text not null check (decision in ('SIGNED','DISMISSED')),
  actor           text not null default 'owner' check (actor = 'owner'),
  note            text not null default '',
  at              timestamptz not null default now()
);
create unique index advisor_decisions_once on advisor_decisions (proposal_id);

create table replay_runs (
  id              bigserial primary key,
  dataset_hash    text not null,
  code_hash       text not null,
  config_hash     text not null,
  window_from     date not null,
  window_to       date not null,
  coverage        jsonb not null,
  result          jsonb not null,
  as_of           timestamptz not null,
  source          text not null default 'replay',
  created_at      timestamptz not null default now()
);

-- Every LLM call, successful or not. Usage the provider does not report is NULL, never 0.
create table llm_calls (
  id                bigserial primary key,
  seam              text not null,  -- 'advise' | 'sentiment' | 'commentary' | 'watchlist' | ...
  model             text not null,
  latency_ms        integer,
  outcome           text not null check (outcome in ('ok','unavailable','invalid','error')),
  prompt_tokens     integer,
  completion_tokens integer,
  error             text,
  as_of             timestamptz not null default now(),
  source            text not null default 'openrouter'
);

do $$
declare t text;
begin
  foreach t in array array['advisor_proposals','advisor_decisions','replay_runs','llm_calls'] loop
    execute format('create trigger %I before update or delete on %I for each statement execute function sentinel_append_only()', t || '_append_only', t);
    execute format('create trigger %I before truncate on %I for each statement execute function sentinel_append_only()', t || '_truncate_only', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I using (true) with check (true)', t || '_owner', t);
  end loop;
end $$;
