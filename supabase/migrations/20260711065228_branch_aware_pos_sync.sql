-- =============================================================================
-- Branch-aware Catalog <-> POS synchronization.
--
-- Keeps pos_stock_mirror as the variant/global compatibility mirror and adds a
-- branch dimension for stock and movement-derived metrics. Existing catalog
-- rows remain valid: pos_branch_id is nullable until the first branch-aware
-- mirror/push run discovers the POS default branch and backfills them.
-- =============================================================================

begin;

create table if not exists public.pos_branches (
  pos_branch_id  uuid primary key,
  code           text not null unique,
  name           text not null,
  status         text not null check (status in ('active', 'inactive', 'opening', 'closed')),
  is_default     boolean not null default false,
  is_enabled     boolean not null default true,
  timezone       text,
  mirrored_at    timestamptz not null default now()
);

create unique index if not exists pos_branches_one_default_idx
  on public.pos_branches (is_default)
  where is_default = true;

create table if not exists public.pos_branch_stock (
  pos_branch_id    uuid not null references public.pos_branches(pos_branch_id) on delete cascade,
  pos_variant_id   uuid not null references public.pos_stock_mirror(pos_variant_id) on delete cascade,
  stock_quantity   integer not null default 0,
  reorder_level    integer,
  units_sold       integer not null default 0 check (units_sold >= 0),
  units_returned   integer not null default 0 check (units_returned >= 0),
  units_sold_today integer not null default 0 check (units_sold_today >= 0),
  units_sold_7d    integer not null default 0 check (units_sold_7d >= 0),
  mirrored_at      timestamptz not null default now(),
  primary key (pos_branch_id, pos_variant_id)
);

create index if not exists pos_branch_stock_variant_idx
  on public.pos_branch_stock (pos_variant_id);
create index if not exists pos_branch_stock_low_idx
  on public.pos_branch_stock (pos_branch_id, stock_quantity, reorder_level);

alter table public.pos_stock_mirror
  add column if not exists aggregate_stock_quantity integer;

alter table public.items
  add column if not exists pos_branch_id uuid
    references public.pos_branches(pos_branch_id) on delete restrict;

create index if not exists items_pos_branch_idx
  on public.items (pos_branch_id)
  where pos_branch_id is not null;

comment on table public.pos_branches is
  'Branches accessible to the POS catalog_sync account. The POS remains authoritative.';
comment on table public.pos_branch_stock is
  'Read-only branch/variant stock mirror written by pos-mirror via the service role.';
comment on column public.items.pos_branch_id is
  'POS destination branch for this item stock receipt; immutable after the receipt is synced.';

-- A posted stock receipt cannot be silently moved to another branch. Null ->
-- concrete branch remains allowed so the service role can backfill legacy rows.
create or replace function public.prevent_synced_item_branch_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.pos_branch_id is not null
     and new.pos_branch_id is distinct from old.pos_branch_id
     and old.pos_sync_status in ('pending', 'awaiting_approval', 'synced') then
    raise exception 'A synced POS receipt cannot be moved to another branch';
  end if;
  return new;
end;
$$;

drop trigger if exists items_pos_branch_immutable_after_sync on public.items;
create trigger items_pos_branch_immutable_after_sync
  before update of pos_branch_id on public.items
  for each row execute function public.prevent_synced_item_branch_change();

-- Explicit Data API grants are required by current Supabase defaults. Browser
-- clients only read these mirrors; Edge Functions write with the service role.
revoke all on table public.pos_branches from anon, authenticated;
revoke all on table public.pos_branch_stock from anon, authenticated;
grant select on table public.pos_branches to authenticated;
grant select on table public.pos_branch_stock to authenticated;
grant all on table public.pos_branches to service_role;
grant all on table public.pos_branch_stock to service_role;

alter table public.pos_branches enable row level security;
alter table public.pos_branch_stock enable row level security;

drop policy if exists pos_branches_read on public.pos_branches;
create policy pos_branches_read on public.pos_branches
  for select to authenticated
  using (public.auth_is_active());

drop policy if exists pos_branch_stock_read on public.pos_branch_stock;
create policy pos_branch_stock_read on public.pos_branch_stock
  for select to authenticated
  using (public.auth_is_active());

commit;
