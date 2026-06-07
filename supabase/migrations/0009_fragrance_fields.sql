-- =============================================================================
-- Fragrance fields.
--
-- The product name (including any variant/flanker, e.g. "Polo Red",
-- "Stronger With You Intensely") is captured in the item's universal `name`,
-- which becomes the card title — so there is NO separate Edition field.
--
-- This migration removes the Edition field if an earlier version added it, and
-- labels volume as "Size (ml)" to match shop terminology.
--
-- Run AFTER 0008. Idempotent.
-- =============================================================================

-- Drop the Edition field (folded into the product name instead).
delete from public.category_fields cf
using public.categories c
where cf.category_id = c.id and c.slug = 'fragrance' and cf.key = 'edition';

-- Label volume as Size (ml).
update public.category_fields cf
set label = 'Size (ml)'
from public.categories c
where cf.category_id = c.id and c.slug = 'fragrance' and cf.key = 'volume_ml';
