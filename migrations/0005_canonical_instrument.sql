-- Canonical instrument ID for cross-source reconciliation (C-A fix wave)
-- Live source wins per (canonical_id, account); seed fills gaps; fallback to seed when live stops reporting.

alter table instruments add column if not exists canonical_id text;

-- Index for the deduplication query in loadPositions
create index if not exists instruments_canonical_id_idx on instruments (canonical_id);

-- Backfill canonical_id for seeded instruments from the owner's reconciliation map.
-- This migration runs AFTER seed.ts, so the instruments exist.
-- The seed data in SEED_INSTRUMENTS carries canonicalId; seed.ts writes it.