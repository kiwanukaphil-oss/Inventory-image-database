-- =============================================================================
-- Enforce account deactivation in RLS + finish the role→capability migration.
--
--   S9  — profiles.active was shown in the UI but never enforced at the DB, so a
--         deactivated user with a still-valid JWT kept full access until expiry.
--         Fix: (a) an auth_is_active() helper; (b) bake `active` into the five
--         auth_can_* helpers so EVERY write/cost/manage path is deactivation-
--         aware; (c) add auth_is_active() to the broad "any authenticated may
--         read" policies. Service-role (the connector/edge fns) bypasses RLS, so
--         sync is unaffected. Self-reading one's own profile stays allowed so a
--         disabled user can still see their status.
--   S12 — calibration_marks + item_jobs still gated on current_user_role();
--         migrate them to the capability helpers (now active-aware), matching
--         0024. The `role` text column remains a human label only.
--
-- Run AFTER 0029. Idempotent.
--
-- ROLLBACK: restore the prior helper bodies (without `and active`) from 0008 and
--   re-create the policies below using their pre-0030 definitions (auth.role() =
--   'authenticated' for reads; current_user_role() for calibration/item_jobs);
--   drop function public.auth_is_active().
-- =============================================================================

-- (a) active helper
create or replace function public.auth_is_active() returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select active from public.profiles where id = auth.uid()), false); $$;

-- (b) bake active into the capability helpers (covers all writes + cost + manage,
--     and every read policy that already routes through these helpers, e.g.
--     item_costs, audit_log, item_events).
create or replace function public.auth_can_upload() returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select can_upload and active from public.profiles where id = auth.uid()), false); $$;

create or replace function public.auth_can_edit() returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select can_edit and active from public.profiles where id = auth.uid()), false); $$;

create or replace function public.auth_can_delete() returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select can_delete and active from public.profiles where id = auth.uid()), false); $$;

create or replace function public.auth_can_view_cost() returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select can_view_cost and active from public.profiles where id = auth.uid()), false); $$;

create or replace function public.auth_can_manage_users() returns boolean
  language sql stable security definer set search_path = public as
$$ select coalesce((select can_manage_users and active from public.profiles where id = auth.uid()), false); $$;

-- (c) add auth_is_active() to the broad authenticated-read policies.
drop policy if exists items_read on public.items;
create policy items_read on public.items
  for select using (auth.role() = 'authenticated' and public.auth_is_active());

drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories
  for select using (auth.role() = 'authenticated' and public.auth_is_active());

drop policy if exists catfields_read on public.category_fields;
create policy catfields_read on public.category_fields
  for select using (auth.role() = 'authenticated' and public.auth_is_active());

drop policy if exists vocab_read on public.vocabularies;
create policy vocab_read on public.vocabularies
  for select using (auth.role() = 'authenticated' and public.auth_is_active());

drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings
  for select using (auth.role() = 'authenticated' and public.auth_is_active());

drop policy if exists pos_category_map_read on public.pos_category_map;
create policy pos_category_map_read on public.pos_category_map
  for select using (auth.role() = 'authenticated' and public.auth_is_active());

drop policy if exists pos_stock_mirror_read on public.pos_stock_mirror;
create policy pos_stock_mirror_read on public.pos_stock_mirror
  for select using (auth.role() = 'authenticated' and public.auth_is_active());

drop policy if exists pos_sync_runs_read on public.pos_sync_runs;
create policy pos_sync_runs_read on public.pos_sync_runs
  for select using (auth.role() = 'authenticated' and public.auth_is_active());

drop policy if exists images_read on storage.objects;
create policy images_read on storage.objects
  for select using (bucket_id = 'product-images' and auth.role() = 'authenticated' and public.auth_is_active());

-- ---------------------------------------------------------------------------
-- S12 — calibration_marks + item_jobs: role → capability helpers.
-- ---------------------------------------------------------------------------
drop policy if exists calib_read on public.calibration_marks;
create policy calib_read on public.calibration_marks
  for select using (public.auth_can_edit());
drop policy if exists calib_insert on public.calibration_marks;
create policy calib_insert on public.calibration_marks
  for insert with check (public.auth_can_edit());
drop policy if exists calib_update on public.calibration_marks;
create policy calib_update on public.calibration_marks
  for update using (public.auth_can_edit()) with check (public.auth_can_edit());
drop policy if exists calib_delete on public.calibration_marks;
create policy calib_delete on public.calibration_marks
  for delete using (public.auth_can_delete());

drop policy if exists item_jobs_read on public.item_jobs;
create policy item_jobs_read on public.item_jobs
  for select using (public.auth_can_edit());
drop policy if exists item_jobs_insert on public.item_jobs;
create policy item_jobs_insert on public.item_jobs
  for insert with check (public.auth_can_edit());
drop policy if exists item_jobs_update on public.item_jobs;
create policy item_jobs_update on public.item_jobs
  for update using (public.auth_can_edit()) with check (public.auth_can_edit());
drop policy if exists item_jobs_delete on public.item_jobs;
create policy item_jobs_delete on public.item_jobs
  for delete using (public.auth_can_delete());
