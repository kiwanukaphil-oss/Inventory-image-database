export const ALL_POS_BRANCHES = "all";
const STORAGE_KEY = "kline.pos.branch.v1";

export const branchVariantKey = (branchId, variantId) => `${branchId || ""}:${variantId || ""}`;

export function enabledBranches(branches) {
  return (branches || []).filter((b) => b.is_enabled !== false && ["active", "opening"].includes(b.status));
}

export function defaultPosBranchId(branches) {
  const enabled = enabledBranches(branches);
  return enabled.find((b) => b.is_default)?.pos_branch_id || enabled[0]?.pos_branch_id || null;
}

export function storedPosBranchId(branches, { allowAll = true } = {}) {
  const enabled = enabledBranches(branches);
  let stored = "";
  try { stored = localStorage.getItem(STORAGE_KEY) || ""; } catch {}
  if (allowAll && stored === ALL_POS_BRANCHES && enabled.length > 1) return stored;
  if (enabled.some((b) => b.pos_branch_id === stored)) return stored;
  return defaultPosBranchId(enabled);
}

export function storePosBranchId(branchId) {
  try { localStorage.setItem(STORAGE_KEY, branchId || ""); } catch {}
}

export function mergeBranchMirror(globalRows, branchRows, branchId) {
  const globals = new Map((globalRows || []).map((row) => [row.pos_variant_id, row]));
  if (!branchRows?.length) return globals;

  const result = new Map();
  if (branchId === ALL_POS_BRANCHES) {
    for (const row of branchRows) {
      const current = result.get(row.pos_variant_id) || {
        ...(globals.get(row.pos_variant_id) || { pos_variant_id: row.pos_variant_id }),
        stock_quantity: 0,
        units_sold: 0,
        units_returned: 0,
        units_sold_today: 0,
        units_sold_7d: 0,
        low_branch_count: 0,
        branch_count: 0,
        mirrored_at: null,
      };
      current.stock_quantity += Number(row.stock_quantity) || 0;
      current.units_sold += Number(row.units_sold) || 0;
      current.units_returned += Number(row.units_returned) || 0;
      current.units_sold_today += Number(row.units_sold_today) || 0;
      current.units_sold_7d += Number(row.units_sold_7d) || 0;
      current.branch_count += 1;
      if (row.stock_quantity > 0 && row.reorder_level != null && row.stock_quantity <= row.reorder_level) {
        current.low_branch_count += 1;
      }
      if (!current.mirrored_at || new Date(row.mirrored_at) < new Date(current.mirrored_at)) {
        current.mirrored_at = row.mirrored_at;
      }
      result.set(row.pos_variant_id, current);
    }
    return result;
  }

  for (const row of branchRows) {
    if (row.pos_branch_id !== branchId) continue;
    result.set(row.pos_variant_id, {
      ...(globals.get(row.pos_variant_id) || {}),
      ...row,
    });
  }
  return result;
}

export function mirrorForItem(payload, item) {
  if (!item?.pos_variant_id) return undefined;
  const branchId = item.pos_branch_id || payload?.defaultBranchId;
  if (branchId && payload?.byBranchVariant) {
    const row = payload.byBranchVariant.get(branchVariantKey(branchId, item.pos_variant_id));
    if (row) return { ...(payload.globalByVariant?.get(item.pos_variant_id) || {}), ...row };
  }
  return payload?.globalByVariant?.get(item.pos_variant_id) || payload?.byVariant?.get(item.pos_variant_id);
}
