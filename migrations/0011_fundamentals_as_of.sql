-- Drop append-only trigger for fundamentals (needs UPDATE for re-import)
drop trigger if exists fundamentals_append_only on fundamentals;
drop trigger if exists fundamentals_truncate_only on fundamentals;

-- Add as_of column to fundamentals for staleness tracking
alter table fundamentals
  add column if not exists as_of timestamptz not null default now();

-- Update existing rows to have as_of from screener_uploads.uploaded_on
update fundamentals f
set as_of = su.uploaded_on
from screener_uploads su
where f.upload_id = su.id;

-- RLS (but no append-only trigger)
alter table fundamentals enable row level security;
create trigger fundamentals_truncate_only before truncate on fundamentals
  for each statement execute function sentinel_append_only();