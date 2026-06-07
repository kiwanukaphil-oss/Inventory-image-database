-- =============================================================================
-- Add an "active" flag to profiles so the in-app Users screen can show / toggle
-- account status. Deactivating also bans the login at the auth layer (done by
-- the manage-users Edge Function); this column mirrors it for the UI.
-- Run AFTER 0013. Idempotent.
-- =============================================================================

alter table public.profiles add column if not exists active boolean not null default true;
