-- Sentinel Phase 0 schema. Money: BIGINT paise (INR) or BIGINT cents (USD).
-- Every externally-sourced row carries as_of + source for the staleness engine.

create table instruments (
  id              text primary key,               -- e.g. 'NSE:TATASTEEL', 'MF:INF109K012K1', 'US:AAPL'
  kind            text not null check (kind in ('EQUITY','ETF','MF','BOND','CASH','EPF','RSU','GOLD','LOAN')),
  name            text not null,
  currency        text not null default 'INR' check (currency in ('INR','USD')),
  exchange        text,
  isin            text,
  sector          text,
  issuer          text,                            -- for §3.5 single-issuer cap across equity + credit
  is_watchlist    boolean not null default false,
  is_employer     boolean not null default false,  -- NOW: §3.5 10% cap
  metadata        jsonb not null default '{}'::jsonb
);

create table snapshots (
  id              uuid primary key default gen_random_uuid(),
  taken_at        timestamptz not null default now(),
  business_date   date not null,
  source          text not null,                   -- 'kite' | 'indmoney' | 'manual' | 'composite'
  payload         jsonb not null default '{}'::jsonb
);
create index snapshots_business_date_idx on snapshots (business_date desc);

create table holdings (
  id              uuid primary key default gen_random_uuid(),
  snapshot_id     uuid not null references snapshots(id),
  instrument_id   text not null references instruments(id),
  quantity        numeric(20,6) not null,
  avg_cost_paise  bigint,                          -- NULL = unknown (FR-02); never render as 0
  value_paise     bigint not null,
  account         text not null,                   -- 'zerodha' | 'indmoney' | 'fidelity' | 'epf' | 'bank'
  as_of           timestamptz not null,
  source          text not null
);
create index holdings_snapshot_idx on holdings (snapshot_id);

create table lots (
  id              uuid primary key default gen_random_uuid(),
  instrument_id   text not null references instruments(id),
  account         text not null,
  acquired_on     date not null,
  quantity        numeric(20,6) not null,
  cost_paise      bigint not null,
  closed_on       date,
  seeded          boolean not null default false,  -- historical lots seeded by owner
  as_of           timestamptz not null,
  source          text not null
);
create index lots_fifo_idx on lots (instrument_id, account, acquired_on);

create table buckets (
  id              text primary key check (id in ('B1','B2','B3','B4')),
  name            text not null,
  mandate         text not null,
  target_paise    bigint,
  target_note     text not null,
  active          boolean not null default true
);

create table bucket_flows (
  id              uuid primary key default gen_random_uuid(),
  bucket_id       text not null references buckets(id),
  occurred_on     date not null,
  amount_paise    bigint not null,                 -- signed
  kind            text not null,                   -- 'seed' | 'sip' | 'vest' | 'maturity' | 'withdrawal'
  note            text not null default '',
  as_of           timestamptz not null,
  source          text not null
);

create table milestones (
  id              text primary key check (id in ('M1','M2')),
  name            text not null,
  spec            text not null,
  rationale       text not null,
  completed_on    date,
  nag             boolean not null default true
);

create table rsu_grants (
  id              text primary key,
  granted_on      date not null,
  units           numeric(12,4) not null,
  vest_years      int not null default 4,
  cadence         text not null default 'QUARTERLY',
  scenario        text not null default 'ACTUAL' check (scenario in ('ACTUAL','REFRESHER')),
  note            text not null default ''
);

create table rsu_vests (
  id              uuid primary key default gen_random_uuid(),
  grant_id        text not null references rsu_grants(id),
  vest_on         date not null,
  units           numeric(12,4) not null,
  status          text not null default 'PROJECTED' check (status in ('PROJECTED','ACTUAL')),
  price_usd_cents bigint,
  usdinr_micros   bigint,
  gross_paise     bigint,
  net_paise       bigint,
  confirmed_on    date,
  as_of           timestamptz not null,
  source          text not null,
  -- The upsert in src/domain/rsu.ts is keyed on this pair, and FR-03 ("a projection never
  -- overwrites an owner-confirmed ACTUAL") is enforced by its ON CONFLICT ... WHERE clause.
  -- Without the constraint two runs could both insert and the pair would stop identifying a
  -- row at all.
  unique (grant_id, vest_on)
);
-- Kept: the unique constraint's index leads on grant_id, so it cannot serve a lookup or a
-- range scan on vest_on alone (the common "what vests this quarter" query).
create index rsu_vests_date_idx on rsu_vests (vest_on);

create table loans (
  id              text primary key,
  name            text not null,
  lender          text not null,
  principal_paise bigint not null,
  outstanding_paise bigint not null,
  annual_rate_bps int not null,                    -- 795 = 7.95%
  emi_paise       bigint not null,
  started_on      date not null,
  natural_end_on  date not null,
  cascade_order   int,                             -- 1 = closes first and redirects into order 2
  as_of           timestamptz not null,
  source          text not null
);

create table loan_schedule (
  id              uuid primary key default gen_random_uuid(),
  loan_id         text not null references loans(id),
  scenario        text not null check (scenario in ('NATURAL','CASCADE')),
  period_month    date not null,                   -- first of month
  opening_paise   bigint not null,
  payment_paise   bigint not null,
  interest_paise  bigint not null,
  principal_paise bigint not null,
  closing_paise   bigint not null
);
create index loan_schedule_idx on loan_schedule (loan_id, scenario, period_month);

create table ips_versions (
  version         int primary key,
  full_text       text not null,
  diff            text not null default '',
  effective_at    timestamptz not null,
  created_at      timestamptz not null default now()
);

create table fx_rates (
  pair            text not null,
  as_of           date not null,
  rate_micros     bigint not null,                 -- 95.3 -> 95300000
  source          text not null,
  primary key (pair, as_of)
);

create table incidents (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null,                   -- 'STALE_DATA' | 'SYNC_FAILURE' | 'CAP_BREACH'
  severity        text not null check (severity in ('INFO','WARN','BLOCK')),
  subject         text not null,
  detail          text not null,
  opened_at       timestamptz not null default now(),
  resolved_at     timestamptz
);
create index incidents_open_idx on incidents (resolved_at, opened_at desc);

create table settings_rails (
  key             text primary key,
  value           jsonb not null,
  updated_at      timestamptz not null default now(),
  pending_value   jsonb,
  pending_since   timestamptz                       -- 48h cooling-off (PRD §11)
);

create table audit_log (
  id              bigserial primary key,
  at              timestamptz not null default now(),
  entity          text not null,
  entity_id       text not null,
  action          text not null,
  actor           text not null check (actor in ('owner','agent','broker','system')),
  payload         jsonb not null default '{}'::jsonb
);
create index audit_log_entity_idx on audit_log (entity, entity_id, at desc);

-- Append-only enforcement (FR-07). RLS is added when Supabase is provisioned;
-- triggers protect local and remote identically.
create or replace function sentinel_append_only() returns trigger as $$
begin
  raise exception 'append-only table: % may not be % ed', tg_table_name, tg_op;
end;
$$ language plpgsql;

create trigger audit_log_append_only before update or delete on audit_log
  for each statement execute function sentinel_append_only();
create trigger audit_log_truncate_only before truncate on audit_log
  for each statement execute function sentinel_append_only();
create trigger snapshots_append_only before update or delete on snapshots
  for each statement execute function sentinel_append_only();
create trigger snapshots_truncate_only before truncate on snapshots
  for each statement execute function sentinel_append_only();
