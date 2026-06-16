-- =============================================================================
-- Redact cost values from the work trail.
--
-- item_events is readable by every editor (item_events_read = auth_can_edit),
-- but cost_price is admin-only data (can_view_cost). The app previously logged
-- cost_price changes with their before/after VALUES, which a non-admin editor
-- could read directly. The app now logs cost_price changes value-less (a single
-- redaction chokepoint in src/activity.js); this scrubs any values already
-- written. The event itself is kept (it's still useful to know cost changed).
--
-- Idempotent.
-- =============================================================================
update public.item_events
   set before_value = null,
       after_value  = null
 where field_path = 'cost_price'
   and (before_value is not null or after_value is not null);
