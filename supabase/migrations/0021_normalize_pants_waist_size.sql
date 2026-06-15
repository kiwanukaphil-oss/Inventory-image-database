-- =============================================================================
-- Pants waist-size spelling: W36 -> 36, W32 L34 -> 32, 32W -> 32.
--
-- Pants/jeans store "size" as waist size only; inseam has its own field. AI and
-- tag text sometimes include the W prefix or a waist/leg pair, which splits
-- filters and SKU grouping (W36 and 36 become different SKU tokens). This
-- migration canonicalises existing pants descendants to the numeric waist.
--
-- The UPDATE fires the existing items_biu trigger, so SKUs are recalculated.
-- Run AFTER 0020. Idempotent.
-- =============================================================================

with recursive pants_categories as (
  select id
  from public.categories
  where slug = 'pants'

  union all

  select c.id
  from public.categories c
  join pants_categories p on c.parent_id = p.id
),
normalised as (
  select
    i.id,
    i.attributes,
    case
      when trim(i.attributes->>'size') ~* '^(W|WAIST)\s*[0-9]{2,3}\s*("|IN|INCH|INCHES)?$' then
        regexp_replace(trim(i.attributes->>'size'), '^(W|WAIST)\s*([0-9]{2,3})\s*("|IN|INCH|INCHES)?$', '\2', 'i')
      when trim(i.attributes->>'size') ~* '^[0-9]{2,3}\s*(W|WAIST)$' then
        regexp_replace(trim(i.attributes->>'size'), '^([0-9]{2,3})\s*(W|WAIST)$', '\1', 'i')
      when trim(i.attributes->>'size') ~* '^[0-9]{2,3}\s*("|IN|INCH|INCHES)$' then
        regexp_replace(trim(i.attributes->>'size'), '^([0-9]{2,3})\s*("|IN|INCH|INCHES)$', '\1', 'i')
      when trim(i.attributes->>'size') ~* '^(W\s*)?[0-9]{2,3}\s*(X|/|-|L|LEG|INSEAM)\s*[0-9]{2,3}\s*("|IN|INCH|INCHES)?$' then
        regexp_replace(trim(i.attributes->>'size'), '^(W\s*)?([0-9]{2,3})\s*(X|/|-|L|LEG|INSEAM)\s*[0-9]{2,3}\s*("|IN|INCH|INCHES)?$', '\2', 'i')
      else trim(i.attributes->>'size')
    end as size_norm
  from public.items i
  where i.category_id in (select id from pants_categories)
    and i.attributes ? 'size'
)
update public.items i
set attributes = jsonb_set(i.attributes, '{size}', to_jsonb(n.size_norm))
from normalised n
where i.id = n.id
  and i.attributes->>'size' is distinct from n.size_norm;
