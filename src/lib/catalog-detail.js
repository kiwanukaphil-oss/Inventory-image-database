/** Avoid repeating a brand when the extracted name already begins with it. */
export function catalogItemTitle(item) {
  const brand = String(item?.brand || "").trim();
  const name = String(item?.name || "").trim();
  if (name && brand && name.toLocaleLowerCase().startsWith(brand.toLocaleLowerCase())) {
    return name;
  }
  return [brand, name].filter(Boolean).join(" ") || item?.sku || "Untitled item";
}

/**
 * Produce stable rows for every configured field, including missing fields,
 * then retain imported attributes whose definitions are no longer present.
 */
export function catalogDetailFieldRows(item, fields) {
  const attributes = item?.attributes || {};
  const configuredKeys = new Set((fields || []).map((field) => field.key));
  const rows = (fields || []).map((field) => ({
    key: field.key,
    label: field.label,
    required: !!field.required,
    value: attributes[field.key],
    confidence: item?.confidence?.[field.key] || null,
    evidence: item?.ai_field_evidence?.[field.key] || null,
  }));
  for (const [key, value] of Object.entries(attributes)) {
    if (configuredKeys.has(key)) continue;
    rows.push({
      key,
      label: key.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      required: false,
      value,
      confidence: item?.confidence?.[key] || null,
      evidence: item?.ai_field_evidence?.[key] || null,
    });
  }
  return rows.map((row) => ({
    ...row,
    missing: row.value === null || row.value === undefined || row.value === "",
  }));
}

export function evidenceSourceLabel(source) {
  return {
    printed_label: "Printed label",
    visible_text: "Visible text",
    visual_observation: "Visual observation",
    visual_inference: "Visual inference",
    recognized_product: "Recognized product",
  }[source] || "AI evidence";
}
