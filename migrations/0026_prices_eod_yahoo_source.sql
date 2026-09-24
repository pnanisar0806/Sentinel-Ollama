-- ServiceNow (US:NOW) daily closes, so the portfolio drawdown can include the RSU.
--
-- `prices_eod` accepted exactly one source, 'nse-bhavcopy'. The RSU is ~23% of the
-- book, has no daily snapshot history, and was therefore left out of the drawdown that
-- the 15% and 20% rails read — under-reporting any fall in NOW. Its closes come from
-- Yahoo's chart endpoint (already the live NOW price source), converted to paise at that
-- day's USD/INR.
--
-- The FR-31 bhavcopy staleness check now counts only 'nse-bhavcopy' rows, so a fresh
-- NOW close cannot make a dead NSE feed read as current.
alter table prices_eod drop constraint if exists prices_eod_source_check;
alter table prices_eod add constraint prices_eod_source_check
  check (source in ('nse-bhavcopy', 'yahoo'));
