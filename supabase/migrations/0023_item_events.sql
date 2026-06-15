-- =============================================================================
-- V2 work trail: source-aware item activity events.
--
-- audit_log already records field-level before/after changes through triggers,
-- but it cannot tell whether the change came from AI, manual review, pricing,
-- approval, or bulk tools. item_events adds that operational provenance so
-- Review can show "AI filled", "Manual edit", "Mixed", and "Recently edited".
--
-- Run AFTER 0022. Idempotent.
-- =============================================================================

create table if not exists public.item_events (
  id            bigserial primary key,
  item_id       uuid references public.items(id) on delete cascade,
  event_type    text not null check (event_type in (
    'upload',
    'ai_fill',
    'manual_edit',
    'bulk_edit',
    'pricing',
    'approval',
    'undo',
    'shop_sync',
    'delete'
  )),
  source        text not null check (source in (
    'upload',
    'ai',
    'manual',
    'bulk',
    'pricing',
    'approval',
    'undo',
    'shop',
    'system'
  )),
  field_path    text,
  before_value  jsonb,
  after_value   jsonb,
  summary       text,
  actor         uuid references auth.users(id),
  created_at    timestamptz not null default now()
);

create index if not exists item_events_item_time_idx
  on public.item_events (item_id, created_at desc);

create index if not exists item_events_source_time_idx
  on public.item_events (source, created_at desc);

create index if not exists item_events_type_time_idx
  on public.item_events (event_type, created_at desc);

create or replace function public.item_events_actor_default()
returns trigger
language plpgsql
as $$
begin
  if new.actor is null then
    new.actor := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists item_events_actor on public.item_events;
create trigger item_events_actor
  before insert on public.item_events
  for each row execute function public.item_events_actor_default();

alter table public.item_events enable row level security;

drop policy if exists item_events_read on public.item_events;
create policy item_events_read on public.item_events
  for select using (public.current_user_role() in ('editor','admin'));

drop policy if exists item_events_insert on public.item_events;
create policy item_events_insert on public.item_events
  for insert with check (public.current_user_role() in ('editor','admin'));

drop policy if exists item_events_delete on public.item_events;
create policy item_events_delete on public.item_events
  for delete using (public.current_user_role() = 'admin');
