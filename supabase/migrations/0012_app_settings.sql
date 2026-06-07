-- =============================================================================
-- Shop-wide settings (key/value), shared across devices. First use: currency
-- prefix shown before prices. Readable by anyone signed in; writable by people
-- with "Manage users".
-- Run AFTER 0011. Idempotent.
-- =============================================================================

create table if not exists public.app_settings (
  key   text primary key,
  value text
);

alter table public.app_settings enable row level security;

drop policy if exists app_settings_read on public.app_settings;
create policy app_settings_read on public.app_settings
  for select using (auth.role() = 'authenticated');

drop policy if exists app_settings_write on public.app_settings;
create policy app_settings_write on public.app_settings
  for all using (public.auth_can_manage_users())
  with check (public.auth_can_manage_users());

insert into public.app_settings (key, value) values ('currency', '')
on conflict (key) do nothing;
