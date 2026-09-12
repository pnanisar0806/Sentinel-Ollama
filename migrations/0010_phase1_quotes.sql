-- Phase 1: Quote tables (prices_eod, index_prices_eod, navs, holidays)

create table prices_eod (
  instrument_id   text not null references instruments(id),
  trade_date      date not null,
  close_paise     bigint not null,
  prev_close_paise bigint,
  source          text not null check (source = 'nse-bhavcopy'),
  as_of           timestamptz not null,
  primary key (instrument_id, trade_date)
);
create index prices_eod_instrument_date_idx on prices_eod (instrument_id, trade_date desc);

create table index_prices_eod (
  series_code     text not null,
  trade_date      date not null,
  close_paise     bigint not null,
  source          text not null default 'nse-index-bhavcopy',
  as_of           timestamptz not null,
  primary key (series_code, trade_date)
);
create index index_prices_eod_series_date_idx on index_prices_eod (series_code, trade_date desc);

create table navs (
  instrument_id   text not null references instruments(id),
  nav_date        date not null,
  nav_micros      bigint not null,
  source          text not null check (source = 'amfi'),
  as_of           timestamptz not null,
  primary key (instrument_id, nav_date)
);
create index navs_instrument_date_idx on navs (instrument_id, nav_date desc);

create table holidays (
  holiday_date    date primary key,
  note            text not null
);

-- Append-only triggers (prices_eod/index_prices_eod/navs allow corrections)
-- NAV corrections are legitimate like price corrections

-- RLS
alter table prices_eod enable row level security;
alter table index_prices_eod enable row level security;
alter table navs enable row level security;
alter table holidays enable row level security;