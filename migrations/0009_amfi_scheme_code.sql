-- Add scheme_code column to instruments for AMFI MF mapping
alter table instruments
  add column if not exists scheme_code text;