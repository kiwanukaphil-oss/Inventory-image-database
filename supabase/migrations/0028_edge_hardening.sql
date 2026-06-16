-- =============================================================================
-- Phase 0 edge-function hardening support tables.
--
--   S6  — ai_usage: per-user call ledger so ai-extract can rate-limit the paid
--         Anthropic endpoint (per-hour + per-day caps) and bound abuse/cost.
--   DI1 — pos_sync_locks + try_acquire_sync_lock()/release_sync_lock(): an
--         atomic, stale-tolerant run lock so two concurrent pos-push runs
--         (cron + manual "Sync now") can't both book a stock receipt.
--
-- Both tables are SERVICE-ROLE ONLY: RLS is enabled with NO policies, so
-- authenticated/anon callers get zero access; the edge functions reach them via
-- the service-role key (which bypasses RLS). Run AFTER 0027. Idempotent.
--
-- ROLLBACK:
--   drop function public.try_acquire_sync_lock(text,int,text);
--   drop function public.release_sync_lock(text);
--   drop table public.pos_sync_locks;
--   drop table public.ai_usage;
-- =============================================================================

-- ---------------------------------------------------------------------------
-- S6 — AI usage ledger (one row per ai-extract attempt).
-- ---------------------------------------------------------------------------
create table if not exists public.ai_usage (
  id         bigserial primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists ai_usage_user_time_idx on public.ai_usage (user_id, created_at desc);
create index if not exists ai_usage_time_idx       on public.ai_usage (created_at desc);

alter table public.ai_usage enable row level security;  -- no policies = no row access
-- Belt-and-suspenders: also revoke table privileges so clients get a hard
-- "permission denied" rather than a silent empty result. Service role bypasses.
revoke all on public.ai_usage from anon, authenticated;


-- ---------------------------------------------------------------------------
-- DI1 — Cross-run lock for pos-push (and any future single-flight loop).
-- ---------------------------------------------------------------------------
create table if not exists public.pos_sync_locks (
  name       text primary key,
  locked_at  timestamptz not null default now(),
  locked_by  text
);
alter table public.pos_sync_locks enable row level security;  -- service-role only
revoke all on public.pos_sync_locks from anon, authenticated;

-- Atomic acquire: insert the lock, or steal it only if the existing one is
-- older than p_stale_seconds (guards against a crashed run holding it forever).
-- Returns true iff this caller now holds the lock. The whole thing is ONE
-- statement, so two concurrent callers cannot both win.
create or replace function public.try_acquire_sync_lock(p_name text, p_stale_seconds int, p_by text)
returns boolean
language plpgsql
security definer set search_path = public
as $$
declare got boolean;
begin
  insert into public.pos_sync_locks (name, locked_at, locked_by)
  values (p_name, now(), p_by)
  on conflict (name) do update
    set locked_at = now(), locked_by = excluded.locked_by
    where public.pos_sync_locks.locked_at < now() - make_interval(secs => p_stale_seconds)
  returning true into got;
  return coalesce(got, false);
end;
$$;

create or replace function public.release_sync_lock(p_name text)
returns void
language sql
security definer set search_path = public
as $$
  delete from public.pos_sync_locks where name = p_name;
$$;

-- These run as the definer (postgres); only the service role (the edge function)
-- should call them. Revoke the default PUBLIC execute, then grant service_role
-- back explicitly (it loses the PUBLIC grant too).
revoke all on function public.try_acquire_sync_lock(text,int,text) from public, anon, authenticated;
revoke all on function public.release_sync_lock(text)              from public, anon, authenticated;
grant execute on function public.try_acquire_sync_lock(text,int,text) to service_role;
grant execute on function public.release_sync_lock(text)              to service_role;
