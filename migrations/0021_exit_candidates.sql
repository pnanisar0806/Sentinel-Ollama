-- What the §6.5 sell triggers found, month by month.
--
-- `evaluateExits` was recomputed from scratch every time anything asked — the weekly
-- report rendered it into Telegram text and /cleanup re-derived it on each page load —
-- and the result was written nowhere. So nothing could answer the questions that make
-- an exit engine useful: when was this name first flagged, is it the same breach as
-- last month or a new one, and did the owner act on the last one. The weekly digest
-- re-sent the same candidate forever with no memory of having sent it.
--
-- These are NOT recommendations. A candidate is a signal the engine raised; turning one
-- into an FR-11 recommendation is a separate, deliberate step that consumes the FR-12
-- monthly action budget. Persisting them here records what the engine saw without
-- spending that budget, and without implying the default answer is anything but hold.
--
-- Append-only: the row is the record of what was true that month. A breach that clears
-- is absent from the NEXT month, never edited out of this one.
create table exit_candidates (
  id                      uuid primary key default gen_random_uuid(),
  -- 'YYYY-MM'. The engine evaluates a whole month at its end, not a point in time.
  month                   text not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  instrument_id           text not null references instruments(id),
  -- Matches the ExitTrigger union in src/domain/sell-triggers.ts.
  trigger_code            text not null check (trigger_code in
                            ('falsification', 'red-flag', 'hard-cap', 'underperformance',
                             'better-alternative', 'credit-maturity')),
  action                  text not null check (action in ('SELL', 'TRIM', 'REDEEM')),
  -- The datum that fired it, not a restatement of the rule.
  evidence                text not null,
  ips_clause_refs         jsonb not null,
  overrides_minimum_hold  boolean not null,
  -- NULL when nothing dates the position; never 0, which would read as "bought today".
  held_months             integer,
  blocked_by_minimum_hold boolean not null,
  -- NULL when no position sizes it. Never 0 — an exit worth nothing is not an exit.
  amount_paise            bigint check (amount_paise is null or amount_paise > 0),
  as_of                   date not null,
  source                  text not null,
  created_at              timestamptz not null default now(),
  -- One row per trigger per name per month, so a re-run of the weekly job adds nothing.
  unique (month, instrument_id, trigger_code)
);
create index exit_candidates_month_idx on exit_candidates (month desc);
create index exit_candidates_instrument_idx on exit_candidates (instrument_id);

create trigger exit_candidates_append_only before update or delete on exit_candidates
  for each statement execute function sentinel_append_only();
create trigger exit_candidates_truncate_only before truncate on exit_candidates
  for each statement execute function sentinel_append_only();

alter table exit_candidates enable row level security;
create policy exit_candidates_owner on exit_candidates
  using (true) with check (true);
