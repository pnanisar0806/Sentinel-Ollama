-- PRD hard constraint: audit immutability is enforced by triggers (UPDATE, DELETE
-- *and* TRUNCATE) plus RLS in Supabase. 0001 delivered triggers on two tables and a
-- comment promising RLS "when Supabase is provisioned". Migrations are the only path
-- to Supabase, so that RLS would never have been applied.

-- ips_versions holds the IPS text shown to the owner at a -20% drawdown; a silent
-- edit there rewrites the policy he is being held to. bucket_flows is a signed money
-- ledger — a correction is a reversing entry, never an edit.
create trigger ips_versions_append_only before update or delete on ips_versions
  for each statement execute function sentinel_append_only();
create trigger ips_versions_truncate_only before truncate on ips_versions
  for each statement execute function sentinel_append_only();
create trigger bucket_flows_append_only before update or delete on bucket_flows
  for each statement execute function sentinel_append_only();
create trigger bucket_flows_truncate_only before truncate on bucket_flows
  for each statement execute function sentinel_append_only();

-- `lots` is the FIFO cost basis, so it cannot be blanket append-only: closing a lot
-- on disposal is a legitimate UPDATE of `closed_on`. Everything else about a lot is
-- history and must not move. Row-level so it can compare OLD and NEW.
create or replace function sentinel_lots_immutable() returns trigger as $$
begin
  if tg_op <> 'UPDATE' then
    raise exception 'lots is immutable: rows may not be % ed', tg_op;
  end if;
  if new.id            is distinct from old.id
  or new.instrument_id is distinct from old.instrument_id
  or new.account       is distinct from old.account
  or new.acquired_on   is distinct from old.acquired_on
  or new.quantity      is distinct from old.quantity
  or new.cost_paise    is distinct from old.cost_paise
  or new.seeded        is distinct from old.seeded
  or new.as_of         is distinct from old.as_of
  or new.source        is distinct from old.source then
    raise exception 'lots is immutable: only closed_on may be updated';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger lots_immutable_update before update on lots
  for each row execute function sentinel_lots_immutable();
create trigger lots_immutable_delete before delete on lots
  for each statement execute function sentinel_append_only();
create trigger lots_truncate_only before truncate on lots
  for each statement execute function sentinel_append_only();

-- RLS. Enabling with no policy denies anon and authenticated outright, which is the
-- correct posture for a single-user agent: the jobs connect as the owner/service role,
-- and both bypass RLS. NOT `force row level security` — that would also apply to the
-- owner and lock the jobs out of their own database.
alter table instruments    enable row level security;
alter table snapshots      enable row level security;
alter table holdings       enable row level security;
alter table lots           enable row level security;
alter table buckets        enable row level security;
alter table bucket_flows   enable row level security;
alter table milestones     enable row level security;
alter table rsu_grants     enable row level security;
alter table rsu_vests      enable row level security;
alter table loans          enable row level security;
alter table loan_schedule  enable row level security;
alter table ips_versions   enable row level security;
alter table fx_rates       enable row level security;
alter table incidents      enable row level security;
alter table settings_rails enable row level security;
alter table audit_log      enable row level security;
alter table oauth_clients  enable row level security;
alter table oauth_tokens   enable row level security;
