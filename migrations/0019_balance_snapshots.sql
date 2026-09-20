-- Daily balance snapshots: the raw material for a measured surplus.
--
-- `surplus.ts` models surplus as take-home minus five fixed outflows, which cannot see
-- credit-card spend. The owner deploys ~50,000/month against a modelled 82,124, and the
-- gap is unexplained. Realised surplus is instead derivable from balance deltas alone:
--
--   realised surplus = d(savings) + d(invested cost) + loan principal repaid
--                      - d(card outstanding)
--
-- No income term and no transaction feed. Card payments cancel out of that derivation --
-- a payment moves money from the savings term to the card term and nets to zero -- so
-- the three different card billing dates never have to be aligned and no rupee can be
-- counted twice.
--
-- Daily rather than monthly on purpose. INDmoney serves only today's snapshot, so none of
-- this can be backfilled and a missed day is gone. Daily also makes the salary credit
-- observable as a single large jump in the savings balance, which matters because pay
-- lands on the last WORKING day: a month-end boundary puts it in the next month whenever
-- the 30th is a Sunday, and the month reads as a collapse followed by a windfall.
create table balance_snapshots (
  id            uuid primary key default gen_random_uuid(),
  as_of         date not null,
  taken_at      timestamptz not null default now(),
  -- Where the figure came from, per the as_of/source rule every external row follows.
  source        text not null,
  kind          text not null check (kind in ('savings', 'credit_card', 'invested_cost', 'loan')),
  -- Bank name, card name, asset type or lender. Scopes the amount within its kind.
  label         text not null,
  -- Cards and loans are recorded as POSITIVE amounts owed, never as negative assets.
  amount_paise  bigint not null,
  -- One row per account per day makes a re-run a no-op instead of a double count.
  unique (as_of, kind, label)
);
create index balance_snapshots_as_of_idx on balance_snapshots (as_of desc);

create trigger balance_snapshots_append_only before update or delete on balance_snapshots
  for each statement execute function sentinel_append_only();
create trigger balance_snapshots_truncate_only before truncate on balance_snapshots
  for each statement execute function sentinel_append_only();

-- RLS everywhere, per the PRD: append-only triggers protect local and remote identically,
-- RLS is what protects it in Supabase. A table without it fails tests/db/immutability.
alter table balance_snapshots enable row level security;
create policy balance_snapshots_owner on balance_snapshots
  using (true) with check (true);
