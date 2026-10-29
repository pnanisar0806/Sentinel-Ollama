-- Fund switch (spec §4.4): Nifty 50 index funds join the candidates, as same-index peers for a
-- held Nifty 50 fund.
alter table index_fund_candidates drop constraint index_fund_candidates_fund_type_check;
alter table index_fund_candidates add constraint index_fund_candidates_fund_type_check
  check (fund_type in ('US','NEXT50','NIFTY50'));
