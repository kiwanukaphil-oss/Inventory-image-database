-- =============================================================================
-- Fragrance: add an Edition (variant/flanker) field, and label volume as Size.
--
-- Product name is captured in the item's universal `name` (so it becomes the
-- card title, e.g. "Emporio Armani · Diamonds"). Edition is the specific variant
-- (e.g. "Intensely", "Absolutely"); "Standard" when there is none — the AI is
-- taught this in the ai-extract function.
--
-- Run AFTER 0008. Idempotent.
-- =============================================================================

insert into public.category_fields (category_id, key, label, type, options, vocab, required, inherit, sort)
select c.id, 'edition', 'Edition', 'text', null, null, false, false, 25
from public.categories c
where c.slug = 'fragrance'
on conflict (category_id, key) do nothing;

-- Match the user's terminology ("Size 75ml").
update public.category_fields cf
set label = 'Size (ml)'
from public.categories c
where cf.category_id = c.id and c.slug = 'fragrance' and cf.key = 'volume_ml';
