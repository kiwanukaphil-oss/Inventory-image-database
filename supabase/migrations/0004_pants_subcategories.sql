-- =============================================================================
-- Pant-type subcategories under Pants.
--
-- The 242 existing photos are 6 pant types (Cargo, Khaki/Chino, Formal, Linen,
-- Flat-front, Relaxed Drawstring). We model each as a subcategory of Pants so
-- the catalogue supports category + subcategory grouping with real data.
--
-- They carry no fields of their own — they inherit Pants' fields (which in turn
-- inherit Clothing's). For that to work, Pants' own fields must be marked
-- inheritable, so we flip them here.
--
-- Run AFTER 0003_seed_categories.sql. Idempotent.
-- =============================================================================

-- Make Pants' own fields (size, fit, style, inseam) inheritable so the pant-type
-- subcategories pick them up alongside the inherited Clothing fields.
update public.category_fields cf
set inherit = true
from public.categories c
where cf.category_id = c.id
  and c.slug = 'pants';

-- Add the 6 pant-type subcategories under Pants.
insert into public.categories (slug, name, parent_id, sort)
select v.slug, v.name, p.id, v.sort
from (values
  ('pants-cargo',      'Cargo',              'pants', 10),
  ('pants-khaki',      'Khaki / Chino',      'pants', 20),
  ('pants-formal',     'Formal',             'pants', 30),
  ('pants-linen',      'Linen',              'pants', 40),
  ('pants-flat-front', 'Flat-front',         'pants', 50),
  ('pants-relaxed',    'Relaxed Drawstring', 'pants', 60)
) as v(slug, name, parent_slug, sort)
join public.categories p on p.slug = v.parent_slug
on conflict (slug) do nothing;
