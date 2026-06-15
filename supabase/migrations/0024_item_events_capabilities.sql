-- =============================================================================
-- V2 work trail policy fix.
--
-- 0023 originally used current_user_role() for item_events. After the
-- capabilities migration, a custom user can have can_edit=true without the raw
-- role being editor/admin. Match the rest of the app's edit policies so activity
-- writes/readbacks work for every editor-capable account.
--
-- Run AFTER 0023. Idempotent.
-- =============================================================================

drop policy if exists item_events_read on public.item_events;
create policy item_events_read on public.item_events
  for select using (public.auth_can_edit());

drop policy if exists item_events_insert on public.item_events;
create policy item_events_insert on public.item_events
  for insert with check (public.auth_can_edit());

drop policy if exists item_events_delete on public.item_events;
create policy item_events_delete on public.item_events
  for delete using (public.auth_can_manage_users());
