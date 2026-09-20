-- Which shares belong to which smallcase.
--
-- `holdings` already carries the truth per instrument, live from INDmoney — 29 Indian
-- lines with real units. What it cannot express is that 2,616 GOLDBEES are 1,453 in
-- Equity & Gold and 1,163 in Timeless, so "exit Timeless" has no sizeable meaning
-- without this table. The relationship is many-to-many with quantities: an instrument
-- can sit in two smallcases at once, and a smallcase holds many instruments.
--
-- This supersedes the `NSE:SMALLCASE-RESIDUE` seed row, which modelled the whole thing
-- as one opaque ₹6,55,400 line and is already absent from every live snapshot.
--
-- `avg_buy_price_paise` is the smallcase app's own average for that constituent. It is
-- cost basis BY SOURCE, which `lots` does not carry: a holding split across a smallcase
-- and a direct purchase has two different average costs, and only this one is knowable
-- per smallcase.
create table smallcase_positions (
  id                   uuid primary key default gen_random_uuid(),
  smallcase            text not null,
  instrument_id        text not null references instruments(id),
  as_of                date not null,
  -- Fractional units are not possible in a smallcase, but the column matches `holdings`.
  units                numeric not null check (units >= 0),
  -- NULL when the app does not report an average. Never 0 — unknown cost is unknown.
  avg_buy_price_paise  bigint check (avg_buy_price_paise is null or avg_buy_price_paise > 0),
  source               text not null,
  unique (smallcase, instrument_id, as_of)
);
create index smallcase_positions_as_of_idx on smallcase_positions (as_of desc);
create index smallcase_positions_instrument_idx on smallcase_positions (instrument_id);

create trigger smallcase_positions_append_only before update or delete on smallcase_positions
  for each statement execute function sentinel_append_only();
create trigger smallcase_positions_truncate_only before truncate on smallcase_positions
  for each statement execute function sentinel_append_only();

alter table smallcase_positions enable row level security;
create policy smallcase_positions_owner on smallcase_positions
  using (true) with check (true);
