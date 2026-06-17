-- =============================================================================
-- Phase 0 security & data-integrity hardening
--
-- Resolves audit findings (see docs/V3_upgrade/V3_ENGINEERING_AUDIT.md):
--   S1 — block privilege self-escalation via a plain profiles UPDATE.
--   S3 — DB-enforce cost redaction in the editor-readable item_events work trail.
--   S7 — non-negative price/stock/cost constraints; require category;
--        index (not unique) the intentionally-duplicated SKU.
--   S8 — make audit_log append-only; stop actor spoofing in item_events.
--
-- Run AFTER 0026. Idempotent (safe to re-run). Apply to STAGING first, then prod.
--
-- ROLLBACK (down-SQL), if ever needed:
--   drop trigger profiles_no_self_escalation on public.profiles;
--   drop function public.profiles_block_self_escalation();
--   drop trigger item_events_scrub_cost on public.item_events;
--   drop function public.scrub_cost_from_event();
--   -- restore the prior actor trigger from 0023 (only-when-null variant);
--   drop trigger audit_log_append_only on public.audit_log;
--   drop function public.audit_log_block_mutation();
--   grant update, delete on public.audit_log to authenticated;  -- (re-open)
--   alter table public.items alter column category_id drop not null;
--   alter table public.items      drop constraint items_price_nonneg;
--   alter table public.items      drop constraint items_stock_nonneg;
--   alter table public.items      drop constraint items_reorder_nonneg;
--   alter table public.item_costs drop constraint item_costs_cost_nonneg;
--   drop index public.items_sku_idx;
-- =============================================================================


-- ---------------------------------------------------------------------------
-- S1 — Forbid users from changing their OWN role/capabilities.
--
-- 0008's profiles_manage_write lets anyone with can_manage_users UPDATE any
-- profile, with no guard against editing their own privilege columns. A
-- user-manager who is NOT a cost-admin could `update profiles set
-- can_view_cost=true, role='admin' where id = auth.uid()` and self-escalate,
-- defeating the whole point of separable capabilities.
--
-- We enforce the rule in a trigger (not just the policy) so EVERY path is
-- covered. Service-role / SQL-editor writes have auth.uid() = null and are
-- intentionally exempt, so initial admin setup and the manage-users Edge
-- Function (which does its own authorization — see S2) keep working. The
-- policy is deliberately left permissive for self-edits of NON-privilege
-- fields (e.g. a manager fixing their own email).
-- ---------------------------------------------------------------------------
create or replace function public.profiles_block_self_escalation()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null and new.id = auth.uid() then
    if new.role             is distinct from old.role
       or new.active           is distinct from old.active
       or new.can_upload       is distinct from old.can_upload
       or new.can_edit         is distinct from old.can_edit
       or new.can_delete       is distinct from old.can_delete
       or new.can_view_cost    is distinct from old.can_view_cost
       or new.can_manage_users is distinct from old.can_manage_users then
      raise exception 'You cannot change your own role or capabilities.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_no_self_escalation on public.profiles;
create trigger profiles_no_self_escalation
  before update on public.profiles
  for each row execute function public.profiles_block_self_escalation();


-- ---------------------------------------------------------------------------
-- S3 — Never persist cost values in the work trail, at the DB layer.
--
-- item_events is readable by every editor (item_events_read = auth_can_edit),
-- but cost_price is admin-only (can_view_cost). 0026 was a one-time scrub of
-- existing rows; this trigger prevents ANY future insert/update from writing a
-- cost value, regardless of caller (defends against an app bug or a direct API
-- insert by an editor). The event itself is kept — only the values are nulled.
-- ---------------------------------------------------------------------------
create or replace function public.scrub_cost_from_event()
returns trigger
language plpgsql
as $$
begin
  if new.field_path = 'cost_price' then
    new.before_value := null;
    new.after_value  := null;
  end if;
  return new;
end;
$$;

drop trigger if exists item_events_scrub_cost on public.item_events;
create trigger item_events_scrub_cost
  before insert or update on public.item_events
  for each row execute function public.scrub_cost_from_event();

-- Belt-and-suspenders: re-run the historical scrub in case 0026 predated rows.
update public.item_events
   set before_value = null, after_value = null
 where field_path = 'cost_price'
   and (before_value is not null or after_value is not null);


-- ---------------------------------------------------------------------------
-- S8 — Audit integrity: append-only audit_log + non-spoofable event actor.
--
-- (a) audit_log must be tamper-evident. All Supabase end users authenticate as
--     the Postgres `authenticated` role, so revoking UPDATE/DELETE from it
--     blocks every end user (including an escalated admin) from rewriting
--     history via the API. A trigger additionally rejects UPDATE/DELETE from
--     ANY caller (incl. service role) — true append-only. To purge for a
--     genuine reason (e.g. GDPR erasure), an operator drops the trigger
--     deliberately, leaving an intentional, visible action.
-- (b) item_events.actor was only filled when null (0023), letting an editor
--     supply someone else's id. Now: whenever there is an authenticated caller,
--     actor is forced to that caller — clients can no longer spoof it. System /
--     service-role writes (auth.uid() null) keep the supplied actor (or null).
-- ---------------------------------------------------------------------------

-- (a) audit_log append-only
revoke update, delete on public.audit_log from authenticated;
revoke update, delete on public.audit_log from anon;

create or replace function public.audit_log_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only; % is not permitted.', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists audit_log_append_only on public.audit_log;
create trigger audit_log_append_only
  before update or delete on public.audit_log
  for each row execute function public.audit_log_block_mutation();

-- (b) non-spoofable item_events actor (replaces the 0023 only-when-null version)
create or replace function public.item_events_actor_default()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null then
    new.actor := auth.uid();   -- clients cannot attribute events to others
  end if;
  return new;
end;
$$;
-- trigger item_events_actor (0023) already points at this function; redefining
-- the function is enough. (Recreated here for clarity / fresh installs.)
drop trigger if exists item_events_actor on public.item_events;
create trigger item_events_actor
  before insert on public.item_events
  for each row execute function public.item_events_actor_default();


-- ---------------------------------------------------------------------------
-- S7 — Data-integrity constraints.
--
-- Decisions recorded in the hardening roadmap:
--   * SKU: duplicates are INTENTIONAL (one photo = one unit; many units share a
--     SKU). No unique constraint — just a lookup index.
--   * category_id: REQUIRED. Backfill must happen first; if any item still has
--     no category, the migration stops with a clear message rather than
--     silently inventing an "uncategorized" bucket that could reach the POS.
--   * price / stock / reorder / cost: never negative.
--
-- Constraints are added drop-then-add so the migration is re-runnable. ADD
-- CONSTRAINT validates existing rows: if it errors, you have bad data to fix —
-- that's the point.
-- ---------------------------------------------------------------------------

-- Require a category (guarded so it fails loudly, not silently).
do $$
declare n int;
begin
  select count(*) into n from public.items where category_id is null;
  if n > 0 then
    raise exception
      'Cannot set items.category_id NOT NULL: % item(s) have no category. Assign a category to them first, then re-run.', n;
  end if;
end $$;
alter table public.items alter column category_id set not null;

-- Non-negative money / stock.
alter table public.items drop constraint if exists items_price_nonneg;
alter table public.items add  constraint items_price_nonneg
  check (price is null or price >= 0);

alter table public.items drop constraint if exists items_stock_nonneg;
alter table public.items add  constraint items_stock_nonneg
  check (stock_quantity is null or stock_quantity >= 0);

alter table public.items drop constraint if exists items_reorder_nonneg;
alter table public.items add  constraint items_reorder_nonneg
  check (reorder_level is null or reorder_level >= 0);

alter table public.item_costs drop constraint if exists item_costs_cost_nonneg;
alter table public.item_costs add  constraint item_costs_cost_nonneg
  check (cost_price is null or cost_price >= 0);

-- SKU lookup index (NOT unique — duplicate SKUs are by design).
create index if not exists items_sku_idx on public.items (sku);
comment on index public.items_sku_idx is
  'Lookup index. SKU is intentionally NON-unique: one photo = one unit, so many items share a SKU (see POS integration / hardening roadmap S7).';
