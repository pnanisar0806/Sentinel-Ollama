-- Phase 2: Paper approval state machine (FR-20-25, §7)
-- Immutable order intents, revisions, and transition events with audit trail

create table order_intents (
  id                  uuid primary key default gen_random_uuid(),
  stable_tag          uuid not null default gen_random_uuid(),  -- FR-23: stable UUID idempotency tag
  created_at          timestamptz not null default now(),
  created_by          text not null check (created_by in ('advisor','owner')),
  recommendation_id   bigint not null references recommendations(id),
  intent              text not null,                            -- 'BUY' | 'SELL' | 'SWITCH' | 'HOLD'
  instrument_id       text not null references instruments(id),
  quantity            numeric(20,6) not null,                   -- from deterministic sizer only
  limit_price_paise   bigint,                                   -- NULL = market
  order_type          text not null default 'MARKET' check (order_type in ('MARKET','LIMIT')),
  defer_until         date,                                     -- FR-21: defer date
  alternate_instrument_id text references instruments(id),     -- FR-21: alternate substitution
  payload_snapshot    jsonb not null,                           -- full FR-11 rec + data timestamps
  status              text not null default 'DRAFT' check (status in ('DRAFT','PENDING_APPROVAL','APPROVED','MODIFIED','DEFERRED','REJECTED','EXPIRED','AWAITING_SESSION','EXECUTING','FILLED','PARTIALLY_FILLED','BROKER_REJECTED','CANCELLED','VERIFIED','ACKNOWLEDGED','AWAITING_MANUAL_EXECUTION','ABANDONED')),
  current_revision    int not null default 1,
  expires_at          timestamptz,                              -- market EOD / SIP-MF 7 days
  advisory_path       boolean not null default false,           -- advisory vs broker execution
  as_of               timestamptz not null default now(),
  source              text not null default 'advisor'
);

create index order_intents_stable_tag_idx on order_intents (stable_tag);
create index order_intents_recommendation_idx on order_intents (recommendation_id);
create index order_intents_status_idx on order_intents (status);
create index order_intents_expires_idx on order_intents (expires_at) where expires_at is not null;

create table order_revisions (
  id                  uuid primary key default gen_random_uuid(),
  order_intent_id     uuid not null references order_intents(id),
  revision_number     int not null,
  modified_at         timestamptz not null default now(),
  modified_by         text not null check (modified_by in ('owner','advisor')),
  prev_revision       int not null,
  quantity            numeric(20,6) not null,
  limit_price_paise   bigint,
  order_type          text not null check (order_type in ('MARKET','LIMIT')),
  defer_until         date,
  alternate_instrument_id text references instruments(id),
  payload_snapshot    jsonb not null,
  rails_validated     boolean not null default false,
  validation_detail   jsonb not null default '{}'::jsonb,
  unique (order_intent_id, revision_number)
);

create index order_revisions_intent_idx on order_revisions (order_intent_id);

create table order_transitions (
  id                  uuid primary key default gen_random_uuid(),
  order_intent_id     uuid not null references order_intents(id),
  revision_number     int not null,
  from_status         text not null,
  to_status           text not null,
  actor               text not null check (actor in ('owner','agent','broker','system')),
  at                  timestamptz not null default now(),
  payload_snapshot    jsonb not null,                           -- full state at transition
  expected_revision   int not null,                             -- FR-23: concurrency protection
  idempotency_key     text,                                     -- FR-23: stable tag for callback dedup
  check (from_status <> to_status)
);

create index order_transitions_intent_idx on order_transitions (order_intent_id);
create index order_transitions_idempotency_idx on order_transitions (idempotency_key) where idempotency_key is not null;
create unique index order_transitions_unique ON order_transitions (order_intent_id, revision_number, from_status, to_status, actor, at)
  where idempotency_key is not null;

create table order_simulations (
  id                  uuid primary key default gen_random_uuid(),
  order_intent_id     uuid not null references order_intents(id),
  revision_number     int not null,
  sim_type            text not null check (sim_type in ('SESSION_MISSING','PARTIAL_FILL','BROKER_REJECT','MARKET_CLOSURE','ADVISORY_ACK','ADVISORY_VERIFY','T2_REMINDER','T7_REMINDER')),
  simulated_at        timestamptz not null default now(),
  input_state         jsonb not null,
  outcome_state       jsonb not null,
  note                text not null default ''
);

create index order_simulations_intent_idx on order_simulations (order_intent_id);

-- Append-only enforcement (FR-07)
create trigger order_intents_append_only before update or delete on order_intents
  for each statement execute function sentinel_append_only();
create trigger order_intents_truncate_only before truncate on order_intents
  for each statement execute function sentinel_append_only();

create trigger order_revisions_append_only before update or delete on order_revisions
  for each statement execute function sentinel_append_only();
create trigger order_revisions_truncate_only before truncate on order_revisions
  for each statement execute function sentinel_append_only();

create trigger order_transitions_append_only before update or delete on order_transitions
  for each statement execute function sentinel_append_only();
create trigger order_transitions_truncate_only before truncate on order_transitions
  for each statement execute function sentinel_append_only();

create trigger order_simulations_append_only before update or delete on order_simulations
  for each statement execute function sentinel_append_only();
create trigger order_simulations_truncate_only before truncate on order_simulations
  for each statement execute function sentinel_append_only();

-- RLS
alter table order_intents enable row level security;
alter table order_revisions enable row level security;
alter table order_transitions enable row level security;
alter table order_simulations enable row level security;