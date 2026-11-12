-- Open list #8 (2026-11-12): a sale or bond redemption the owner chooses to invest becomes a lump
-- sum in the same step. `origin` names the entry it came from: 'owner_sale:<owner_sales.id>' or
-- 'bond_redemption:<canonical id>'. NULL for money received logged by hand. The domain refuses a
-- second live lump sum with the same origin (src/domain/owner-log.ts insertLumpSum); a partial
-- unique index cannot, because "live" means "not in log_reversals".
alter table lump_sums add column origin text;
