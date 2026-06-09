-- =============================================================================
-- Shirt-type subcategories under Shirts (Formal, Business Casual, Smart Casual).
--
-- Mirrors the pant-type subcategories (0004): each carries no fields of its own
-- and inherits Shirts' fields (which in turn inherit Clothing's). For that to
-- work, Shirts' own fields must be marked inheritable, so we flip them here.
--
-- Run AFTER 0004_pants_subcategories.sql. Idempotent.
-- =============================================================================

-- Make Shirts' own fields (fit, sleeve, …) inheritable so the shirt-type
-- subcategories pick them up alongside the inherited Clothing fields.
update public.category_fields cf
set inherit = true
from public.categories c
where cf.category_id = c.id
  and c.slug = 'shirts';

-- Add the 3 shirt-type subcategories under Shirts.
insert into public.categories (slug, name, parent_id, sort)
select v.slug, v.name, p.id, v.sort
from (values
  ('shirts-formal',          'Formal',          'shirts', 10),
  ('shirts-business-casual', 'Business Casual', 'shirts', 20),
  ('shirts-smart-casual',    'Smart Casual',    'shirts', 30)
) as v(slug, name, parent_slug, sort)
join public.categories p on p.slug = v.parent_slug
on conflict (slug) do nothing;
