-- Batch C (spec 2026-10-31): owner holding rules, their allow-once exceptions, and life events.
-- No owner data is seeded. Ending any of them early is a log_reversals row, never an edit.

-- A rule the owner puts on one holding. HOLD_UNTIL needs its date; only CAP_PCT carries a cap (bps).
create table holding_rules (
  id uuid primary key default gen_random_uuid(),
  instrument_id text not null references instruments(id),
  kind text not null check (kind in ('NO_ADD','HOLD_UNTIL','NO_REBUY','CAP_PCT')),
  until_on date,
  cap_bps int check (cap_bps between 1 and 10000),
  note text,
  occurred_on date not null,
  as_of timestamptz not null,
  source text not null check (source <> ''),
  check (kind <> 'HOLD_UNTIL' or until_on is not null),
  check ((kind = 'CAP_PCT') = (cap_bps is not null))
);

-- Allow a rule to be broken once: for one month, or for one lump sum — exactly one of the two.
create table holding_rule_exceptions (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references holding_rules(id),
  month text check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  lump_sum_id uuid references lump_sums(id),
  note text not null check (length(trim(note)) between 1 and 500),
  as_of timestamptz not null,
  source text not null check (source <> ''),
  check ((month is not null) <> (lump_sum_id is not null))
);

-- Something that changed in the owner's life. ENDED closes an earlier event and must name it.
create table life_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('SALARY_CHANGE','JOB_LOSS','NEW_DEPENDENT','WINDFALL','RETIREMENT_AGE','MEDICAL_EXPENSE','ENDED')),
  occurred_on date not null,
  amount_paise bigint check (amount_paise > 0),
  detail jsonb not null default '{}',
  ends_event_id uuid references life_events(id),
  note text,
  as_of timestamptz not null,
  source text not null check (source <> ''),
  check ((kind = 'ENDED') = (ends_event_id is not null))
);

-- The owner's answer to one review item an event raised. NEEDS_CHANGE says what to change to.
create table life_event_reviews (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references life_events(id),
  item_key text not null,
  outcome text not null check (outcome in ('STILL_RIGHT','SIGNED','NEEDS_CHANGE')),
  new_value_text text,
  as_of timestamptz not null,
  source text not null check (source <> ''),
  check (outcome <> 'NEEDS_CHANGE' or new_value_text is not null)
);

-- Rules, exceptions and events are reversed as single-row entries keyed on their table id (src/domain/reversals.ts).
alter table log_reversals drop constraint log_reversals_entity_check;
alter table log_reversals add constraint log_reversals_entity_check
  check (entity in ('bucket_flow','owner_purchase','owner_sip_payment','owner_sale','earmark','spend','sip_move','lump_sum',
                    'holding_rule','holding_rule_exception','life_event'));

create trigger holding_rules_append_only before update or delete on holding_rules
  for each statement execute function sentinel_append_only();
create trigger holding_rules_truncate_only before truncate on holding_rules
  for each statement execute function sentinel_append_only();
create trigger holding_rule_exceptions_append_only before update or delete on holding_rule_exceptions
  for each statement execute function sentinel_append_only();
create trigger holding_rule_exceptions_truncate_only before truncate on holding_rule_exceptions
  for each statement execute function sentinel_append_only();
create trigger life_events_append_only before update or delete on life_events
  for each statement execute function sentinel_append_only();
create trigger life_events_truncate_only before truncate on life_events
  for each statement execute function sentinel_append_only();
create trigger life_event_reviews_append_only before update or delete on life_event_reviews
  for each statement execute function sentinel_append_only();
create trigger life_event_reviews_truncate_only before truncate on life_event_reviews
  for each statement execute function sentinel_append_only();

-- RLS on with NO policy: anon/authenticated get nothing; the owner connection bypasses RLS.
alter table holding_rules enable row level security;
alter table holding_rule_exceptions enable row level security;
alter table life_events enable row level security;
alter table life_event_reviews enable row level security;
