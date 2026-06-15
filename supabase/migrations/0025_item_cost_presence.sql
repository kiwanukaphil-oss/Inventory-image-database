-- =============================================================================
-- V2 approval guard: expose cost-price presence without exposing cost values.
--
-- Cost values remain isolated in item_costs and readable only by users with
-- can_view_cost. Editors need only a boolean so approval can require that a
-- cost price exists before an item is approved.
--
-- Run AFTER 0024. Idempotent.
-- =============================================================================

create or replace function public.item_cost_presence(item_ids uuid[])
returns table(item_id uuid, has_cost_price boolean)
language sql
security definer
set search_path = public
as $$
  select
    i.id as item_id,
    coalesce(c.cost_price is not null, false) as has_cost_price
  from public.items i
  left join public.item_costs c on c.item_id = i.id
  where i.id = any(item_ids)
    and public.auth_can_edit();
$$;

revoke all on function public.item_cost_presence(uuid[]) from public;
grant execute on function public.item_cost_presence(uuid[]) to authenticated;
