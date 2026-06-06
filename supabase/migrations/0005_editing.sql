-- =============================================================================
-- Phase 3 — editing infrastructure
--   * SKU auto-derivation trigger (matches the legacy TYPE-BRAND-COLOR-SIZE rule)
--   * updated_at / updated_by / created_by maintenance
--   * audit_log table + trigger (field-level change history)
--   * vocabularies table (controlled values + alias normalization)
-- Run AFTER 0004. Idempotent.
-- =============================================================================

-- Per-category SKU token (e.g. Flat-front -> FLATFRONT). Falls back to the
-- category name if not set. Lets us reproduce the existing SKU prefixes exactly.
alter table public.categories add column if not exists sku_token text;

update public.categories set sku_token = v.token
from (values
  ('pants-cargo','CARGO'), ('pants-khaki','KHAKI'), ('pants-formal','FORMAL'),
  ('pants-linen','LINEN'), ('pants-flat-front','FLATFRONT'), ('pants-relaxed','RELAXED')
) as v(slug, token)
where public.categories.slug = v.slug;

-- ---------------------------------------------------------------------------
-- SKU helpers
-- ---------------------------------------------------------------------------
-- Uppercase, strip non-alphanumerics, truncate. ("Dark Blue",8) -> "DARKBLUE".
create or replace function public.sku_token(txt text, maxlen int)
returns text language sql immutable as $$
  select left(regexp_replace(upper(coalesce(txt, '')), '[^A-Z0-9]', '', 'g'), maxlen);
$$;

-- Build TYPE-BRAND-COLOR-SIZE from a category + brand + attributes.
-- Brand max 10, colour max 8 (matching the legacy data). Size falls back across
-- the size-like keys used by other categories (size_eu, volume_ml).
create or replace function public.derive_item_sku(p_category uuid, p_brand text, p_attrs jsonb)
returns text language plpgsql stable as $$
declare
  cat_token text;
  parts text[];
begin
  select coalesce(nullif(sku_token, ''), public.sku_token(name, 12))
    into cat_token from public.categories where id = p_category;

  parts := array_remove(array[
    nullif(cat_token, ''),
    nullif(public.sku_token(p_brand, 10), ''),
    nullif(public.sku_token(p_attrs->>'color', 8), ''),
    nullif(public.sku_token(coalesce(p_attrs->>'size', p_attrs->>'size_eu', p_attrs->>'volume_ml'), 8), '')
  ], null);

  return array_to_string(parts, '-');
end;
$$;

-- BEFORE INSERT/UPDATE: auto-derive SKU and maintain audit columns.
create or replace function public.items_before_write()
returns trigger language plpgsql as $$
begin
  new.sku := public.derive_item_sku(new.category_id, new.brand, new.attributes);
  new.updated_at := now();
  if auth.uid() is not null then
    new.updated_by := auth.uid();
    if tg_op = 'INSERT' and new.created_by is null then
      new.created_by := auth.uid();
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists items_biu on public.items;
create trigger items_biu before insert or update on public.items
  for each row execute function public.items_before_write();

-- ---------------------------------------------------------------------------
-- audit_log: field-level change history (mirrors applied_changes_log.csv)
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id          bigserial primary key,
  item_id     uuid,
  change_type text,                  -- create / edit / delete
  field       text,
  before      text,
  after       text,
  sku_before  text,
  sku_after   text,
  actor       uuid,
  notes       text,
  created_at  timestamptz not null default now()
);
create index if not exists audit_log_item_idx on public.audit_log (item_id);

-- AFTER trigger writes one audit row per changed scalar column or attribute key.
create or replace function public.items_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  k text; ov text; nv text;
begin
  if tg_op = 'INSERT' then
    insert into audit_log(item_id, change_type, sku_after, actor, notes)
      values (new.id, 'create', new.sku, auth.uid(), 'item created');
    return new;
  elsif tg_op = 'DELETE' then
    insert into audit_log(item_id, change_type, sku_before, actor, notes)
      values (old.id, 'delete', old.sku, auth.uid(), 'item deleted');
    return old;
  end if;

  -- UPDATE: scalar columns
  if old.brand          is distinct from new.brand          then
    insert into audit_log(item_id,change_type,field,before,after,sku_before,sku_after,actor)
      values(new.id,'edit','brand',old.brand,new.brand,old.sku,new.sku,auth.uid()); end if;
  if old.name           is distinct from new.name           then
    insert into audit_log(item_id,change_type,field,before,after,sku_before,sku_after,actor)
      values(new.id,'edit','name',old.name,new.name,old.sku,new.sku,auth.uid()); end if;
  if old.status         is distinct from new.status         then
    insert into audit_log(item_id,change_type,field,before,after,sku_before,sku_after,actor)
      values(new.id,'edit','status',old.status,new.status,old.sku,new.sku,auth.uid()); end if;
  if old.price          is distinct from new.price          then
    insert into audit_log(item_id,change_type,field,before,after,sku_before,sku_after,actor)
      values(new.id,'edit','price',old.price::text,new.price::text,old.sku,new.sku,auth.uid()); end if;
  if old.stock_quantity is distinct from new.stock_quantity then
    insert into audit_log(item_id,change_type,field,before,after,sku_before,sku_after,actor)
      values(new.id,'edit','stock_quantity',old.stock_quantity::text,new.stock_quantity::text,old.sku,new.sku,auth.uid()); end if;
  if old.reorder_level  is distinct from new.reorder_level  then
    insert into audit_log(item_id,change_type,field,before,after,sku_before,sku_after,actor)
      values(new.id,'edit','reorder_level',old.reorder_level::text,new.reorder_level::text,old.sku,new.sku,auth.uid()); end if;
  if old.category_id    is distinct from new.category_id    then
    insert into audit_log(item_id,change_type,field,before,after,sku_before,sku_after,actor)
      values(new.id,'edit','category',old.category_id::text,new.category_id::text,old.sku,new.sku,auth.uid()); end if;

  -- UPDATE: attribute keys (union of old + new keys)
  for k in
    select jsonb_object_keys(old.attributes)
    union
    select jsonb_object_keys(new.attributes)
  loop
    ov := old.attributes->>k; nv := new.attributes->>k;
    if ov is distinct from nv then
      insert into audit_log(item_id,change_type,field,before,after,sku_before,sku_after,actor)
        values(new.id,'edit',k,ov,nv,old.sku,new.sku,auth.uid());
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists items_audit_aiud on public.items;
create trigger items_audit_aiud after insert or update or delete on public.items
  for each row execute function public.items_audit();

-- audit_log RLS: editors/admins read; inserts only via the SECURITY DEFINER
-- trigger above (no direct client inserts).
alter table public.audit_log enable row level security;
drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log
  for select using (public.current_user_role() in ('editor','admin'));

-- ---------------------------------------------------------------------------
-- vocabularies: controlled values + alias normalization (kills Grey/Gray drift)
-- ---------------------------------------------------------------------------
create table if not exists public.vocabularies (
  id        uuid primary key default gen_random_uuid(),
  field     text not null,                 -- color / brand / material / fit / ...
  canonical text not null,
  aliases   text[] not null default '{}',
  active    boolean not null default true,
  unique (field, canonical)
);
create index if not exists vocab_field_idx on public.vocabularies (field);

alter table public.vocabularies enable row level security;
drop policy if exists vocab_read on public.vocabularies;
create policy vocab_read on public.vocabularies
  for select using (auth.role() = 'authenticated');
drop policy if exists vocab_insert on public.vocabularies;
create policy vocab_insert on public.vocabularies
  for insert with check (public.current_user_role() in ('editor','admin'));
drop policy if exists vocab_write on public.vocabularies;
create policy vocab_write on public.vocabularies
  for update using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');
drop policy if exists vocab_delete on public.vocabularies;
create policy vocab_delete on public.vocabularies
  for delete using (public.current_user_role() = 'admin');
