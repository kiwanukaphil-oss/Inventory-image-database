-- Minimal Supabase-compatible stubs so the real migrations can be applied to a
-- plain Postgres for OFFLINE validation/tests. NOT for production.
--
-- Usage: see supabase/tests/README.md. In short:
--   docker run -d --name pg_test -e POSTGRES_PASSWORD=test postgres:17
--   (copy this repo's supabase/ in, then)
--   psql -f _stubs.sql ; apply migrations/0001..NNNN in order ; psql -f *.test.sql
create extension if not exists pgcrypto;

do $$ begin
  if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select from pg_roles where rolname='service_role') then create role service_role bypassrls; end if;
end $$;

-- auth schema: uid()/role() are driven by session settings so tests can simulate
-- different callers (select set_config('test.uid', '<uuid>', false); set role authenticated).
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.uid', true), '')::uuid;
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('test.role', true), ''), 'authenticated');
$$;

-- storage schema: enough for the bucket + object policies.
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean default false);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text, name text, owner uuid, created_at timestamptz default now()
);
alter table storage.objects enable row level security;

-- Mirror Supabase's default grants: DML to authenticated/anon (RLS then restricts),
-- and USAGE/EXECUTE on the auth schema so non-SECURITY-DEFINER triggers can call auth.uid().
grant usage on schema public, storage, auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;
grant all on all tables in schema public  to anon, authenticated, service_role;
grant all on all tables in schema storage to anon, authenticated, service_role;
alter default privileges in schema public  grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema storage grant all on tables    to anon, authenticated, service_role;
