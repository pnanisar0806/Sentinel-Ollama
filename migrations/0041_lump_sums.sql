-- Lump sum received (batch B spec §3): money the owner wants invested on top of the month,
-- e.g. bond interest. No owner data is seeded. A purchase or a recommendation linked to an open
-- (not reversed) lump sum counts against it, not against its month (src/domain/sips.ts loadMonthSpend).
create table lump_sums (
  id uuid primary key default gen_random_uuid(),
  received_on date not null,
  amount_paise bigint not null check (amount_paise > 0),
  from_text text not null check (length(trim(from_text)) between 1 and 200),
  note text,
  as_of timestamptz not null,
  source text not null check (source <> '')
);

alter table owner_purchases add column lump_sum_id uuid references lump_sums(id);
alter table recommendations add column lump_sum_id uuid references lump_sums(id);

-- A lump sum is reversed like any single-row entry, keyed on lump_sums.id (src/domain/reversals.ts).
alter table log_reversals drop constraint log_reversals_entity_check;
alter table log_reversals add constraint log_reversals_entity_check
  check (entity in ('bucket_flow','owner_purchase','owner_sip_payment','owner_sale','earmark','spend','sip_move','lump_sum'));

-- The lump-sum advice (batch B Task 2) is stored as its own proposal kind. Name: 0028's inline check.
alter table advisor_proposals drop constraint advisor_proposals_kind_check;
alter table advisor_proposals add constraint advisor_proposals_kind_check
  check (kind in ('ADVISE','WATCHLIST_REVISION','COMMENTARY','RATING_REVIEW','LUMP_SUM'));

create trigger lump_sums_append_only before update or delete on lump_sums
  for each statement execute function sentinel_append_only();
create trigger lump_sums_truncate_only before truncate on lump_sums
  for each statement execute function sentinel_append_only();
-- RLS on with NO policy: anon/authenticated get nothing; the owner connection bypasses RLS.
alter table lump_sums enable row level security;
