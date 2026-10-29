-- Fund switch (spec 2026-10-29 §3): the owner logs a SIP moved from one fund to another in
-- the same category. No owner data is seeded. One active (not reversed) move per "from"
-- fund is a domain check (src/domain/owner-log.ts), so a reversed move can be logged again.
create table sip_moves (
  id bigserial primary key,
  from_instrument_id text not null,
  to_instrument_id text not null check (to_instrument_id <> from_instrument_id),
  amount_paise bigint not null check (amount_paise > 0),
  first_month text not null check (first_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  note text not null default '',
  occurred_on date not null,
  as_of timestamptz not null,
  source text not null check (source <> '')
);

-- A move is reversed like any single-row entry, keyed on sip_moves.id (src/domain/reversals.ts).
alter table log_reversals drop constraint log_reversals_entity_check;
alter table log_reversals add constraint log_reversals_entity_check
  check (entity in ('bucket_flow','owner_purchase','owner_sip_payment','owner_sale','earmark','spend','sip_move'));

create trigger sip_moves_append_only before update or delete on sip_moves
  for each statement execute function sentinel_append_only();
create trigger sip_moves_truncate_only before truncate on sip_moves
  for each statement execute function sentinel_append_only();
-- RLS on with NO policy: anon/authenticated get nothing; the owner connection bypasses RLS.
alter table sip_moves enable row level security;
