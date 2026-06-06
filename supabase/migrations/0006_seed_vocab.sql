-- =============================================================================
-- Seed controlled vocabularies + normalise existing colour spellings.
--
-- Colours: canonicals built from the real data, with British/American spellings
-- and the "Baige" typo captured as aliases (so they normalise to canonical).
-- We do NOT merge genuinely different colours (Charcoal vs Dark Gray stay apart).
-- Brands: auto-seeded from existing items. Fits/materials: a sensible starter set.
--
-- Run AFTER 0005. Idempotent (re-running is safe).
-- =============================================================================

-- ----- Colour canonicals + aliases -----------------------------------------
insert into public.vocabularies (field, canonical, aliases) values
  ('color','Almond Green',   '{}'),
  ('color','Army Green',     '{}'),
  ('color','Beige',          '{}'),
  ('color','Black',          '{}'),
  ('color','Blue',           '{}'),
  ('color','Blue Brown Plaid','{}'),
  ('color','Blue Gray Plaid', array['Blue Grey Plaid']),
  ('color','Brown',          '{}'),
  ('color','Charcoal',       '{}'),
  ('color','Charcoal Gray',  array['Charcoal Grey']),
  ('color','Coffee Brown',   '{}'),
  ('color','Cream',          '{}'),
  ('color','Cream Gray',     array['Cream Grey']),
  ('color','Dark Blue',      '{}'),
  ('color','Dark Brown',     '{}'),
  ('color','Dark Gray',      array['Dark Grey']),
  ('color','Dark Khaki',     '{}'),
  ('color','Dark Navy',      '{}'),
  ('color','Forest Green',   '{}'),
  ('color','Gray',           array['Grey']),
  ('color','Gray Beige',     array['Gray Baige','Grey Beige','Grey Baige']),
  ('color','Gray Melange',   array['Grey Melange']),
  ('color','Green',          '{}'),
  ('color','Khaki',          '{}'),
  ('color','Light Gray',     array['Light Grey']),
  ('color','Mint Green',     '{}'),
  ('color','Navy',           array['Navy Blue']),
  ('color','Off White',      array['Offwhite','Off-White']),
  ('color','Olive Green',    '{}'),
  ('color','Space Gray',     array['Space Grey']),
  ('color','Stone',          '{}'),
  ('color','Tan',            '{}'),
  ('color','White',          '{}')
on conflict (field, canonical) do nothing;

-- ----- Fit (men's pants) ----------------------------------------------------
insert into public.vocabularies (field, canonical, aliases) values
  ('fit','Slim',         '{}'),
  ('fit','Skinny',       '{}'),
  ('fit','Slim Comfort', array['Slimmy Comfort','Slim-Comfort']),
  ('fit','Straight',     '{}'),
  ('fit','Regular',      '{}'),
  ('fit','Relaxed',      '{}'),
  ('fit','Tapered',      '{}'),
  ('fit','Comfort',      '{}'),
  ('fit','Muscle',       '{}')
on conflict (field, canonical) do nothing;

-- ----- Material (starter set) ----------------------------------------------
insert into public.vocabularies (field, canonical, aliases) values
  ('material','Cotton',       array['100% cotton','100% Cotton']),
  ('material','Cotton Blend', '{}'),
  ('material','Polyester',    array['100% Polyester']),
  ('material','Linen',        '{}'),
  ('material','Denim',        '{}')
on conflict (field, canonical) do nothing;

-- ----- Brands: seed from existing items -------------------------------------
insert into public.vocabularies (field, canonical)
select distinct 'brand', i.brand
from public.items i
where coalesce(i.brand, '') <> ''
on conflict (field, canonical) do nothing;

-- ----- Normalise existing colour values to canonical ------------------------
-- Any item whose colour matches a known alias is rewritten to the canonical.
-- This fires the SKU + audit triggers, so the change is logged and SKUs refresh.
update public.items i
set attributes = jsonb_set(i.attributes, '{color}', to_jsonb(v.canonical))
from public.vocabularies v
where v.field = 'color'
  and i.attributes ? 'color'
  and (i.attributes->>'color') = any (v.aliases);
