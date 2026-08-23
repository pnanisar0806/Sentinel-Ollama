-- One snapshot per (business_date, source).
--
-- writeSnapshot selected an existing snapshot and inserted one if it found none.
-- Without this constraint that is check-then-act: two syncs racing on the same
-- business date both see no row and both insert, and the portfolio is counted twice.
alter table snapshots add constraint snapshots_business_date_source_key
  unique (business_date, source);
