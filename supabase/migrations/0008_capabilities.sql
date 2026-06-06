-- =============================================================================
-- Capability-based permissions
--
-- Moves access control from 3 fixed roles to per-user capability switches, so a
-- person can (for example) upload + edit but not delete or see cost. The `role`
-- column stays as a human label / preset; the capability columns are the source
-- of truth that RLS enforces.
--
-- Capabilities:
--   can_upload        – add photos / create items (+ upload to storage)
--   can_edit          – edit item fields, vocab, run AI-fill
--   can_delete        – delete items (+ their images)
--   can_view_cost     – read & write the admin-only cost table
--   can_manage_users  – manage people's roles/capabilities + the category config
--
-- Run AFTER 0007. Idempotent.
-- =============================================================================

-- 1. Capability columns (default false → new users get nothing until granted).
alter table public.profiles
  add column if not exists can_upload       boolean not null default false,
  add column if not exists can_edit         boolean not null default false,
  add column if not exists can_delete       boolean not null default false,
  add column if not exists can_view_cost    boolean not null default false,
  add column if not exists can_manage_users boolean not null default false;

-- Allow a 'custom' role label for users whose caps don't match a preset.
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check check (role in ('admin','editor','viewer','custom'));

-- 2. Backfill capabilities from existing roles.
update public.profiles set
  can_upload       = role in ('admin','editor'),
  can_edit         = role in ('admin','editor'),
  can_delete       = role = 'admin',
  can_view_cost    = role = 'admin',
  can_manage_users = role = 'admin';

-- 3. Capability helper functions (SECURITY DEFINER so RLS can read profiles).
create or replace function public.auth_can_upload() returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select can_upload from profiles where id = auth.uid()), false); $$;

create or replace function public.auth_can_edit() returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select can_edit from profiles where id = auth.uid()), false); $$;

create or replace function public.auth_can_delete() returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select can_delete from profiles where id = auth.uid()), false); $$;

create or replace function public.auth_can_view_cost() returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select can_view_cost from profiles where id = auth.uid()), false); $$;

create or replace function public.auth_can_manage_users() returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select can_manage_users from profiles where id = auth.uid()), false); $$;

-- 4. Rewrite RLS to use capabilities instead of role.

-- items: read = any authenticated; write/delete by capability.
drop policy if exists items_insert on public.items;
create policy items_insert on public.items
  for insert with check (public.auth_can_upload());

drop policy if exists items_update on public.items;
create policy items_update on public.items
  for update using (public.auth_can_edit()) with check (public.auth_can_edit());

drop policy if exists items_delete on public.items;
create policy items_delete on public.items
  for delete using (public.auth_can_delete());

-- item_costs: only users who can view cost (covers read + write).
drop policy if exists costs_admin_all on public.item_costs;
create policy costs_cap_all on public.item_costs
  for all using (public.auth_can_view_cost()) with check (public.auth_can_view_cost());

-- storage: upload needs can_upload; delete needs can_delete.
drop policy if exists images_insert on storage.objects;
create policy images_insert on storage.objects
  for insert with check (bucket_id = 'product-images' and public.auth_can_upload());

drop policy if exists images_delete on storage.objects;
create policy images_delete on storage.objects
  for delete using (bucket_id = 'product-images' and public.auth_can_delete());

-- vocabularies: add new values when you can edit; manage/delete needs user mgmt.
drop policy if exists vocab_insert on public.vocabularies;
create policy vocab_insert on public.vocabularies
  for insert with check (public.auth_can_edit());
drop policy if exists vocab_write on public.vocabularies;
create policy vocab_write on public.vocabularies
  for update using (public.auth_can_manage_users()) with check (public.auth_can_manage_users());
drop policy if exists vocab_delete on public.vocabularies;
create policy vocab_delete on public.vocabularies
  for delete using (public.auth_can_manage_users());

-- categories / category_fields: managed by user managers.
drop policy if exists categories_admin_write on public.categories;
create policy categories_admin_write on public.categories
  for all using (public.auth_can_manage_users()) with check (public.auth_can_manage_users());
drop policy if exists catfields_admin_write on public.category_fields;
create policy catfields_admin_write on public.category_fields
  for all using (public.auth_can_manage_users()) with check (public.auth_can_manage_users());

-- audit log: readable by anyone who can edit.
drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log
  for select using (public.auth_can_edit());

-- profiles: read own row, or any if you manage users; update needs user mgmt.
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select using (id = auth.uid() or public.auth_can_manage_users());

drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_manage_write on public.profiles
  for update using (public.auth_can_manage_users()) with check (public.auth_can_manage_users());
