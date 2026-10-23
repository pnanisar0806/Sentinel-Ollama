-- /log batch A (spec 2026-10-22): sales, spends, earmarks and reversals. No owner data is seeded.

-- Planned spending: bank cash set aside for a known expense. Not a goal card, no target;
-- held back from investable cash and subtracted from the FI corpus like B2-B4 (spec §7.1).
alter table buckets drop constraint buckets_id_check;
alter table buckets add constraint buckets_id_check check (id in ('B1','B2','B3','B4','SP'));
insert into buckets (id, name, mandate, target_paise, target_note)
  values ('SP', 'Planned spending', 'Cash set aside for a known expense; not invested', null, '')
  on conflict do nothing;

-- SP pots are per label ("Himachal trip"). Adding a column is DDL; the append-only
-- triggers fire on UPDATE/DELETE/TRUNCATE only. No existing row is SP (SP is new here).
alter table bucket_flows add column label text;
alter table bucket_flows add constraint bucket_flows_sp_label_check check (bucket_id <> 'SP' or label is not null);
-- And only SP rows carry one, so a labelled flow is always an SP pot's (src/domain/reversals.ts).
alter table bucket_flows add constraint bucket_flows_label_sp_only_check check (bucket_id = 'SP' or label is null);

create table owner_sales (
  id bigserial primary key,
  sold_on date not null,
  instrument_id text not null references instruments(id),
  units numeric(20,6) check (units is null or units > 0),   -- same scale as holdings.quantity (src/domain/owner-sales.ts)
  proceeds_paise bigint not null check (proceeds_paise > 0),
  destination text references buckets(id),
  note text not null default '',
  as_of timestamptz not null,
  source text not null check (source <> '')
);

-- A reversal is a new row; the original stays. Single rows key on their table id; the
-- groups (earmark, spend, owner_sale) key on their audit_log id (src/domain/reversals.ts).
create table log_reversals (
  id bigserial primary key,
  entity text not null check (entity in ('bucket_flow','owner_purchase','owner_sip_payment','owner_sale','earmark','spend')),
  entity_id text not null,
  reason text not null check (length(reason) between 1 and 500),
  as_of timestamptz not null,
  source text not null check (source <> ''),
  unique (entity, entity_id)
);

-- One non-reversed payment per fund-month is now a domain check, so a reversed payment
-- can be logged again (spec §7.5).
alter table owner_sip_payments drop constraint owner_sip_payments_instrument_id_month_key;

create trigger owner_sales_append_only before update or delete on owner_sales
  for each statement execute function sentinel_append_only();
create trigger owner_sales_truncate_only before truncate on owner_sales
  for each statement execute function sentinel_append_only();
create trigger log_reversals_append_only before update or delete on log_reversals
  for each statement execute function sentinel_append_only();
create trigger log_reversals_truncate_only before truncate on log_reversals
  for each statement execute function sentinel_append_only();
-- RLS on with NO policy: anon/authenticated get nothing; the owner connection bypasses RLS.
alter table owner_sales enable row level security;
alter table log_reversals enable row level security;
