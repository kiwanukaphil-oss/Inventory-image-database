-- =============================================================================
-- Client/runtime error sink (audit P4).
--
-- A durable place for browser errors (window.onerror / unhandledrejection / the
-- app's renderError path) so field failures on phones aren't invisible. Decided
-- over an external vendor (Sentry) to keep everything in-stack.
--
-- Write-only for normal users (a sink): authenticated callers INSERT; only
-- user-managers/admins can READ (reports may contain context worth protecting);
-- nobody updates/deletes via the API. user_id is forced to the caller so it
-- can't be spoofed. Run AFTER 0028. Idempotent.
--
-- ROLLBACK:
--   drop trigger client_errors_user on public.client_errors;
--   drop function public.client_errors_set_user();
--   drop table public.client_errors;
-- =============================================================================

create table if not exists public.client_errors (
  id          bigserial primary key,
  occurred_at timestamptz not null default now(),
  user_id     uuid references auth.users(id) on delete set null,
  context     text,                       -- where it happened (e.g. "window.onerror")
  message     text,
  stack       text,
  url         text,
  user_agent  text,
  app_version text,
  severity    text not null default 'error' check (severity in ('error','warning','info'))
);
create index if not exists client_errors_time_idx on public.client_errors (occurred_at desc);
create index if not exists client_errors_user_idx on public.client_errors (user_id, occurred_at desc);

alter table public.client_errors enable row level security;

-- Stamp the caller; clients can't attribute a report to someone else.
create or replace function public.client_errors_set_user()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null then new.user_id := auth.uid(); end if;
  return new;
end;
$$;
drop trigger if exists client_errors_user on public.client_errors;
create trigger client_errors_user before insert on public.client_errors
  for each row execute function public.client_errors_set_user();

-- Authenticated users may file reports (write-only sink); managers read; the
-- absence of update/delete policies + the REVOKE below keeps it append-only.
drop policy if exists client_errors_insert on public.client_errors;
create policy client_errors_insert on public.client_errors
  for insert to authenticated with check (true);

drop policy if exists client_errors_read on public.client_errors;
create policy client_errors_read on public.client_errors
  for select using (public.auth_can_manage_users());

revoke update, delete on public.client_errors from anon, authenticated;

-- Retention: prune periodically (e.g. keep 90 days). Run manually for now:
--   delete from public.client_errors where occurred_at < now() - interval '90 days';
