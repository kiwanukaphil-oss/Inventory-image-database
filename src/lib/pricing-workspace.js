/** Pure merchandise selection and rule compilation; money is validated again by the pricing API. */
import { parsePrice } from './price.js';

export const PRICING_MISSING_VALUE = '__missing__';
export const pricingLines = item => item.lines || item.variant_lines || [];
export const pricingValue = (item,line,key) => {
  const value = key === 'category' ? item.category_id : key === 'brand' ? item.brand
    : key.startsWith('variant:') ? line?.variant_attributes?.[key.slice(8)] : item.attributes?.[key];
  return value === null || value === undefined || value === '' ? PRICING_MISSING_VALUE : String(value).trim();
};
export const pricingMoney = raw => {
  if (raw === '' || raw === null || raw === undefined) return undefined;
  const value = parsePrice(raw);
  if (value === null || value <= 0 || value > 99999999.99) throw new Error('Enter prices greater than zero (up to 99,999,999.99).');
  return Math.round(value*100)/100;
};

/** Category ancestry and variant fields share the same predicate everywhere. */
export function matchesPricingCondition(item,line,condition,categories = []) {
  if (condition.operator === 'between') {
    const raw = pricingValue(item,line,condition.key),value = Number(raw);
    return raw !== PRICING_MISSING_VALUE && Number.isFinite(value) && value >= Number(condition.min) && value <= Number(condition.max);
  }
  if (!condition.values?.length) return true;
  let values = [pricingValue(item,line,condition.key)];
  if (condition.key === 'category') {
    const visited = new Set(values);
    let category = categories.find(entry => entry.id === item.category_id);
    while (category?.parent_id && !visited.has(category.parent_id)) {
      values.push(category.parent_id); visited.add(category.parent_id);
      category = categories.find(entry => entry.id === category.parent_id);
    }
  }
  const matches = condition.values.some(value => values.includes(value));
  return condition.operator === 'exclude' ? !matches : matches;
}

export const completePricingCondition = condition => condition.operator === 'between'
  ? condition.min !== '' && condition.max !== '' && condition.min != null && condition.max != null
    && Number.isFinite(Number(condition.min)) && Number.isFinite(Number(condition.max)) && Number(condition.min) <= Number(condition.max)
  : !!condition.values?.length;

/** A size filter narrows lines instead of accidentally changing every sibling in a photo. */
export function selectPricingScope(items,draft,categories = []) {
  return items.filter(item => !item.is_published).map(item => ({...item,
    targetLines:pricingLines(item).filter(line => Number(line.quantity) > 0
      && draft.filters.every(condition => matchesPricingCondition(item,line,condition,categories))),
  })).filter(item => item.targetLines.length && (!draft.onlyMissing
    || item.targetLines.some(line => line.effective_price == null
      || (draft.costMode !== 'leave' && line.effective_cost == null))));
}

/** Both views resolve the same rules. Ambiguous sibling matches require an explicit order choice. */
function resolveRuleValue(item,line,draft,categories,field,productOnly = false) {
  let result = pricingMoney(draft[field === 'retail' ? 'basePrice' : 'baseCost']);
  let reason = 'Shared price';
  const matches = draft.rules.filter(rule => rule.enabled !== false
    && (!productOnly || !rule.conditions.some(condition => condition.key.startsWith('variant:')))
    && rule.conditions.every(condition => matchesPricingCondition(item,line,condition,categories))
    && rule[field] !== '' && rule[field] != null);
  const candidates = draft.useRuleOrder ? matches : matches.filter(rule =>
    !matches.some(other => other !== rule && other.conditions.length > rule.conditions.length
      && rule.conditions.every(condition => other.conditions.some(entry => JSON.stringify(entry) === JSON.stringify(condition)))));
  const prices = new Set(candidates.map(rule => pricingMoney(rule[field])));
  if (!draft.useRuleOrder && prices.size > 1) throw new Error(`Overlapping ${field} rules for ${item.name || item.brand || 'this item'}${line ? ' / '+(line.variant_attributes?.size || 'size') : ''}. Refine the conditions or choose rule order.`);
  for (const rule of candidates) { result = pricingMoney(rule[field]); reason = rule.label || `Rule ${draft.rules.indexOf(rule)+1}`; }
  return {value:result,reason};
}

/** Compile explicit item defaults and line overrides, preserving size-only boundaries. */
export function compilePricingDraft(items,draft,categories = []) {
  if (draft.filters.some(condition => !completePricingCondition(condition))) {
    throw new Error('Complete each merchandise filter with values or a valid numeric range.');
  }
  if (draft.rules.some(rule => (rule.retail || rule.cost) && (!rule.conditions.length || rule.conditions.some(condition => !completePricingCondition(condition))))) {
    throw new Error('Choose attribute values or a valid numeric range for every priced exception. Use the shared price for the whole selection.');
  }
  const scoped = selectPricingScope(items,draft,categories);
  const rows = [], proposals = [];
  for (const item of scoped) {
    const allTargeted = item.targetLines.length === pricingLines(item).filter(line => line.quantity > 0).length;
    const defaults = {retail:draft.retailMode === 'leave' ? {} : resolveRuleValue(item,null,draft,categories,'retail',true),
      cost:draft.costMode === 'leave' ? {} : resolveRuleValue(item,null,draft,categories,'cost',true)};
    const proposal = {id:item.id,expected_revision:item.revision,target_line_ids:item.targetLines.map(line => line.id),lines:[]};
    if (allTargeted && defaults.retail.value !== undefined) proposal.base_price = defaults.retail.value;
    if (allTargeted && defaults.cost.value !== undefined) proposal.base_cost_price = defaults.cost.value;
    for (const line of item.targetLines) {
      const edit = {id:line.id};
      const row = {item,line,before:line.effective_price,after:line.effective_price,
        costBefore:line.effective_cost,costAfter:line.effective_cost,reason:'Unchanged',protected:false};
      for (const field of ['retail','cost']) {
        const isCost = field === 'cost',mode = isCost ? draft.costMode : draft.retailMode;
        if (mode === 'leave') continue;
        const resolved = resolveRuleValue(item,line,draft,categories,field);
        const direct = draft.lineEdits[line.id]?.[field];
        const overrideKey = isCost ? 'cost_override' : 'price_override';
        const before = isCost ? line.effective_cost : line.effective_price;
        const currentOverride = line[overrideKey];
        const keepOverrides = isCost ? draft.keepCostOverrides : draft.keepOverrides;
        const isProtected = mode === 'fill' && before != null;
        let target = resolved.value;
        let reason = resolved.reason;
        if (direct === 'shared') {
          if (!allTargeted) throw new Error('Use shared price with all sizes of this photo selected.');
          edit[overrideKey] = null;
          target = defaults[field].value ?? (isCost ? item.base_cost_price : item.base_price);
          reason = 'Use shared price';
        } else if (direct != null && direct !== '') {
          target = pricingMoney(direct); edit[overrideKey] = target; edit[isCost ? 'replace_cost_override' : 'replace_price_override'] = true; reason = 'Direct size edit';
        } else if (target !== undefined && (!allTargeted || target !== defaults[field].value)) edit[overrideKey] = target;
        else if (target !== undefined && !keepOverrides) edit[overrideKey] = null;
        const keepIndividual = keepOverrides && currentOverride != null && direct !== 'shared' && !(direct != null && direct !== '');
        if (isProtected || keepIndividual) { target = before; reason = isProtected ? 'Existing price protected' : 'Individual size price kept'; }
        if (target === undefined) target = before;
        if (isCost) row.costAfter = target;
        else { row.after = target; row.reason = reason; }
        if (isProtected || keepIndividual) row.protected = true;
      }
      if (Object.keys(edit).length > 1) proposal.lines.push(edit);
      row.changed = row.before !== row.after || row.costBefore !== row.costAfter;
      rows.push(row);
    }
    proposals.push(proposal);
  }
  return {scoped,rows,payload:{items:proposals,retail_mode:draft.retailMode,cost_mode:draft.costMode,
    keep_overrides:draft.keepOverrides,keep_cost_overrides:draft.keepCostOverrides}};
}

export function createPricingDraft() {
  return {version:1,view:'guided',filters:[],rules:[],basePrice:'',baseCost:'',retailMode:'fill',costMode:'leave',
    keepOverrides:true,keepCostOverrides:true,onlyMissing:false,useRuleOrder:false,groupKeys:['category','brand'],lineEdits:{}};
}

/** Persist only retail inputs, never cost data or cached inventory snapshots. */
export function pricingDraftForStorage(draft) {
  return {...draft,baseCost:'',costMode:'leave',rules:draft.rules.map(({cost,...rule}) => rule),
    lineEdits:Object.fromEntries(Object.entries(draft.lineEdits).map(([id,edit]) => [id,{retail:edit.retail}]))};
}

/** Price cards and ranges follow effective positive-quantity variants, even without a default. */
export function catalogPriceRange(item) {
  const lines = pricingLines(item).filter(line => Number(line.quantity) > 0);
  const prices = lines.length ? lines.map(line => line.effective_price ?? line.price_override ?? item.price ?? item.base_price)
    : [item.price ?? item.base_price];
  const valid = prices.filter(value => value != null && Number.isFinite(Number(value))).map(Number);
  return {min:valid.length ? Math.min(...valid) : null,max:valid.length ? Math.max(...valid) : null,
    missing:prices.length-valid.length,priced:valid.length,total:prices.length};
}
