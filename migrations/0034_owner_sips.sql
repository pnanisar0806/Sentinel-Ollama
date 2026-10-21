-- Owner-stated SIP instalments the INDmoney feed cannot see (e.g. a SIP debited and stopped
-- before SIP tracking began). One row per fund per IST month; loadSipCommitment counts it only
-- in that month and only for what the feed does not already carry for the fund. No owner data
-- is seeded here.
create table owner_sip_payments (
  id bigserial primary key,
  instrument_id text not null references instruments(id),
  paid_on date not null,
  month text not null check (month = to_char(paid_on, 'YYYY-MM')),
  amount_paise bigint not null check (amount_paise > 0),
  note text not null default '',
  as_of timestamptz not null,
  source text not null check (source <> ''),
  unique (instrument_id, month)
);

create trigger owner_sip_payments_append_only before update or delete on owner_sip_payments
  for each statement execute function sentinel_append_only();
create trigger owner_sip_payments_truncate_only before truncate on owner_sip_payments
  for each statement execute function sentinel_append_only();
-- RLS on with NO policy: anon/authenticated get nothing; the owner connection bypasses RLS.
alter table owner_sip_payments enable row level security;
