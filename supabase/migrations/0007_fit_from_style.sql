-- =============================================================================
-- Move fit values out of the `style` attribute into `fit`.
--
-- In the source spreadsheet the `style` column held a model code for most pants
-- but the FIT (Slim Fit, Skinny Fit, …) for the flat-front trousers and one
-- chino. The seed imported those into attributes.style, so the dedicated Fit
-- field was empty. Here we relocate them to attributes.fit (normalised) and
-- mark fit confidence Low, since LABELING_REVIEW.md flags several as misreads.
--
-- Run AFTER 0006. Idempotent (only matches style values that are fit phrases).
-- =============================================================================

-- Make the editor normalise "Slim Fit" -> "Slim" etc. when typed in future.
update public.vocabularies set aliases = array(
  select distinct unnest(aliases || extra)
  from (select case canonical
          when 'Slim'     then array['Slim Fit']
          when 'Skinny'   then array['Skinny Fit']
          when 'Relaxed'  then array['Relaxed Fit']
          when 'Muscle'   then array['Muscle Fit']
          when 'Comfort'  then array['Comfort Fit']
          when 'Straight' then array['Straight Fit']
          when 'Regular'  then array['Regular Fit']
          when 'Tapered'  then array['Tapered Fit','Tapered Long Fit','Tapered Long']
          else array[]::text[] end as extra) e
) where field = 'fit';

-- Relocate the fit phrases from style -> fit, drop style, flag fit as Low.
update public.items i
set attributes = (i.attributes - 'style') || jsonb_build_object('fit', m.fit),
    confidence = coalesce(i.confidence, '{}'::jsonb) || jsonb_build_object('fit', 'Low')
from (values
  ('skinny fit',       'Skinny'),
  ('slim fit',         'Slim'),
  ('relaxed fit',      'Relaxed'),
  ('muscle fit',       'Muscle'),
  ('comfort fit',      'Comfort'),
  ('straight fit',     'Straight'),
  ('regular fit',      'Regular'),
  ('tapered fit',      'Tapered'),
  ('tapered long fit', 'Tapered')
) as m(pat, fit)
where lower(i.attributes->>'style') = m.pat;
