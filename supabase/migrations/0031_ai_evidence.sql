-- Persist the visible text the AI read from a product photo so the editor can
-- show evidence beside confidence marks. Values are item-level retail evidence,
-- not provider secrets.
alter table public.items
  add column if not exists ai_visible_text text;

comment on column public.items.ai_visible_text is
  'Text transcribed from the item photo by the AI extraction function.';
