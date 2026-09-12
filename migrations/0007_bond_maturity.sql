-- Add bond maturity fields to instruments table
alter table instruments
  add column if not exists maturity_date date,
  add column if not exists face_value_paise bigint,
  add column if not exists coupon_rate_bps int;