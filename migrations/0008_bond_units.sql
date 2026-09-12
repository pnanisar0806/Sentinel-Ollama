-- Add units column to instruments for bonds (number of units held)
alter table instruments
  add column if not exists units numeric(20,6);