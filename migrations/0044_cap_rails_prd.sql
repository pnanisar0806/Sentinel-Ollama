-- Open list #4 (owner OK 2026-11-12): the concentration caps are owner rails (PRD §11).
-- The seed wrote employer 25, MF scheme 10, sector 20 and issuer 15, contradicting IPS §3.5
-- (10 / 35 / 25 / 10). Nothing read those rows, so the PRD values in code were what was
-- enforced. Code now reads these rows; correct them first so enforcement does not change.
-- Only a row still holding its wrong seeded value is touched: an owner's own edit stays.
update settings_rails set value = '10'::jsonb, updated_at = now() where key = 'employer_cap_pct'  and value = '25'::jsonb;
update settings_rails set value = '35'::jsonb, updated_at = now() where key = 'mf_scheme_cap_pct' and value = '10'::jsonb;
update settings_rails set value = '25'::jsonb, updated_at = now() where key = 'sector_cap_pct'    and value = '20'::jsonb;
update settings_rails set value = '10'::jsonb, updated_at = now() where key = 'issuer_cap_pct'    and value = '15'::jsonb;
