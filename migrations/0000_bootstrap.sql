-- Bootstrap: migration bookkeeping only.
create table if not exists schema_migrations (
  name        text primary key,
  applied_at  timestamptz not null default now()
);
