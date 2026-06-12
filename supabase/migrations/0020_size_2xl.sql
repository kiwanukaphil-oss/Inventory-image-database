-- =============================================================================
-- Size spelling: XXL -> 2XL on shirts (option list + existing Moss London items).
--
-- The catalogue's convention for double-extra-large is "2XL", but the shirts
-- size options seeded in 0003 said "XXL", so a batch of Moss London shirts was
-- tagged XXL. Two fixes:
--   1. Replace XXL with 2XL in the shirts Size option list, so the editor /
--      bulk edit offer 2XL and the AI extractor's guidance prefers it.
--   2. Retag the existing Moss London shirts from XXL to 2XL.
--
-- The plain UPDATE on items is enough to propagate everywhere: items_biu
-- re-derives the SKU (…-XXL becomes …-2XL), items_audit logs the change, and
-- mark_pos_dirty flags already-synced items so the next pos-push run sends the
-- corrected size to the shop.
--
-- Run AFTER 0019. Idempotent.
-- =============================================================================

update public.category_fields f
set options = array_replace(f.options, 'XXL', '2XL')
where f.key = 'size'
  and f.category_id = (select id from public.categories where slug = 'shirts')
  and 'XXL' = any(f.options);

update public.items i
set attributes = jsonb_set(i.attributes, '{size}', to_jsonb('2XL'::text))
where i.brand ilike 'moss london'
  and i.attributes->>'size' = 'XXL'
  and i.category_id in (
    select id from public.categories
    where slug = 'shirts'
       or parent_id = (select id from public.categories where slug = 'shirts')
  );
