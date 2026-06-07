-- =============================================================================
-- Cloud-synced saved views for the Find tab. Each user's saved views follow them
-- across devices (per-user; owner = auth.uid()). Replaces the previous
-- per-device localStorage storage.
-- Run AFTER 0012. Idempotent.
-- =============================================================================

create table if not exists public.saved_views (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name       text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists saved_views_owner_idx on public.saved_views(owner);

alter table public.saved_views enable row level security;

-- A user fully manages their own saved views; no one else can see them.
drop policy if exists saved_views_own on public.saved_views;
create policy saved_views_own on public.saved_views
  for all using (owner = auth.uid())
  with check (owner = auth.uid());
