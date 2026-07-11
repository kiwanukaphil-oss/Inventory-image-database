-- Production Advisor remediation.
--
-- 1. Keep SECURITY DEFINER authorization internals out of the exposed public
--    schema. Public wrappers remain SECURITY INVOKER so existing policies keep
--    stable function names without exposing privileged RPCs.
-- 2. Pin function search paths to prevent object-shadowing attacks.
-- 3. Make telemetry insertion active-user-only and optimize RLS init plans.
-- 4. Split FOR ALL manager policies so SELECT has one permissive policy.
-- 5. Add covering indexes for every currently unindexed foreign key.

begin;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

create or replace function private.current_user_role()
returns text
language sql stable security definer set search_path = ''
as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'viewer');
$$;

create or replace function private.auth_is_active()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select active from public.profiles where id = auth.uid()), false);
$$;

create or replace function private.auth_can_upload()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select can_upload and active from public.profiles where id = auth.uid()), false);
$$;

create or replace function private.auth_can_edit()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select can_edit and active from public.profiles where id = auth.uid()), false);
$$;

create or replace function private.auth_can_delete()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select can_delete and active from public.profiles where id = auth.uid()), false);
$$;

create or replace function private.auth_can_view_cost()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select can_view_cost and active from public.profiles where id = auth.uid()), false);
$$;

create or replace function private.auth_can_manage_users()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select can_manage_users and active from public.profiles where id = auth.uid()), false);
$$;

revoke all on function private.current_user_role() from public, anon;
revoke all on function private.auth_is_active() from public, anon;
revoke all on function private.auth_can_upload() from public, anon;
revoke all on function private.auth_can_edit() from public, anon;
revoke all on function private.auth_can_delete() from public, anon;
revoke all on function private.auth_can_view_cost() from public, anon;
revoke all on function private.auth_can_manage_users() from public, anon;
grant execute on function private.current_user_role() to authenticated;
grant execute on function private.auth_is_active() to authenticated;
grant execute on function private.auth_can_upload() to authenticated;
grant execute on function private.auth_can_edit() to authenticated;
grant execute on function private.auth_can_delete() to authenticated;
grant execute on function private.auth_can_view_cost() to authenticated;
grant execute on function private.auth_can_manage_users() to authenticated;

create or replace function public.current_user_role()
returns text language sql stable security invoker set search_path = ''
as $$ select private.current_user_role(); $$;
create or replace function public.auth_is_active()
returns boolean language sql stable security invoker set search_path = ''
as $$ select private.auth_is_active(); $$;
create or replace function public.auth_can_upload()
returns boolean language sql stable security invoker set search_path = ''
as $$ select private.auth_can_upload(); $$;
create or replace function public.auth_can_edit()
returns boolean language sql stable security invoker set search_path = ''
as $$ select private.auth_can_edit(); $$;
create or replace function public.auth_can_delete()
returns boolean language sql stable security invoker set search_path = ''
as $$ select private.auth_can_delete(); $$;
create or replace function public.auth_can_view_cost()
returns boolean language sql stable security invoker set search_path = ''
as $$ select private.auth_can_view_cost(); $$;
create or replace function public.auth_can_manage_users()
returns boolean language sql stable security invoker set search_path = ''
as $$ select private.auth_can_manage_users(); $$;

revoke all on function public.current_user_role() from public, anon;
revoke all on function public.auth_is_active() from public, anon;
revoke all on function public.auth_can_upload() from public, anon;
revoke all on function public.auth_can_edit() from public, anon;
revoke all on function public.auth_can_delete() from public, anon;
revoke all on function public.auth_can_view_cost() from public, anon;
revoke all on function public.auth_can_manage_users() from public, anon;
grant execute on function public.current_user_role() to authenticated;
grant execute on function public.auth_is_active() to authenticated;
grant execute on function public.auth_can_upload() to authenticated;
grant execute on function public.auth_can_edit() to authenticated;
grant execute on function public.auth_can_delete() to authenticated;
grant execute on function public.auth_can_view_cost() to authenticated;
grant execute on function public.auth_can_manage_users() to authenticated;

create or replace function private.item_cost_presence(item_ids uuid[])
returns table(item_id uuid, has_cost_price boolean)
language sql security definer set search_path = ''
as $$
  select i.id, coalesce(c.cost_price is not null, false)
  from public.items i
  left join public.item_costs c on c.item_id = i.id
  where i.id = any(item_ids)
    and private.auth_can_edit();
$$;
revoke all on function private.item_cost_presence(uuid[]) from public, anon;
grant execute on function private.item_cost_presence(uuid[]) to authenticated;

create or replace function public.item_cost_presence(item_ids uuid[])
returns table(item_id uuid, has_cost_price boolean)
language sql security invoker set search_path = ''
as $$ select * from private.item_cost_presence(item_ids); $$;
revoke all on function public.item_cost_presence(uuid[]) from public, anon;
grant execute on function public.item_cost_presence(uuid[]) to authenticated;

-- Trigger-only SECURITY DEFINER functions must not be callable as Data API RPCs.
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.items_audit() from public, anon, authenticated;

-- Pin every function reported by the production Security Advisor.
alter function public.sku_token(text, integer) set search_path = public, pg_temp;
alter function public.derive_item_sku(uuid, text, jsonb) set search_path = public, pg_temp;
alter function public.items_before_write() set search_path = public, pg_temp;
alter function public.mark_pos_dirty() set search_path = public, pg_temp;
alter function public.touch_item_job() set search_path = public, pg_temp;
alter function public.item_events_actor_default() set search_path = public, pg_temp;
alter function public.profiles_block_self_escalation() set search_path = public, pg_temp;
alter function public.scrub_cost_from_event() set search_path = public, pg_temp;
alter function public.audit_log_block_mutation() set search_path = public, pg_temp;
alter function public.client_errors_set_user() set search_path = public, pg_temp;

-- Telemetry remains write-only, but inactive or unauthenticated sessions cannot
-- create reports. The scalar subquery is evaluated once per statement.
drop policy if exists client_errors_insert on public.client_errors;
create policy client_errors_insert on public.client_errors
  for insert to authenticated
  with check ((select public.auth_is_active()));

-- Optimize the two remaining auth.uid()-based policies.
drop policy if exists profiles_self_read on public.profiles;
create policy profiles_self_read on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.auth_can_manage_users()));

drop policy if exists saved_views_own on public.saved_views;
create policy saved_views_own on public.saved_views
  for all to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

-- The branch-aware migration predates the init-plan optimization.
drop policy if exists pos_branches_read on public.pos_branches;
create policy pos_branches_read on public.pos_branches
  for select to authenticated using ((select public.auth_is_active()));
drop policy if exists pos_branch_stock_read on public.pos_branch_stock;
create policy pos_branch_stock_read on public.pos_branch_stock
  for select to authenticated using ((select public.auth_is_active()));

-- Split manager FOR ALL policies to avoid duplicate SELECT policy evaluation.
drop policy if exists app_settings_write on public.app_settings;
create policy app_settings_insert on public.app_settings for insert to authenticated
  with check ((select public.auth_can_manage_users()));
create policy app_settings_update on public.app_settings for update to authenticated
  using ((select public.auth_can_manage_users())) with check ((select public.auth_can_manage_users()));
create policy app_settings_delete on public.app_settings for delete to authenticated
  using ((select public.auth_can_manage_users()));

drop policy if exists categories_admin_write on public.categories;
create policy categories_admin_insert on public.categories for insert to authenticated
  with check ((select public.auth_can_manage_users()));
create policy categories_admin_update on public.categories for update to authenticated
  using ((select public.auth_can_manage_users())) with check ((select public.auth_can_manage_users()));
create policy categories_admin_delete on public.categories for delete to authenticated
  using ((select public.auth_can_manage_users()));

drop policy if exists catfields_admin_write on public.category_fields;
create policy catfields_admin_insert on public.category_fields for insert to authenticated
  with check ((select public.auth_can_manage_users()));
create policy catfields_admin_update on public.category_fields for update to authenticated
  using ((select public.auth_can_manage_users())) with check ((select public.auth_can_manage_users()));
create policy catfields_admin_delete on public.category_fields for delete to authenticated
  using ((select public.auth_can_manage_users()));

drop policy if exists pos_category_map_manage_write on public.pos_category_map;
create policy pos_category_map_manage_insert on public.pos_category_map for insert to authenticated
  with check ((select public.auth_can_manage_users()));
create policy pos_category_map_manage_update on public.pos_category_map for update to authenticated
  using ((select public.auth_can_manage_users())) with check ((select public.auth_can_manage_users()));
create policy pos_category_map_manage_delete on public.pos_category_map for delete to authenticated
  using ((select public.auth_can_manage_users()));

-- Cover every foreign key reported by the production Performance Advisor.
create index if not exists calibration_marks_actor_idx on public.calibration_marks(actor);
create index if not exists item_costs_updated_by_idx on public.item_costs(updated_by);
create index if not exists item_events_actor_idx on public.item_events(actor);
create index if not exists item_jobs_actor_idx on public.item_jobs(actor);
create index if not exists items_created_by_idx on public.items(created_by);
create index if not exists items_updated_by_idx on public.items(updated_by);

commit;
