-- =============================================================================
-- Windowed sold counts on the POS stock mirror (Phase 3: the Shop tab).
--
-- units_sold (lifetime) can't answer "what sold today / this week", which is
-- what the floor actually asks. The pos-mirror edge function now also sums the
-- POS sale movements over two rolling windows each run:
--   units_sold_today — since midnight in the shop's timezone (Africa/Kampala)
--   units_sold_7d    — the trailing 7 days
-- Both are gross sale units (returns not subtracted) — the Shop tab reports
-- "what moved", not net ledger maths.
--
-- Run AFTER 0018. Idempotent.
-- =============================================================================

alter table public.pos_stock_mirror
  add column if not exists units_sold_today integer not null default 0,
  add column if not exists units_sold_7d    integer not null default 0;
