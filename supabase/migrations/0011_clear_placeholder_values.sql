-- =============================================================================
-- One-time cleanup: clear placeholder values ("unknown", "n/a", "-", …) that an
-- earlier AI prompt wrote into fields, so those fields read as BLANK again and
-- the only-fill-empty workflow works on them. Safe to re-run.
-- Run AFTER 0010.
-- =============================================================================

-- Attribute (jsonb) values: drop any key whose value is a placeholder.
update public.items i
set attributes = coalesce((
  select jsonb_object_agg(e.key, e.value)
  from jsonb_each(i.attributes) e
  where lower(trim(e.value #>> '{}')) not in
    ('unknown','n/a','na','n.a.','none','null','-','--','not visible','not specified','not shown','unspecified','unknown brand')
), '{}'::jsonb)
where exists (
  select 1 from jsonb_each(i.attributes) e
  where lower(trim(e.value #>> '{}')) in
    ('unknown','n/a','na','n.a.','none','null','-','--','not visible','not specified','not shown','unspecified','unknown brand')
);

-- Brand / name columns.
update public.items set brand = null
where lower(trim(brand)) in ('unknown','n/a','na','n.a.','none','null','-','--','not visible','not specified','not shown','unspecified','unknown brand');

update public.items set name = null
where lower(trim(name)) in ('unknown','n/a','na','n.a.','none','null','-','--','not visible','not specified','not shown','unspecified');
