-- Credit-rating actions on the issuers of bonds the owner holds (IPS §3.8).
--
-- Sell trigger 7 watched maturities only; a downgrade of Sammaan or Edelweiss could
-- happen with nothing noticing. Owner decision 2026-09-24: a data feed, not a manual
-- quarterly review.
--
-- Source: BSE corporate announcements, sub-category "Credit Rating". SEBI LODR Reg 30
-- obliges a listed issuer to disclose every rating action within 24 hours, so this is
-- the official, complete and timely record of one — verified 2026-09-25: 6 filings for
-- Sammaan Capital and 1 for Edelweiss in the prior 12 months.
--
-- The filing says THAT a rating action happened. What it was (upgrade, downgrade,
-- reaffirmation, outlook change) is in the attached PDF, kept here as a link. Parsing
-- those PDFs deterministically did not work on 2026-09-25, so the owner reads the one
-- page; the direction is not guessed.
--
-- Append-only: a filing is a fact on a date.
create table credit_rating_filings (
  id              uuid primary key default gen_random_uuid(),
  -- BSE's own id for the announcement; the natural key.
  news_id         text not null unique,
  -- The issuer part of an ISIN (first seven characters), e.g. INE148I for Sammaan.
  issuer_prefix   text not null,
  bse_scrip       text not null,
  company         text not null,
  filed_at        timestamptz not null,
  headline        text not null,
  attachment_url  text,
  as_of           timestamptz not null,
  source          text not null default 'bse'
);
create index credit_rating_filings_filed_idx on credit_rating_filings (filed_at desc);

create trigger credit_rating_filings_append_only before update or delete on credit_rating_filings
  for each statement execute function sentinel_append_only();
create trigger credit_rating_filings_truncate_only before truncate on credit_rating_filings
  for each statement execute function sentinel_append_only();

alter table credit_rating_filings enable row level security;
create policy credit_rating_filings_owner on credit_rating_filings using (true) with check (true);
