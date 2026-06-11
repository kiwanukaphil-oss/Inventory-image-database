-- =============================================================================
-- POS integration link layer (Phase 0)
--
-- Connects the catalog to the separate inventory-pos-system. Two pieces:
--   1. items gains pos_* columns so each catalog item remembers which POS
--      product/variant it became, when it last synced, and the outcome.
--      The POS is the system of record for stock; these columns are just the
--      catalog's side of the link (set by the connector via the service role).
--   2. pos_category_map is the deliberate, human-confirmed bridge between this
--      catalog's category tree and the POS's. We do NOT keep the two trees in
--      sync structurally — each system models categories for its own job
--      (here: which fields the AI extracts; there: tax rules + reporting).
--      The map is the contract; an unmapped category blocks that item's push
--      loudly rather than guessing.
--
-- The connector authenticates to Supabase with the service role, so it bypasses
-- RLS for reads/writes here. The policies below only govern the in-app UI.
--
-- Run AFTER 0014. Idempotent.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Link columns on items.
--    pos_sync_status is left NULL for "not yet considered". The connector
--    treats (status = 'approved' AND pos_sync_status IS NULL/'error') as the
--    push queue. 'awaiting_approval' captures the POS's 202 pending-approval
--    response on the stock-receipt step so the UI can show that limbo state.
-- ---------------------------------------------------------------------------
alter table public.items
  add column if not exists pos_product_id  uuid,
  add column if not exists pos_variant_id  uuid,
  add column if not exists pos_sku         text,        -- SKU as accepted by the POS (uppercased), for cross-reference
  add column if not exists pos_synced_at   timestamptz,
  add column if not exists pos_sync_status text
    check (pos_sync_status in ('pending','synced','error','awaiting_approval')),
  add column if not exists pos_sync_error  text;        -- last failure reason, surfaced in the Review UI

-- Connector poll query filters on this; partial-ish index keeps it cheap.
create index if not exists items_pos_sync_status_idx on public.items (pos_sync_status);

-- ---------------------------------------------------------------------------
-- 2. Category mapping bridge. One catalog category maps to exactly one POS
--    category (unique image_category_id). The reverse is intentionally not
--    unique: this catalog may be more granular than the POS, so several
--    catalog categories can fold into one POS category.
--    pos_category_id has no FK — it lives in a different database. The label
--    snapshot makes the map readable for admins and lets the Phase 3
--    reconciliation check spot POS categories that were renamed/deleted.
-- ---------------------------------------------------------------------------
create table if not exists public.pos_category_map (
  id                uuid primary key default gen_random_uuid(),
  image_category_id uuid not null unique references public.categories(id) on delete cascade,
  pos_category_id   uuid not null,
  pos_category_label text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists pos_category_map_image_cat_idx on public.pos_category_map (image_category_id);

alter table public.pos_category_map enable row level security;

-- Read: any signed-in user (so the gallery/review UI can show mapping state).
drop policy if exists pos_category_map_read on public.pos_category_map;
create policy pos_category_map_read on public.pos_category_map
  for select using (auth.role() = 'authenticated');

-- Write: same gate as categories/category_fields — user managers only.
drop policy if exists pos_category_map_manage_write on public.pos_category_map;
create policy pos_category_map_manage_write on public.pos_category_map
  for all using (public.auth_can_manage_users())
  with check (public.auth_can_manage_users());
