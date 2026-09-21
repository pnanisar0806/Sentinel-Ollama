-- Four of the six seeded mutual funds carried the wrong AMFI identifiers, so every NAV
-- stored against them is a different plan's price series.
--
-- `ingestNavs` resolves a NAV row by ISIN or scheme code. The seeded scheme codes
-- 100002-100006 were sequential placeholders matching no AMFI scheme at all (checked:
-- none of them appear in NAVAll.txt), and the ISINs pointed at the wrong PLAN of the
-- right fund, or at a different fund:
--
--   MF:PPFC            INF879O01308 -> scheme 153964, the IDCW variant
--                      correct: INF879O01027, scheme 122639 (NAV 89.8569 matches INDmoney)
--   MF:HDFC-MIDCAP     INF179K01XP2 -> scheme 118988, the IDCW variant
--                      correct: INF179K01XQ0, scheme 118989 (NAV 231.413 matches INDmoney)
--   MF:ICICI-LARGECAP  INF109K01449 -> scheme 100348, ICICI Large & MID Cap, REGULAR plan
--                      correct: INF109K016L0, scheme 120586
--   MF:MOTILAL-MIDCAP  INF247L01452 -> scheme 127044
--                      correct: INF247L01445, scheme 127042 (NAV 120.0335 matches INDmoney)
--
-- MF:ICICI-NIFTY50-IDX and MF:BANDHAN-SMALLCAP were already right; their scheme codes
-- are corrected from placeholders to the real ones.
--
-- Every value above was resolved against AMFI's own NAVAll.txt on 2026-09-21 and
-- cross-checked against the NAV INDmoney reports for the holding. None was recalled.
--
-- Nothing consumed per-instrument NAVs yet — only `staleness.ts`, and only for
-- `max(as_of)` — which is the sole reason this had not already produced wrong advice.
-- It would have, the moment MF ranking was wired up.
update instruments set isin = 'INF879O01027', scheme_code = '122639' where id = 'MF:PPFC';
update instruments set isin = 'INF179K01XQ0', scheme_code = '118989' where id = 'MF:HDFC-MIDCAP';
update instruments set isin = 'INF109K016L0', scheme_code = '120586' where id = 'MF:ICICI-LARGECAP';
update instruments set isin = 'INF247L01445', scheme_code = '127042' where id = 'MF:MOTILAL-MIDCAP';
update instruments set scheme_code = '120620' where id = 'MF:ICICI-NIFTY50-IDX';
update instruments set scheme_code = '147946' where id = 'MF:BANDHAN-SMALLCAP';

-- The NAVs already written for the four are the wrong plan's, so they are deleted rather
-- than left to be partially overwritten: a re-backfill upserts on (instrument_id,
-- nav_date) and would leave every date the correct series does not cover still holding a
-- wrong value. `navs` carries no append-only trigger precisely because a price series can
-- need correcting; this is that case.
--
-- Re-run `pnpm backfill:navs --months=30` after this migration.
delete from navs where instrument_id in
  ('MF:PPFC', 'MF:HDFC-MIDCAP', 'MF:ICICI-LARGECAP', 'MF:MOTILAL-MIDCAP');
