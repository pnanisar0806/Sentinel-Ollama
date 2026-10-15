-- Live MF SIPs from INDmoney `mf_sips` (spec 2026-10-14 §1.3).
--
-- One sip_snapshots row per successful fetch; its sips rows are the ACTIVE SIPs at that
-- moment. The latest snapshot is the current set. sip_count = 0 is INDmoney saying "no
-- active SIPs" — a real answer — while NO snapshot means unknown. A SIP present in one
-- snapshot and absent from the next stopped between them; nothing is ever updated.

create table sip_snapshots (
  id          bigserial primary key,
  as_of       timestamptz not null,
  source      text not null default 'indmoney',
  sip_count   integer not null check (sip_count >= 0),
  created_at  timestamptz not null default now()
);
create index sip_snapshots_as_of_idx on sip_snapshots (as_of desc, id desc);

create table sips (
  id                bigserial primary key,
  snapshot_id       bigint not null references sip_snapshots(id),
  sip_id            text not null,
  -- 'IND:' || fund_id, the same id holdings use. Not a foreign key: a newly registered
  -- SIP's fund may not be an instrument yet (Invesco Midcap, 2026-10-13).
  instrument_id     text not null,
  isin              text,
  fund_name         text not null,
  fund_type         text,
  category          text,
  frequency         text not null,
  amount_paise      bigint not null check (amount_paise > 0),
  -- Exactly what INDmoney said. It carries no unit: 1000 meant Rs 1,000, 10 means 10%.
  step_up_raw       numeric,
  step_up_kind      text check (step_up_kind in ('percent', 'rupees', 'unknown')),
  step_up_inferred  boolean not null default false,
  step_up_freq      text,
  start_date        date not null,
  as_of             timestamptz not null,
  source            text not null default 'indmoney',
  unique (snapshot_id, sip_id)
);

do $$
declare t text;
begin
  foreach t in array array['sip_snapshots', 'sips'] loop
    execute format('create trigger %I before update or delete on %I for each statement execute function sentinel_append_only()', t || '_append_only', t);
    execute format('create trigger %I before truncate on %I for each statement execute function sentinel_append_only()', t || '_truncate_only', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I using (true) with check (true)', t || '_owner', t);
  end loop;
end $$;
