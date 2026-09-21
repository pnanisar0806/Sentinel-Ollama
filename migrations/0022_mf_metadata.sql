-- Fund facts that are not a NAV: expense ratio, AUM, category, benchmark.
--
-- `rankMfs` weights consistency 40 / expense 20 / tenure 15 / aum 15 / style 10, and
-- four of those five had no column anywhere in the schema, so a ranking would have
-- silently scored 60 of 100 as zero. INDmoney's `get_mf_funds_details` supplies the
-- expense ratio and the AUM; tenure and style drift it does not, and they stay absent
-- rather than being proxied — a component missing for EVERY fund cannot change the
-- ordering, but one present for some funds and guessed for others distorts it.
--
-- Append-only and dated, like every other externally-sourced row: the expense ratio of
-- a fund changes, and last year's ranking was right on last year's number.
create table mf_metadata (
  id                 uuid primary key default gen_random_uuid(),
  instrument_id      text not null references instruments(id),
  as_of              date not null,
  -- Basis points. INDmoney reports percent (0.69), so this is that × 100.
  expense_ratio_bps  integer check (expense_ratio_bps is null or expense_ratio_bps >= 0),
  -- INDmoney's `aum` is in RUPEES CRORE — verified against known fund sizes on
  -- 2026-09-21 (ICICI Nifty 50 Index 17,254 cr, HDFC Mid Cap 108,325 cr, PPFC
  -- 148,429 cr), not assumed from the field name. Stored in paise like all money here.
  aum_paise          bigint check (aum_paise is null or aum_paise > 0),
  -- 'flexi cap', 'mid-cap', 'index funds' … INDmoney's own bucket, used for peer sets.
  category           text,
  benchmark_name     text,
  source             text not null,
  created_at         timestamptz not null default now(),
  unique (instrument_id, as_of)
);
create index mf_metadata_instrument_idx on mf_metadata (instrument_id, as_of desc);

create trigger mf_metadata_append_only before update or delete on mf_metadata
  for each statement execute function sentinel_append_only();
create trigger mf_metadata_truncate_only before truncate on mf_metadata
  for each statement execute function sentinel_append_only();

alter table mf_metadata enable row level security;
create policy mf_metadata_owner on mf_metadata
  using (true) with check (true);
