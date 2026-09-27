-- Phase 2.5 Task 9: removing a name from the watchlist without editing history.
--
-- `watchlist` is append-only (UPDATE/DELETE/TRUNCATE refused), so a later removal cannot
-- set `removed_on` on the row that added the name. A removal is its own event here, and
-- `watchlist_effective` is what every reader uses: a row's effective `removed_on` is its
-- own, or the first removal event on or after it was added. Protection stays on.

create table watchlist_removals (
  id              bigserial primary key,
  instrument_id   text not null references instruments(id),
  removed_on      date not null,
  reason          text not null,
  source          text not null,
  as_of           timestamptz not null default now()
);
create index watchlist_removals_instrument_idx on watchlist_removals (instrument_id, removed_on);

create trigger watchlist_removals_append_only before update or delete on watchlist_removals
  for each statement execute function sentinel_append_only();
create trigger watchlist_removals_truncate_only before truncate on watchlist_removals
  for each statement execute function sentinel_append_only();
alter table watchlist_removals enable row level security;
create policy watchlist_removals_owner on watchlist_removals using (true) with check (true);

create view watchlist_effective as
  select w.instrument_id, w.added_on,
         coalesce(w.removed_on,
                  (select min(r.removed_on) from watchlist_removals r
                    where r.instrument_id = w.instrument_id and r.removed_on >= w.added_on)) as removed_on,
         w.source, w.reason
    from watchlist w;
