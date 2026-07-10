-- =============================================================================
-- Approval-critical category fields.
--
-- Readiness already blocks missing fields marked required in category_fields.
-- The original seed left every category field optional, which made sparse items
-- look approvable once they had any single detail. Mark only objective selling
-- facts required here; subjective/descriptive fields such as material, fit,
-- style code, scent family, and watch movement remain optional.
--
-- Run AFTER 0031_ai_evidence.sql. Idempotent.
-- =============================================================================

update public.category_fields cf
set required = true
from public.categories c
where cf.category_id = c.id
  and (
    (c.slug in ('clothing', 'footwear') and cf.key = 'color')
    or (c.slug in ('pants', 'shirts', 'jackets', 'belts', 'caps') and cf.key = 'size')
    or (c.slug in ('sneakers', 'formal-shoes') and cf.key = 'size_eu')
    or (c.slug = 'fragrance' and cf.key in ('volume_ml', 'concentration'))
  );
