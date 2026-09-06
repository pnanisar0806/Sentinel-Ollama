-- Web import queue: one row per statement uploaded through the local web app.
-- The owner uploads a brokerage/Kite or Fidelity RSU statement, it is archived under
-- data/screenshots and (when LLM_API_KEY is set) extracted into LLM proposals; a
-- row stays 'proposed' until the OWNER confirms or rejects it from the /import page.
-- The same FR-02 discipline as Telegram ingestion: nothing writes until the owner
-- approves, and confirmation writes the real lots/vests through the shared platform
-- functions (insertOwnerCostLot / persistVests + confirmVest), never web-local SQL.
create table if not exists web_uploads (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('brokerage', 'fidelity')),
  file_name text not null,
  stored_path text not null,
  page_count integer not null default 1,
  status text not null default 'proposed'
    check (status in ('proposed', 'confirmed', 'rejected', 'unusable')),
  -- Resolved proposals (cost or vest) awaiting the owner's word. Money is stored as
  -- strings (bigint never survives JSON), matching the audit_log convention.
  proposals jsonb,
  summary text,
  error text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists web_uploads_created_idx on web_uploads (created_at desc);

-- The queue is a durable record of what the owner was shown: a row may only move
-- through (status, summary, resolved_at). The filed statement itself is an event,
-- not an editable document.
create or replace function sentinel_web_uploads_immutable() returns trigger as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'web_uploads is immutable: rows may not be % ed', tg_op;
  end if;
  if new.kind        is distinct from old.kind
  or new.file_name   is distinct from old.file_name
  or new.stored_path is distinct from old.stored_path
  or new.page_count  is distinct from old.page_count
  or new.proposals   is distinct from old.proposals
  or new.error       is distinct from old.error
  or new.created_at  is distinct from old.created_at then
    raise exception 'web_uploads is immutable: only status/summary/resolved_at may be updated';
  end if;
  return new;
end;
$$ language plpgsql;

-- Trigger guards are wrapped in DO blocks so the file re-runs safely (the web server
-- self-applies this migration on first use, and the CLI applies it again via
-- schema_migrations bookkeeping). Same effect as `create trigger` on first run.
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'web_uploads_immutable_update') then
    create trigger web_uploads_immutable_update before update on web_uploads
      for each row execute function sentinel_web_uploads_immutable();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'web_uploads_immutable_delete') then
    create trigger web_uploads_immutable_delete before delete on web_uploads
      for each statement execute function sentinel_append_only();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'web_uploads_truncate_only') then
    create trigger web_uploads_truncate_only before truncate on web_uploads
      for each statement execute function sentinel_append_only();
  end if;
end $$;

alter table web_uploads enable row level security;