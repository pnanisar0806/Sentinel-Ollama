-- Phase 1: Intel tables (watchlist, screener, fundamentals, signals, recommendations)

create table watchlist (
  instrument_id   text not null references instruments(id),
  added_on        date not null,
  removed_on      date,
  source          text not null,
  reason          text not null,
  primary key (instrument_id, added_on),
  check (removed_on is null or removed_on >= added_on)
);
create index watchlist_instrument_idx on watchlist (instrument_id);

create table screener_uploads (
  id              bigserial primary key,
  uploaded_on     timestamptz not null default now(),
  as_of           date not null,
  filename        text,
  source          text not null check (source = 'screener-in'),
  unique (as_of, filename)
);

create table fundamentals (
  upload_id       bigint not null references screener_uploads(id),
  instrument_id   text not null references instruments(id),
  data            text not null,
  roce_pct        numeric,
  de_ratio        numeric,
  fcf_pos_5y      boolean,
  red_flags       int,
  primary key (upload_id, instrument_id)
);
create index fundamentals_instrument_idx on fundamentals (instrument_id);

create table signal_scores (
  instrument_id   text not null references instruments(id),
  score_date      date not null,
  composite       numeric(5,2) not null,
  quality_passed  boolean not null,
  reg_valuation   numeric(5,2),
  reg_trend       numeric(5,2),
  reg_earnings    numeric(5,2),
  reg_fit         numeric(5,2),
  rank            int,
  primary key (instrument_id, score_date)
);
create index signal_scores_date_idx on signal_scores (score_date);

create table recommendations (
  id              bigserial primary key,
  created_on      date not null,
  kind            text not null check (kind in ('satellite','mf_switch','rebalance','sell','prepay','maturity_routing','legacy_note')),
  intent          text not null,
  primary_rec     text not null,
  alternates      text not null,
  ips_clause_refs text not null,
  engine_evidence text not null,
  benchmark_as_of date,
  benchmark_jsonb text,
  source          text not null default 'advisor',
  suppressed      boolean not null default false,
  suppressed_reason text,
  created_at      timestamptz not null default now()
);
create index recommendations_created_idx on recommendations (created_on);

create table suppressed_actions (
  logged_on       date not null,
  action          text not null,
  reason          text not null,
  suppressed_by   text not null,
  primary key (logged_on, action)
);

create table benchmarks (
  id              bigserial primary key,
  recommendation_id bigint not null references recommendations(id),
  benchmark_as_of date not null,
  benchmark_jsonb text not null,
  eval_3m_as_of   date,
  eval_3m_jsonb   text,
  eval_6m_as_of   date,
  eval_6m_jsonb   text,
  eval_12m_as_of  date,
  eval_12m_jsonb  text,
  unique (recommendation_id, benchmark_as_of)
);

-- Append-only triggers (Phase 0 style)
create trigger watchlist_append_only before update or delete on watchlist
  for each statement execute function sentinel_append_only();
create trigger watchlist_truncate_only before truncate on watchlist
  for each statement execute function sentinel_append_only();

create trigger fundamentals_append_only before update or delete on fundamentals
  for each statement execute function sentinel_append_only();
create trigger fundamentals_truncate_only before truncate on fundamentals
  for each statement execute function sentinel_append_only();

create trigger signal_scores_append_only before update or delete on signal_scores
  for each statement execute function sentinel_append_only();
create trigger signal_scores_truncate_only before truncate on signal_scores
  for each statement execute function sentinel_append_only();

create trigger recommendations_append_only before update or delete on recommendations
  for each statement execute function sentinel_append_only();
create trigger recommendations_truncate_only before truncate on recommendations
  for each statement execute function sentinel_append_only();

create trigger suppressed_actions_append_only before update or delete on suppressed_actions
  for each statement execute function sentinel_append_only();
create trigger suppressed_actions_truncate_only before truncate on suppressed_actions
  for each statement execute function sentinel_append_only();

create trigger benchmarks_append_only before update or delete on benchmarks
  for each statement execute function sentinel_append_only();
create trigger benchmarks_truncate_only before truncate on benchmarks
  for each statement execute function sentinel_append_only();

-- screener_uploads may be inserted/deleted by migration hygiene only
create trigger screener_uploads_append_only before update or delete on screener_uploads
  for each statement execute function sentinel_append_only();
create trigger screener_uploads_truncate_only before truncate on screener_uploads
  for each statement execute function sentinel_append_only();

-- RLS
alter table watchlist enable row level security;
alter table screener_uploads enable row level security;
alter table fundamentals enable row level security;
alter table signal_scores enable row level security;
alter table recommendations enable row level security;
alter table suppressed_actions enable row level security;
alter table benchmarks enable row level security;