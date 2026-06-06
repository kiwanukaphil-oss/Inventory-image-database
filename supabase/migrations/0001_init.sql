-- =============================================================================
-- Inventory Image Review — Phase 1 schema
-- profiles + items + item_costs, with the role-based, cost-isolating security
-- model. Run this in the Supabase SQL editor (or via the Supabase CLI).
--
-- SECURITY MODEL (the crux):
--   * cost_price lives ONLY in item_costs (never in items), so any SELECT on
--     items is physically incapable of leaking cost.
--   * item_costs has RLS allowing access only to admins. A non-admin querying
--     it through the API gets ZERO rows, not an error and not data.
--   * Roles come from profiles.role, read via a SECURITY DEFINER helper so the
--     policy can consult profiles without tripping RLS recursion.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- profiles: one row per auth user, holding the access role.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  role       text not null default 'viewer'
             check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now()
);

-- Auto-create a profile (defaulting to 'viewer') whenever a new auth user signs
-- up, so the app always has a role to read. Admins promote users afterwards.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Role helper: SECURITY DEFINER so it can read profiles regardless of the
-- caller's RLS, returning the current user's role (or 'viewer' if unknown).
create or replace function public.current_user_role()
returns text
language sql
stable
security definer set search_path = public
as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'viewer');
$$;

-- ---------------------------------------------------------------------------
-- items: one row per product image / variant. NO cost column here.
-- ---------------------------------------------------------------------------
create table if not exists public.items (
  id                uuid primary key default gen_random_uuid(),
  category          text,
  brand             text,
  color             text,
  size              text,
  style             text,
  material          text,
  fit               text,
  price             numeric(10,2),          -- retail price: visible to all roles
  stock_quantity    integer,
  reorder_level     integer,
  sku               text,                   -- derived (trigger added in a later migration)
  status            text not null default 'needs-review'
                    check (status in ('draft', 'needs-review', 'approved', 'flag')),
  image_path        text,                   -- object path in the product-images bucket
  original_filename text,
  conf_brand        text check (conf_brand    in ('High','Medium','Low')),
  conf_color        text check (conf_color    in ('High','Medium','Low')),
  conf_size         text check (conf_size     in ('High','Medium','Low')),
  conf_style        text check (conf_style    in ('High','Medium','Low')),
  conf_category     text check (conf_category in ('High','Medium','Low')),
  created_by        uuid references auth.users(id),
  updated_by        uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists items_category_idx on public.items (category);
create index if not exists items_status_idx   on public.items (status);

-- ---------------------------------------------------------------------------
-- item_costs: the sensitive cost data, isolated for admin-only access.
-- ---------------------------------------------------------------------------
create table if not exists public.item_costs (
  item_id    uuid primary key references public.items(id) on delete cascade,
  cost_price numeric(10,2),
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

-- ===========================================================================
-- Row Level Security
-- ===========================================================================
alter table public.profiles   enable row level security;
alter table public.items      enable row level security;
alter table public.item_costs enable row level security;

-- profiles: a user can read their own row; admins can read/manage all.
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select using (id = auth.uid() or public.current_user_role() = 'admin');

drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles
  for update using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

-- items: any signed-in user may read; editors/admins may write; admins delete.
drop policy if exists items_read on public.items;
create policy items_read on public.items
  for select using (auth.role() = 'authenticated');

drop policy if exists items_insert on public.items;
create policy items_insert on public.items
  for insert with check (public.current_user_role() in ('editor','admin'));

drop policy if exists items_update on public.items;
create policy items_update on public.items
  for update using (public.current_user_role() in ('editor','admin'))
  with check (public.current_user_role() in ('editor','admin'));

drop policy if exists items_delete on public.items;
create policy items_delete on public.items
  for delete using (public.current_user_role() = 'admin');

-- item_costs: ADMIN ONLY for every operation. Non-admins get zero rows.
drop policy if exists costs_admin_all on public.item_costs;
create policy costs_admin_all on public.item_costs
  for all using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

-- ===========================================================================
-- Storage bucket for product images (private; access via signed URLs).
-- ===========================================================================
insert into storage.buckets (id, name, public)
values ('product-images', 'product-images', false)
on conflict (id) do nothing;

-- Authenticated users may read and upload images; only admins may delete.
drop policy if exists images_read on storage.objects;
create policy images_read on storage.objects
  for select using (bucket_id = 'product-images' and auth.role() = 'authenticated');

drop policy if exists images_insert on storage.objects;
create policy images_insert on storage.objects
  for insert with check (
    bucket_id = 'product-images'
    and public.current_user_role() in ('editor','admin')
  );

drop policy if exists images_delete on storage.objects;
create policy images_delete on storage.objects
  for delete using (
    bucket_id = 'product-images' and public.current_user_role() = 'admin'
  );
