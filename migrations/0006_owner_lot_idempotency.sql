-- At most ONE open owner-telegram lot per (instrument, account): re-confirming a
-- statement must supersede (close old, write new) rather than pile up redundant
-- open lots. Live-test finding 2026-08-25: repeated /confirm all accumulated 89
-- lots for ~31 instruments in production. FR-03 style — enforced HERE in SQL so no
-- code path can double-write, present or future.
create unique index if not exists lots_one_open_owner_per_position
  on lots (instrument_id, account)
  where closed_on is null and source = 'owner-telegram';
