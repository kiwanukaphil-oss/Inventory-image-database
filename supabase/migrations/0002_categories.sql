-- =============================================================================
-- Phase 1 (revised) — category tree + per-category custom fields
--
-- The catalogue holds more than clothing (perfumes, shoes, accessories, ...),
-- and different item types need different fields. So:
--   * categories is an arbitrary-depth tree (parent_id).
--   * category_fields defines, per category, which fields an item has (with
--     inheritance to child categories).
--   * items keeps only UNIVERSAL columns and stores everything category-specific
--     in an `attributes` JSONB blob; per-field confidence moves to a `confidence`
--     JSONB map so it works for any field, not just the clothing five.
--
-- Run this AFTER 0001_init.sql. Safe to run on the empty schema (no data yet).
-- The cost-isolation model from 0001 (item_costs, admin-only RLS) is unchanged.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- categories: arbitrary-depth tree (Clothing > Pants, Footwear > Sneakers, ...)
-- ---------------------------------------------------------------------------
create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  slug       text unique not null,
  name       text not null,
  parent_id  uuid references public.categories(id) on delete restrict,
  sort       integer not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists categories_parent_idx on public.categories (parent_id);

-- ---------------------------------------------------------------------------
-- category_fields: the per-category field definitions ("I define now").
--   inherit = true  -> the field also applies to all descendant categories
--                      (e.g. Clothing.color is inherited by Pants and Shirts).
--   vocab           -> name of a controlled-vocabulary list for autocomplete
--                      (colors, brands, ...); used when options is null.
-- ---------------------------------------------------------------------------
create table if not exists public.category_fields (
  id          uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.categories(id) on delete cascade,
  key         text not null,         -- attribute key stored in items.attributes
  label       text not null,         -- human label shown in the UI
  type        text not null default 'text'
              check (type in ('text','number','select','boolean','size')),
  options     text[],                -- fixed choices for type='select'
  vocab       text,                  -- controlled-vocab field name (alternative to options)
  required    boolean not null default false,
  inherit     boolean not null default true,
  sort        integer not null default 0,
  unique (category_id, key)
);
create index if not exists category_fields_cat_idx on public.category_fields (category_id);

-- ---------------------------------------------------------------------------
-- items: switch from fixed clothing columns to category_id + flexible JSONB.
-- ---------------------------------------------------------------------------
alter table public.items
  add column if not exists category_id uuid references public.categories(id),
  add column if not exists name        text,                            -- product name (e.g. perfume title)
  add column if not exists attributes  jsonb not null default '{}'::jsonb,
  add column if not exists confidence  jsonb not null default '{}'::jsonb;

-- Remove the clothing-specific fixed columns — now modeled as category_fields
-- and stored in attributes. (No data exists yet, so this is lossless.)
alter table public.items
  drop column if exists color,
  drop column if exists size,
  drop column if exists style,
  drop column if exists material,
  drop column if exists fit,
  drop column if exists conf_brand,
  drop column if exists conf_color,
  drop column if exists conf_size,
  drop column if exists conf_style,
  drop column if exists conf_category,
  drop column if exists category;         -- replaced by category_id

create index if not exists items_category_id_idx on public.items (category_id);
create index if not exists items_attributes_gin  on public.items using gin (attributes);

-- ===========================================================================
-- RLS for the new tables: everyone signed-in can read; only admins manage
-- categories/fields (the in-app field editor for editors is a later phase).
-- ===========================================================================
alter table public.categories     enable row level security;
alter table public.category_fields enable row level security;

drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories
  for select using (auth.role() = 'authenticated');

drop policy if exists categories_admin_write on public.categories;
create policy categories_admin_write on public.categories
  for all using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

drop policy if exists catfields_read on public.category_fields;
create policy catfields_read on public.category_fields
  for select using (auth.role() = 'authenticated');

drop policy if exists catfields_admin_write on public.category_fields;
create policy catfields_admin_write on public.category_fields
  for all using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');
