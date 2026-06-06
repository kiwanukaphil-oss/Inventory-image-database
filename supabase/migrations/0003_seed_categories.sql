-- =============================================================================
-- Seed the category tree + per-category field definitions.
--
-- This is editable "config": to add/change a category or field, adjust the rows
-- here (or ask to tweak) and re-run — it is idempotent (ON CONFLICT DO NOTHING).
-- Universal columns on `items` (name, brand, price, stock_quantity,
-- reorder_level, sku, status, image) are NOT repeated here; only the
-- category-specific fields are defined.
--
-- Run AFTER 0002_categories.sql.
-- =============================================================================

-- ----- Top-level categories ------------------------------------------------
insert into public.categories (slug, name, sort) values
  ('clothing',    'Clothing',    10),
  ('footwear',    'Footwear',    20),
  ('fragrance',   'Fragrance',   30),
  ('accessories', 'Accessories', 40)
on conflict (slug) do nothing;

-- ----- Child categories (parent referenced by slug) ------------------------
insert into public.categories (slug, name, parent_id, sort)
select v.slug, v.name, p.id, v.sort
from (values
  ('pants',        'Pants',        'clothing',    10),
  ('shirts',       'Shirts',       'clothing',    20),
  ('jackets',      'Jackets',      'clothing',    30),
  ('sneakers',     'Sneakers',     'footwear',    10),
  ('formal-shoes', 'Formal Shoes', 'footwear',    20),
  ('belts',        'Belts',        'accessories', 10),
  ('watches',      'Watches',      'accessories', 20),
  ('wallets',      'Wallets',      'accessories', 30),
  ('caps',         'Caps',         'accessories', 40)
) as v(slug, name, parent_slug, sort)
join public.categories p on p.slug = v.parent_slug
on conflict (slug) do nothing;

-- ----- Field definitions ----------------------------------------------------
-- Columns: cat_slug, key, label, type, options(text[]), vocab, required, inherit, sort
insert into public.category_fields
  (category_id, key, label, type, options, vocab, required, inherit, sort)
select c.id, f.key, f.label, f.type, f.options, f.vocab, f.required, f.inherit, f.sort
from (values
  -- Clothing (inherited by Pants/Shirts/Jackets)
  ('clothing', 'color',         'Colour',         'select',  null::text[],                          'color',    false, true,  10),
  ('clothing', 'material',      'Material',       'text',    null::text[],                          'material', false, true,  20),
  -- Pants
  ('pants',    'size',          'Waist size',     'text',    null::text[],                          null,       false, false, 30),
  ('pants',    'fit',           'Fit',            'select',  null::text[],                          'fit',      false, false, 40),
  ('pants',    'style',         'Style code',     'text',    null::text[],                          null,       false, false, 50),
  ('pants',    'inseam',        'Inseam (in)',    'number',  null::text[],                          null,       false, false, 60),
  -- Shirts
  ('shirts',   'size',          'Size',           'select',  array['XS','S','M','L','XL','XXL'],     null,       false, false, 30),
  ('shirts',   'fit',           'Fit',            'select',  null::text[],                          'fit',      false, false, 40),
  ('shirts',   'sleeve',        'Sleeve',         'select',  array['Short','Long'],                 null,       false, false, 50),
  ('shirts',   'style',         'Style code',     'text',    null::text[],                          null,       false, false, 60),
  -- Jackets
  ('jackets',  'size',          'Size',           'select',  array['XS','S','M','L','XL','XXL'],     null,       false, false, 30),
  ('jackets',  'style',         'Style code',     'text',    null::text[],                          null,       false, false, 50),
  -- Footwear (inherited by Sneakers/Formal Shoes)
  ('footwear', 'color',         'Colour',         'select',  null::text[],                          'color',    false, true,  10),
  ('footwear', 'material',      'Material',       'text',    null::text[],                          'material', false, true,  20),
  -- Sneakers
  ('sneakers', 'size_eu',       'Size (EU)',      'number',  null::text[],                          null,       false, false, 30),
  ('sneakers', 'width',         'Width',          'select',  array['Narrow','Regular','Wide'],      null,       false, false, 40),
  ('sneakers', 'style',         'Model / style',  'text',    null::text[],                          null,       false, false, 50),
  -- Formal Shoes
  ('formal-shoes','size_eu',    'Size (EU)',      'number',  null::text[],                          null,       false, false, 30),
  ('formal-shoes','width',      'Width',          'select',  array['Narrow','Regular','Wide'],      null,       false, false, 40),
  ('formal-shoes','style',      'Style code',     'text',    null::text[],                          null,       false, false, 50),
  -- Fragrance (leaf)
  ('fragrance','volume_ml',     'Volume (ml)',    'number',  null::text[],                          null,       false, false, 10),
  ('fragrance','concentration', 'Concentration',  'select',  array['EDC','EDT','EDP','Parfum'],     null,       false, false, 20),
  ('fragrance','gender',        'For',            'select',  array['Men','Women','Unisex'],         null,       false, false, 30),
  ('fragrance','scent_family',  'Scent family',   'text',    null::text[],                          null,       false, false, 40),
  -- Accessories (inherited by Belts/Watches/Wallets/Caps)
  ('accessories','color',       'Colour',         'select',  null::text[],                          'color',    false, true,  10),
  ('accessories','material',    'Material',       'text',    null::text[],                          'material', false, true,  20),
  -- Belts
  ('belts',    'size',          'Belt size',      'text',    null::text[],                          null,       false, false, 30),
  -- Watches
  ('watches',  'movement',      'Movement',       'select',  array['Quartz','Automatic','Mechanical'], null,    false, false, 30),
  ('watches',  'strap_material','Strap material', 'text',    null::text[],                          null,       false, false, 40),
  ('watches',  'dial_color',    'Dial colour',    'select',  null::text[],                          'color',    false, false, 50),
  -- Caps
  ('caps',     'size',          'Size',           'select',  array['One Size','S','M','L','XL'],     null,       false, false, 30),
  ('caps',     'adjustable',    'Adjustable',     'boolean', null::text[],                          null,       false, false, 40)
) as f(cat_slug, key, label, type, options, vocab, required, inherit, sort)
join public.categories c on c.slug = f.cat_slug
on conflict (category_id, key) do nothing;
