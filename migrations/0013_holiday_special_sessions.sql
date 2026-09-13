-- A weekend is not the same as a non-trading day in India, in BOTH directions:
-- NSE closes on ~15 weekday holidays a year, and it OPENS on a Sunday for Muhurat
-- trading (Diwali Laxmi Pujan) and occasionally for a Union Budget session.
--
-- Skipping on weekends alone therefore fails twice a year each way: it asks NSE for a
-- file that does not exist on a holiday (a loud failed step), and it silently misses the
-- one Sunday that does have a bhavcopy.
alter table holidays
  add column if not exists is_special_session boolean not null default false;

comment on column holidays.is_special_session is
  'true = the exchange is OPEN on a day the weekend rule would skip (Muhurat, Budget session)';
