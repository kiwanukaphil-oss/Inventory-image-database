/**
 * Preserve only Railway capabilities whose backend write contracts are live.
 * General mutation flags stay masked so legacy Supabase controls remain hidden.
 */
export function buildRailwayCatalogProfile(profile = {}) {
  return {
    ...profile,
    can_upload: !!profile.can_upload,
    can_select: !!profile.can_ai_extract || !!profile.can_edit || !!profile.can_publish,
    can_price: !!profile.can_edit,
    can_edit: false,
    can_delete: false,
    can_view_cost: !!profile.can_view_cost,
    can_manage_users: false,
    can_publish: !!profile.can_publish,
    railway_read_only: false,
  };
}

/** Resolve the narrow AI grant without treating it as general edit access. */
export function canRunCatalogAi(capabilities = {}, railwayMode = false) {
  return railwayMode ? !!capabilities.can_ai_extract : !!capabilities.can_edit;
}

/** Selection is safe when at least one supported bulk action is available. */
export function canSelectCatalogItems(capabilities = {}) {
  return !!capabilities.can_edit || !!capabilities.can_select;
}

/** Home/Catalog/Review are universal; Add follows the effective upload grant. */
export function selectRailwayCatalogNavigation(navItems, capabilities = {}) {
  const visibleIds = new Set(["today", "catalog", "review"]);
  if (capabilities.can_upload) visibleIds.add("add");
  return navItems.filter((navItem) => visibleIds.has(navItem.id));
}
