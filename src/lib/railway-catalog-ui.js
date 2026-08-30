/**
 * Preserve only Railway capabilities whose backend write contracts are live.
 * General mutation flags stay masked so legacy Supabase controls remain hidden.
 */
export function buildRailwayCatalogProfile(profile = {}) {
  return {
    ...profile,
    can_upload: !!profile.can_upload,
    can_edit: false,
    can_delete: false,
    can_view_cost: false,
    can_manage_users: false,
    can_publish: false,
    railway_read_only: false,
  };
}

/** Home/Catalog/Review are universal; Add follows the effective upload grant. */
export function selectRailwayCatalogNavigation(navItems, capabilities = {}) {
  const visibleIds = new Set(["today", "catalog", "review"]);
  if (capabilities.can_upload) visibleIds.add("add");
  return navItems.filter((navItem) => visibleIds.has(navItem.id));
}
