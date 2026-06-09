-- =============================================================================
-- Phase: review efficiency — confidence calibration
--   calibration_marks records a human verdict (correct/wrong) on each AI-filled
--   field, alongside the AI's confidence level and value AT MARK TIME. This is
--   the ground truth that answers "does High confidence actually mean correct?"
--   so bulk-approving high-confidence uploads can be trusted (or not).
--
--   The ai_level/ai_value are SNAPSHOTTED here so the calibration numbers stay
--   valid even if the item is later edited or re-extracted.
-- Run AFTER 0015. Idempotent.
-- =============================================================================

create table if not exists public.calibration_marks (
  id         bigserial primary key,
  item_id    uuid not null references public.items(id) on delete cascade,
  field      text not null,                 -- field key (brand / color / scent_family / ...)
  ai_level   text check (ai_level in ('High','Medium','Low')),
  ai_value   text,                          -- the value the AI produced, snapshotted
  verdict    text not null check (verdict in ('correct','wrong')),
  actor      uuid references auth.users(id),
  created_at timestamptz not null default now(),
  -- One current verdict per field per item; re-marking upserts (latest wins).
  unique (item_id, field)
);
create index if not exists calibration_marks_item_idx on public.calibration_marks (item_id);

-- updated-on-upsert: keep created_at as the LAST mark time so re-calibration is
-- visible. (Upserts set created_at = now() via the client's onConflict update.)

alter table public.calibration_marks enable row level security;

-- Editors/admins (the people who review) may read and record marks. Inserts and
-- updates are scoped the same; deletes are admin-only to protect the dataset.
drop policy if exists calib_read on public.calibration_marks;
create policy calib_read on public.calibration_marks
  for select using (public.current_user_role() in ('editor','admin'));

drop policy if exists calib_insert on public.calibration_marks;
create policy calib_insert on public.calibration_marks
  for insert with check (public.current_user_role() in ('editor','admin'));

drop policy if exists calib_update on public.calibration_marks;
create policy calib_update on public.calibration_marks
  for update using (public.current_user_role() in ('editor','admin'))
  with check (public.current_user_role() in ('editor','admin'));

drop policy if exists calib_delete on public.calibration_marks;
create policy calib_delete on public.calibration_marks
  for delete using (public.current_user_role() = 'admin');
