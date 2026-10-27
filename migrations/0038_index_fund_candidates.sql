-- Funds first (spec §8.1, Decision 11): the candidates for the new US and Nifty Next 50 index
-- fund, read daily from INDmoney's category listings. One row per fund per day, append-only.
create table index_fund_candidates (
  id bigserial primary key,
  fund_type text not null check (fund_type in ('US','NEXT50')),
  indmoney_fund_id text not null,
  name text not null,
  benchmark_name text,
  amfi_scheme_code text,            -- null = plan not verified as Direct Growth
  expense_ratio_bps integer,
  aum_paise bigint,
  tracking_error_bps integer,       -- null when no source carries it (none did on 2026-10-26)
  sip_allowed boolean,              -- null = source silent
  as_of date not null,
  source text not null check (source <> ''),
  unique (indmoney_fund_id, as_of)
);

create trigger index_fund_candidates_append_only before update or delete on index_fund_candidates
  for each statement execute function sentinel_append_only();
create trigger index_fund_candidates_truncate_only before truncate on index_fund_candidates
  for each statement execute function sentinel_append_only();
-- RLS on with NO policy: anon/authenticated get nothing; the owner connection bypasses RLS.
alter table index_fund_candidates enable row level security;
