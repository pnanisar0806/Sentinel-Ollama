-- Open list #28 (owner, 2026-11-19): a minimum order of Rs 1,000 (100000 paise). Below it the
-- monthly plan and lump-sum sizing propose no BUY. SIPs reached Rs 49,804 of the Rs 50,000
-- budget in November, so without it December's tranche would be a Rs 196 BUY.
-- An existing row (an owner edit) is left alone.
insert into settings_rails (key, value) values ('min_order_paise', '100000'::jsonb)
on conflict (key) do nothing;
