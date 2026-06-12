-- =============================================================================
-- POS live-stock mirror (Phase 2a of the integration — see
-- inventory-pos-connector/EXPERIENCE-PLAN.md).
--
-- Three pieces:
--   1. pos_stock_mirror — one row per POS *variant* (not per item: several
--      duplicate-SKU catalog items share one variant, and stock is a property
--      of the variant). Written ONLY by the pos-mirror edge function via the
--      service role; the PWA reads it to show "In shop · N left" chips and the
--      Shop reports. Strictly a read-only mirror — the POS owns every value.
--   2. pos_sync_runs — append-only heartbeat log, one row per connector run
--      (mirror/push/reconcile). Powers the "Shop data as of 14:32" freshness
--      line; a missing recent row means the sync is DOWN, not idle.
--   3. items.pos_dirty — set by trigger when an identity field changes on an
--      already-synced item, so the UI can show "✎ Update pending" until
--      Phase 3 edit-propagation pushes the change to the POS.
--
-- Run AFTER 0017. Idempotent.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. The stock mirror. pos_variant_id matches items.pos_variant_id (no FK —
--    it identifies a row in the POS's own database). units_sold is GROSS sale
--    units and units_returned is return units — both computed from the POS
--    stock_movements ledger; net sold = units_sold - units_returned.
--    is_active=false marks a variant retired in the POS ("no longer sold")
--    rather than deleting the row, so the UI can say so.
-- ---------------------------------------------------------------------------
create table if not exists public.pos_stock_mirror (
  pos_variant_id uuid primary key,
  pos_sku        text not null,
  product_name   text,
  brand_name     text,
  price          numeric,          -- CURRENT selling price (POS-owned; may differ from items.price after markdowns)
  stock_quantity integer not null default 0,
  reorder_level  integer,          -- the POS's own low-stock threshold for this variant
  units_sold     integer not null default 0,
  units_returned integer not null default 0,
  is_active      boolean not null default true,
  mirrored_at    timestamptz not null default now()
);
create index if not exists pos_stock_mirror_sku_idx on public.pos_stock_mirror (pos_sku);

alter table public.pos_stock_mirror enable row level security;

-- Read: any signed-in user (stock chips/reports are floor-level data; money
-- visibility is handled in the UI per the locked decision — revenue figures
-- only render for cost-capable users, but the raw mirror is not a secret).
drop policy if exists pos_stock_mirror_read on public.pos_stock_mirror;
create policy pos_stock_mirror_read on public.pos_stock_mirror
  for select using (auth.role() = 'authenticated');
-- No insert/update/delete policies: only the service-role mirror writes here.

-- ---------------------------------------------------------------------------
-- 2. Sync-run heartbeat log. Every loop run inserts exactly one row, even
--    when there was nothing to do — silence means broken. summary carries
--    per-run counts (variants seen, movements scanned, etc.) for the Sync
--    Center; error holds the failure message when ok=false.
-- ---------------------------------------------------------------------------
create table if not exists public.pos_sync_runs (
  id          bigint generated always as identity primary key,
  kind        text not null check (kind in ('mirror','push','reconcile')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  ok_count    integer not null default 0,
  error_count integer not null default 0,
  summary     jsonb,
  error       text
);
create index if not exists pos_sync_runs_kind_idx on public.pos_sync_runs (kind, started_at desc);

alter table public.pos_sync_runs enable row level security;

drop policy if exists pos_sync_runs_read on public.pos_sync_runs;
create policy pos_sync_runs_read on public.pos_sync_runs
  for select using (auth.role() = 'authenticated');
-- Writes: service role only (no policies).

-- ---------------------------------------------------------------------------
-- 3. Post-push edit detection. Identity fields are Catalog-owned and flow
--    Catalog → POS; until edit-propagation ships (Phase 3) an edit to a
--    synced item silently diverges from the POS. The trigger makes that
--    divergence VISIBLE the moment it happens. The connector clears the flag
--    when it propagates the update.
--    Note: price is deliberately NOT watched — after push the POS owns price.
-- ---------------------------------------------------------------------------
alter table public.items
  add column if not exists pos_dirty boolean not null default false;

create or replace function public.mark_pos_dirty()
returns trigger
language plpgsql
as $$
begin
  -- Only items actually in the POS can go stale there.
  if old.pos_sync_status = 'synced' and (
       new.name           is distinct from old.name
    or new.brand          is distinct from old.brand
    or new.category_id    is distinct from old.category_id
    or new.attributes     is distinct from old.attributes
    or new.image_path     is distinct from old.image_path
  ) then
    new.pos_dirty := true;
  end if;
  return new;
end;
$$;

drop trigger if exists items_mark_pos_dirty on public.items;
create trigger items_mark_pos_dirty
  before update on public.items
  for each row execute function public.mark_pos_dirty();
