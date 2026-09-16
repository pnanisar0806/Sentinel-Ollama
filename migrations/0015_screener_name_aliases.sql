-- Screener CSV name aliases: maps abbreviated display names from CSV exports to instrument IDs
-- Populated once by owner; used by parseScreenPaste/importScreenRows for name-only resolution
create table screener_name_aliases (
    csv_name        text not null,          -- exact display name from CSV (e.g. 'Hind. Unilever')
    instrument_id   text not null references instruments(id) on delete restrict,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    primary key (csv_name)
);

create index screener_name_aliases_instrument_idx on screener_name_aliases (instrument_id);

comment on table screener_name_aliases is
'Manual mapping from screener CSV display names to instrument IDs.
CSV exports use abbreviated names (e.g. "Hind. Unilever") while instruments
use full names (e.g. "Hindustan Unilever Ltd"). This table bridges the gap
for paste/CSV imports where no symbol/slug is available.';

-- RLS (single-user, owner-only access)
alter table screener_name_aliases enable row level security;
create policy screener_name_aliases_owner on screener_name_aliases
  using (true) with check (true);