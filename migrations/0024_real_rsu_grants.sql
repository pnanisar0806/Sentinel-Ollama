-- The seeded RSU grants were an approximation; the owner's Fidelity statement is not.
--
-- `SEED_RSU_GRANTS` carried G2021..G2026. The 1,105-unit total was right and every
-- grant but the last had the wrong date and the wrong size — G2021 said 2021-11-15 /
-- 120 units where the real 12RUIN5012 is 2020-08-17 / 240. `projectVests` then spread
-- each invented grant over uniform QUARTERLY tranches, which is not how these vest:
-- 25RUST vests annually on 15 Feb and both 21RUIN4A* grants semi-annually.
--
-- That compounding is why the digest announced roughly ₹4L vesting on 15 Nov 2026 when
-- the statement says 18 units. Source: "Fidelity NetBenefits - Awards Details",
-- captured 2026-09-21 23:35 IST at NOW $135.47 — 400 units unvested across 21 tranches,
-- ₹51,92,023.22 outstanding.
--
-- The real grants and tranches are written by `seedActualRsu`, which runs from `seed()`.
-- This migration only clears the invented rows so they cannot linger beside them.

-- An owner-CONFIRMED vest is fact and survives, whatever grant it hangs off: FR-03 says
-- a projection never overwrites one, and neither does a migration. Only rows the MODEL
-- wrote are removed.
delete from rsu_vests
 where grant_id in ('G2021', 'G2022', 'G2023', 'G2024', 'G2025', 'G2026')
   and status <> 'ACTUAL';

-- A grant still carrying a confirmed vest keeps its row, because the foreign key needs
-- it. It will show as an orphan grant with no projection, which is visible and correct;
-- silently dropping the owner's confirmed history to tidy the table would not be.
delete from rsu_grants
 where id in ('G2021', 'G2022', 'G2023', 'G2024', 'G2025', 'G2026')
   and not exists (select 1 from rsu_vests v where v.grant_id = rsu_grants.id);
