-- Replace deprecated auth.role() predicates with explicit policy role targets.
-- `TO authenticated` selects the Postgres API role; auth_is_active() remains
-- the authorization predicate. This is safe if anonymous sign-ins are enabled
-- later because authorization no longer depends on the JWT's `role` claim.

drop policy if exists items_read on public.items;
create policy items_read on public.items
  for select to authenticated using ((select public.auth_is_active()));

drop policy if exists categories_read on public.categories;
create policy categories_read on public.categories
  for select to authenticated using ((select public.auth_is_active()));

drop policy if exists catfields_read on public.category_fields;
create policy catfields_read on public.category_fields
  for select to authenticated using ((select public.auth_is_active()));

drop policy if exists vocab_read on public.vocabularies;
create policy vocab_read on public.vocabularies
  for select to authenticated using ((select public.auth_is_active()));

drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings
  for select to authenticated using ((select public.auth_is_active()));

drop policy if exists pos_category_map_read on public.pos_category_map;
create policy pos_category_map_read on public.pos_category_map
  for select to authenticated using ((select public.auth_is_active()));

drop policy if exists pos_stock_mirror_read on public.pos_stock_mirror;
create policy pos_stock_mirror_read on public.pos_stock_mirror
  for select to authenticated using ((select public.auth_is_active()));

drop policy if exists pos_sync_runs_read on public.pos_sync_runs;
create policy pos_sync_runs_read on public.pos_sync_runs
  for select to authenticated using ((select public.auth_is_active()));

drop policy if exists images_read on storage.objects;
create policy images_read on storage.objects
  for select to authenticated
  using (bucket_id = 'product-images' and (select public.auth_is_active()));
