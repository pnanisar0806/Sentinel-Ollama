-- Phase 2.5 Task 2: material corporate events and the record of every fetch.
--
-- Owner policy 2026-09-27: a long-term investor acts only on MATERIAL corporate events
-- (results, rating actions, governance red flags, M&A, management change, capital
-- actions). Headlines and price stories are noise and are not stored. Source: BSE Reg 30
-- filings, per held/watched company.
--
-- Fetch attempts are recorded apart from events. A successful empty fetch means "no
-- material filing in that window", never a feed failure; a failed fetch never masquerades
-- as current coverage (src/sources/news.ts newsCoverage).

create table news_fetch_runs (
  id              bigserial primary key,
  instrument_id   text references instruments(id),
  scope_key       text,             -- BSE scrip; NULL when identity is unresolved
  window_from     date not null,
  window_to       date not null,
  state           text not null check (state in ('success_empty','success','failed','unresolved')),
  seen            integer,          -- filings returned, all categories
  stored          integer,          -- material events newly stored
  error           text,
  started_at      timestamptz not null,
  completed_at    timestamptz not null,
  as_of           timestamptz not null,
  source          text not null default 'bse'
);
create index news_fetch_runs_instrument_idx on news_fetch_runs (instrument_id, completed_at desc);

create table news_events (
  id              bigserial primary key,
  dedupe_key      text not null unique,          -- 'bse:<NEWSID>'
  instrument_id   text references instruments(id),
  scope           text not null check (scope in ('instrument','market','unresolved')),
  event_type      text not null check (event_type in
                    ('results','rating','governance','management','mna','corporate_action','business','unknown')),
  headline        text not null,
  snippet         text,
  url             text,
  raw_category    text,
  raw_subcategory text,
  critical        boolean not null default false,
  published_at    timestamptz not null,
  received_at     timestamptz not null,
  supersedes      bigint references news_events(id),
  as_of           timestamptz not null,
  source          text not null
);
create index news_events_instrument_idx on news_events (instrument_id, published_at desc);

do $$
declare t text;
begin
  foreach t in array array['news_fetch_runs','news_events'] loop
    execute format('create trigger %I before update or delete on %I for each statement execute function sentinel_append_only()', t || '_append_only', t);
    execute format('create trigger %I before truncate on %I for each statement execute function sentinel_append_only()', t || '_truncate_only', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I using (true) with check (true)', t || '_owner', t);
  end loop;
end $$;
