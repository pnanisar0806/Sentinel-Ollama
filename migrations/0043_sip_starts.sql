-- Logged SIP starts (spec 2026-11-03): the owner starts a new SIP outside the feed.
-- Append-only + RLS, like sip_moves. Reversal entity 'sip_start'.
create table sip_starts (
  id bigserial primary key,
  instrument_id text not null references instruments(id),
  amount_paise bigint not null check (amount_paise > 0),
  first_month text not null check (first_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  note text not null default '',
  occurred_on date not null,
  as_of timestamptz not null,
  source text not null check (source <> '')
);

alter table log_reversals drop constraint log_reversals_entity_check;
alter table log_reversals add constraint log_reversals_entity_check
  check (entity in ('bucket_flow','owner_purchase','owner_sip_payment','owner_sale','earmark','spend','sip_move','sip_start','lump_sum','holding_rule','holding_rule_exception','life_event'));

create trigger sip_starts_append_only before update or delete on sip_starts
  for each statement execute function sentinel_append_only();
create trigger sip_starts_truncate_only before truncate on sip_starts
  for each statement execute function sentinel_append_only();
alter table sip_starts enable row level security;
