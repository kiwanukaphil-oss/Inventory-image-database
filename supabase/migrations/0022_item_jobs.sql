-- =============================================================================
-- V2 recovery foundation: persistent item-level automation jobs.
--
-- item_jobs records recoverable automation outcomes such as AI-fill failures.
-- The first V2 use is "AI failed for this item" so Review can keep the item in
-- an actionable queue after the modal/toast is gone. Later V2 work can reuse
-- the table for upload, shop sync, and pricing jobs.
--
-- Run AFTER 0021. Idempotent.
-- =============================================================================

create table if not exists public.item_jobs (
  id             bigserial primary key,
  item_id        uuid references public.items(id) on delete cascade,
  job_type       text not null check (job_type in ('ai_fill','upload','shop_sync','pricing')),
  status         text not null check (status in ('pending','running','succeeded','failed','dismissed')),
  error_category text,
  error_message  text,
  attempt_count  integer not null default 1,
  actor          uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  resolved_at    timestamptz
);

create index if not exists item_jobs_item_status_idx
  on public.item_jobs (item_id, job_type, status, updated_at desc);

create index if not exists item_jobs_status_idx
  on public.item_jobs (job_type, status, updated_at desc);

create or replace function public.touch_item_job()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if new.actor is null then
    new.actor := auth.uid();
  end if;
  if new.status in ('succeeded','dismissed') and new.resolved_at is null then
    new.resolved_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists item_jobs_touch on public.item_jobs;
create trigger item_jobs_touch
  before insert or update on public.item_jobs
  for each row execute function public.touch_item_job();

alter table public.item_jobs enable row level security;

drop policy if exists item_jobs_read on public.item_jobs;
create policy item_jobs_read on public.item_jobs
  for select using (public.current_user_role() in ('editor','admin'));

drop policy if exists item_jobs_insert on public.item_jobs;
create policy item_jobs_insert on public.item_jobs
  for insert with check (public.current_user_role() in ('editor','admin'));

drop policy if exists item_jobs_update on public.item_jobs;
create policy item_jobs_update on public.item_jobs
  for update using (public.current_user_role() in ('editor','admin'))
  with check (public.current_user_role() in ('editor','admin'));

drop policy if exists item_jobs_delete on public.item_jobs;
create policy item_jobs_delete on public.item_jobs
  for delete using (public.current_user_role() = 'admin');
