-- Owner amendment 2026-09-19: PRD/IPS 3.3 gains an explicit cash ceiling of 10%.
-- The PRD had left cash unbounded ("Debt/EPF/cash: remainder"), so the only row this
-- database ever carried was a legacy `cash.ceiling` written as a fraction (0.2) under a
-- dotted key. `seed.ts` writes `cash_ceiling_pct` as a percent (10) and `checkCashCeiling`
-- reads that key, so the legacy row is now both unread and contradictory on the /rails
-- page. Reconcile to one key, one unit.
--
-- `do nothing` on conflict: if the owner has already set a value through the app, it
-- stands. The cooling-off in FR-34 governs owner edits, not this one-time reconciliation.

insert into settings_rails (key, value)
values ('cash_ceiling_pct', '10'::jsonb)
on conflict (key) do nothing;

delete from settings_rails where key = 'cash.ceiling';
