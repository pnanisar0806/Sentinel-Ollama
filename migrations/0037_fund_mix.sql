-- Funds first (spec §7, Decision 3): one row per owner signing of the proposed range table.
-- The latest row is in force; the owner signs the whole table as proposed, no edits.
create table fund_mix_signed (
  id bigserial primary key,
  horizon_years integer not null check (horizon_years >= 0),
  horizon_band text not null check (horizon_band in ('15+','7-15')),
  ranges jsonb not null,            -- RangeRow[] exactly as proposed (src/domain/fund-mix.ts)
  as_of timestamptz not null,
  source text not null check (source = 'owner-signed')
);

create trigger fund_mix_signed_append_only before update or delete on fund_mix_signed
  for each statement execute function sentinel_append_only();
create trigger fund_mix_signed_truncate_only before truncate on fund_mix_signed
  for each statement execute function sentinel_append_only();
-- RLS on with NO policy: anon/authenticated get nothing; the owner connection bypasses RLS.
alter table fund_mix_signed enable row level security;
