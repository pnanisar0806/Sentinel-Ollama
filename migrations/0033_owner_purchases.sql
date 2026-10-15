-- Purchases the owner made outside Sentinel, logged on /log (SIP gaps Task 2). Each one
-- counts against the IST month of `bought_on`: what remains to invest is the free envelope
-- less this month's Sentinel BUY orders and these rows. A Sentinel-proposed order is never
-- logged here; it lives in order_intents and counts from there, once.

create table owner_purchases (
  id bigserial primary key,
  bought_on date not null,
  instrument_id text,            -- optional link; null when the owner names a fund that is not an instrument
  description text not null,     -- what the owner typed, e.g. "Zerodha Gold ETF"
  amount_paise bigint not null check (amount_paise > 0),
  units numeric check (units is null or units > 0),
  note text not null default '',
  as_of timestamptz not null,
  source text not null default 'owner-web'
);
create index owner_purchases_bought_on_idx on owner_purchases (bought_on);

do $$
declare t text;
begin
  foreach t in array array['owner_purchases'] loop
    execute format('create trigger %I before update or delete on %I for each statement execute function sentinel_append_only()', t || '_append_only', t);
    execute format('create trigger %I before truncate on %I for each statement execute function sentinel_append_only()', t || '_truncate_only', t);
    execute format('alter table %I enable row level security', t);
    execute format('create policy %I on %I using (true) with check (true)', t || '_owner', t);
  end loop;
end $$;
