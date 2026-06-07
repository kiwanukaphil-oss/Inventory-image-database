-- =============================================================================
-- Make Fragrance "scent family" a fixed dropdown so values stay consistent and
-- the AI is constrained to choose from the list (the ai-extract function turns a
-- select field's options into an enum automatically — no redeploy needed).
--
-- Run AFTER 0009. Idempotent. Reload the app afterwards so it picks up the change.
-- =============================================================================

update public.category_fields cf
set type = 'select',
    options = array[
      'Woody','Amber','Oriental','Fresh','Citrus','Aromatic','Fougère',
      'Floral','Gourmand','Leather','Chypre','Aquatic','Green','Spicy'
    ]
from public.categories c
where cf.category_id = c.id and c.slug = 'fragrance' and cf.key = 'scent_family';
