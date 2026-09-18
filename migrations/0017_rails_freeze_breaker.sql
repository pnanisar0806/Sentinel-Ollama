-- Phase 2 Task 2: Rails, freeze, breaker, behavioral protocol

-- Portfolio drawdown tracking for FR-34/FR-35
create table portfolio_drawdown (
  id              bigserial primary key,
  as_of           date not null,
  current_pct     numeric(5,2) not null,
  peak_date       date not null,
  peak_value      numeric(20,2) not null,
  created_at      timestamptz not null default now()
);

create index portfolio_drawdown_as_of_idx on portfolio_drawdown (as_of desc);

-- Rail changes with 48h cooling (FR-34)
-- Stored in settings_rails with keys:
--   'last_rail_change' = jsonb { key, old_value, new_value, direction: 'tighten'|'loosen', proposed_at, cooling_until }
--   'freeze_state'     = jsonb { active, frozen_at, reason }
--   'breaker_state'    = jsonb { active, consecutive_falsifications, last_falsification_at, demoted_at, post_mortem_note }

-- Ensure settings_rails has the needed keys
insert into settings_rails (key, value)
values
  ('freeze_state', '{"active":false,"frozenAt":null,"reason":null}'::jsonb),
  ('breaker_state', '{"active":false,"consecutiveFalsifications":0,"lastFalsificationAt":null,"demotedAt":null,"postMortemNote":null}'::jsonb)
on conflict (key) do nothing;

-- RLS
alter table portfolio_drawdown enable row level security;