-- Open list #10/#29 (2026-11-12): the owner's payday entry. INDmoney refreshes the HDFC balance only
-- when the owner opens its app, so the balance #10 needs is entered by hand once a month, right after
-- the salary lands. Consecutive entries bound a cycle (src/domain/cashflow.ts). Only HDFC counts
-- (owner, 2026-11-12). No owner data is seeded.
--
-- sips_paise is the SIP commitment of the month the cycle ending here covers, frozen when the entry
-- is saved, because the feed only knows the current SIPs. NULL when it was not known then (stale or
-- missing SIP feed, or entered too long after the payday): the cycle then says its spend is unknown.
create table paydays (
  id            bigserial primary key,
  paid_on       date not null,
  account       text not null check (account <> ''),
  salary_paise  bigint not null check (salary_paise > 0),
  balance_paise bigint not null check (balance_paise >= 0),
  sips_paise    bigint check (sips_paise is null or sips_paise >= 0),
  sips_month    text check (sips_month is null or sips_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  note          text not null default '',
  as_of         timestamptz not null,
  source        text not null check (source <> '')
);
create index paydays_paid_on_idx on paydays (paid_on);

alter table log_reversals drop constraint log_reversals_entity_check;
alter table log_reversals add constraint log_reversals_entity_check
  check (entity in ('bucket_flow','owner_purchase','owner_sip_payment','owner_sale','earmark','spend','sip_move','sip_start','lump_sum','holding_rule','holding_rule_exception','life_event','payday'));

create trigger paydays_append_only before update or delete on paydays
  for each statement execute function sentinel_append_only();
create trigger paydays_truncate_only before truncate on paydays
  for each statement execute function sentinel_append_only();
-- RLS on with NO policy: anon/authenticated get nothing; the owner connection bypasses RLS.
alter table paydays enable row level security;
