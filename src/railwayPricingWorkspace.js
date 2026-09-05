/**
 * Pricing Workspace
 * Responsible for: merchandise scopes, shared rules, group prices, size review and receipts.
 * NOT responsible for: authorizing or committing prices locally; Railway owns every write.
 */
import {requestRailwayCatalog} from './railwayCatalogApi.js';
import {readCatalogBranchId,availableCatalogBranches} from './lib/catalog-branch-scope.js';
import {loadRefData,fieldLabel,getSetting} from './data.js';
import {esc,toast,trapFocus,bindPriceInput,ICON} from './ui.js';
import {formatPriceInput} from './lib/price.js';
import {createPricingDraft,pricingDraftForStorage,compilePricingDraft,selectPricingScope,
  pricingValue,PRICING_MISSING_VALUE,matchesPricingCondition} from './lib/pricing-workspace.js';
import './pricing-workspace.css';

const LIMIT = 2000;
const money = value => value == null ? 'Not set' : `${getSetting('currency','UGX')} ${formatPriceInput(value)}`;
const option = (value,label,selected) => `<option value="${esc(value)}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
const plural = (count,label) => `${count} ${label}${count === 1 ? '' : label === 'match' ? 'es' : 's'}`;
const photoPriceSummary = rows => {
  const prices = rows.filter(row => row.after != null).map(row => row.after);
  const low = prices.length ? Math.min(...prices) : null,high = prices.length ? Math.max(...prices) : null;
  const range = low === high ? money(low) : `${money(low)}–${formatPriceInput(high)}`;
  const differing = prices.filter(price => price !== low).length;
  return `${range} per unit${differing ? ` · ${plural(differing,'size')} above the lowest price` : ''}${prices.length < rows.length ? ` · ${rows.length-prices.length} unpriced` : ''}`;
};

/** Open one finite branch-bound draft; every entry point uses this workspace. */
export async function openPricingWorkspace(caps,onClose,opts = {}) {
  if (!caps.can_price && !caps.can_edit) { toast('You do not have permission to price items.'); return; }
  const workspace = new PricingWorkspace(caps,onClose,opts);
  await workspace.open();
}

class PricingWorkspace {
  /** Capture branch and selection once so later edits cannot silently widen the plan. */
  constructor(caps,onClose,opts) {
    this.caps = caps; this.onClose = onClose; this.opts = opts;
    this.scopeAtOpen = readCatalogBranchId(caps);
    this.branchId = this.scopeAtOpen === 'all' ? '' : this.scopeAtOpen;
    this.items = []; this.categories = []; this.total = 0; this.isBusy = false; this.isClosed = false;
    this.didChange = false; this.draft = createPricingDraft(); this.plan = null; this.lastPlanId = null;
    this.photoLimit = 40; this.reviewLimit = 100;
    this.overlay = document.createElement('div'); this.overlay.className = 'calib pricing pricing-workspace';
    this.overlay.setAttribute('role','dialog'); this.overlay.setAttribute('aria-modal','true');
    this.overlay.setAttribute('aria-label','Price items');
  }

  /** Keep loading errors, closure and branch changes inside the same accessible shell. */
  async open() {
    document.body.appendChild(this.overlay);
    this.renderShell('<div class="spinner" style="margin:48px auto"></div>');
    this.releaseFocus = trapFocus(this.overlay);
    requestAnimationFrame(() => this.overlay.classList.add('open'));
    this.onEscape = event => { if (event.key === 'Escape' && !this.isBusy) this.close(); };
    document.addEventListener('keydown',this.onEscape);
    if (!this.branchId) { this.renderBranchChoice(); return; }
    await this.loadItems();
  }

  close() {
    if (this.isBusy || this.isClosed) return;
    this.isClosed = true; this.persistDraft(); this.releaseFocus?.();
    document.removeEventListener('keydown',this.onEscape);
    this.overlay.remove(); if (this.didChange) this.onClose?.();
  }

  renderShell(body,footer = '') {
    this.overlay.innerHTML = `<div class="calib-panel"><div class="calib-head">
      <button class="iconbtn" data-close aria-label="Close pricing">${ICON.x}</button>
      <span>Price items</span><span class="pw-branch">${esc(this.branchName())}</span></div>
      <div class="calib-body pw-body">${body}</div><div class="pw-error" role="alert" hidden></div>
      ${footer ? `<div class="calib-foot pw-foot">${footer}</div>` : ''}</div>`;
    this.overlay.querySelector('[data-close]').onclick = () => this.close();
  }

  branchName() {
    return availableCatalogBranches(this.caps).find(branch => branch.id === this.branchId)?.name || 'Choose a branch';
  }

  renderBranchChoice() {
    const branches = availableCatalogBranches(this.caps).filter(branch => branch.can_switch_to);
    this.renderShell(`<h2>Choose a branch to price</h2><p>Each pricing plan belongs to one branch.</p>
      <div class="pw-branch-choices">${branches.map(branch => `<button class="ghost" data-branch="${esc(branch.id)}">${esc(branch.name)}</button>`).join('')}</div>`);
    this.overlay.querySelectorAll('[data-branch]').forEach(button => {button.onclick = () => {this.branchId = button.dataset.branch; this.loadItems();};});
  }

  assertCurrentScope() {
    if (readCatalogBranchId(this.caps) !== this.scopeAtOpen) throw new Error('The active branch changed. Close pricing and reopen it in the intended branch.');
  }

  async request(path,body,method = 'POST') {
    this.assertCurrentScope();
    const result = await requestRailwayCatalog(path,{method,branchId:this.branchId,...(body !== undefined && {body})});
    return result.data;
  }

  /** Fetch explicit selections directly; otherwise expose the finite queue and its total. */
  async loadItems() {
    this.isBusy = true;
    this.renderShell('<div class="spinner" style="margin:48px auto"></div>');
    try {
      const ids = Array.isArray(this.opts.itemIds) ? [...new Set(this.opts.itemIds)] : null;
      if (ids && (!ids.length || ids.length > LIMIT)) throw new Error(`Choose between 1 and ${LIMIT} items for one pricing plan.`);
      const [first,reference] = await Promise.all([
        this.request('/catalog/pricing/workspace',ids ? {item_ids:ids} : {page:1}),loadRefData(),
      ]);
      this.categories = reference.categories || []; this.total = first.total;
      this.items = first.items;
      if (!ids) {
        for (let page = 2; page <= Math.ceil(Math.min(first.total,LIMIT)/200); page++) {
          const next = await this.request('/catalog/pricing/workspace',{page});
          this.items.push(...next.items);
        }
      }
      this.items = [...new Map(this.items.map(item => [item.id,item])).values()];
      this.storageKey = `kline.pricing.v1:${this.caps.id}:${this.branchId}:${ids ? ids.slice().sort().join(',') : 'branch'}`;
      if (!this.hasLoadedDraft) this.restoreDraft();
      this.hasLoadedDraft = true;
      this.isBusy = false; this.renderEditor();
    } catch (error) {
      this.isBusy = false;
      this.renderShell(`<div class="empty"><h2>Pricing could not load</h2><p>${esc(error.message)}</p><button class="primary" data-retry>Try again</button></div>`);
      this.overlay.querySelector('[data-retry]').onclick = () => this.loadItems();
    }
  }

  restoreDraft() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.storageKey) || 'null');
      if (saved?.draft?.version === 1) { this.draft = {...createPricingDraft(),...saved.draft}; this.wasRestored = true; }
      this.lastPlanId = saved?.planId || null;
    } catch {}
  }

  persistDraft() {
    if (!this.storageKey) return;
    try { localStorage.setItem(this.storageKey,JSON.stringify({draft:pricingDraftForStorage(this.draft),planId:this.lastPlanId})); } catch {}
  }

  fields() {
    const attrs = [...new Set(this.items.flatMap(item => Object.keys(item.attributes || {})))].filter(key => key !== 'size');
    const variant = [...new Set(this.items.flatMap(item => item.lines.flatMap(line => Object.keys(line.variant_attributes || {}))))];
    return [{key:'category',label:'Category'},{key:'brand',label:'Brand'},
      ...attrs.map(key => ({key,label:fieldLabel(key)})),...variant.map(key => ({key:`variant:${key}`,label:`Size / variant: ${fieldLabel(key)}`}))];
  }

  valuesFor(key) {
    if (key === 'category') return [...this.categories.map(category => ({value:category.id,label:category.name})),
      ...(this.items.some(item => !item.category_id) ? [{value:PRICING_MISSING_VALUE,label:'Not specified'}] : [])];
    const values = [...new Set(this.items.flatMap(item => item.lines.map(line => pricingValue(item,line,key))))];
    return values.sort((left,right) => left.localeCompare(right,undefined,{numeric:true})).map(value => ({value,label:value === PRICING_MISSING_VALUE ? 'Not specified' : value}));
  }

  /** Native multi-select values mean OR; separate condition rows mean AND. */
  conditionHtml(condition,index,prefix) {
    const values = this.valuesFor(condition.key);
    const numeric = values.some(entry => entry.value !== PRICING_MISSING_VALUE && Number.isFinite(Number(entry.value)));
    return `<div class="pw-condition" data-condition="${index}" data-prefix="${prefix}">
      <label>Attribute<select data-condition-key>${this.fields().map(field => option(field.key,field.label,field.key === condition.key)).join('')}</select></label>
      <label>Match<select data-condition-operator>${option('include','Is any of',condition.operator === 'include')}${option('exclude','Is not',condition.operator === 'exclude')}${numeric ? option('between','Between (numeric)',condition.operator === 'between') : ''}</select></label>
      ${condition.operator === 'between' ? `<label>From (inclusive)<input type="number" data-condition-min value="${esc(condition.min ?? '')}" aria-label="Minimum numeric value"></label><label>To (inclusive)<input type="number" data-condition-max value="${esc(condition.max ?? '')}" aria-label="Maximum numeric value"></label>` :
      `<label>Values<select multiple size="3" data-condition-values aria-label="${esc(this.fields().find(field => field.key === condition.key)?.label || condition.key)} values">${values.map(value => {
        const count = this.items.filter(item => !item.is_published).reduce((total,item) => total+item.lines.filter(line => line.quantity > 0 && matchesPricingCondition(item,line,{key:condition.key,operator:'include',values:[value.value]},this.categories)).length,0);
        return option(value.value,`${value.label} · ${plural(count,'variant')}`,condition.values.includes(value.value));
      }).join('')}</select></label>`}
      <button class="iconbtn" data-remove-condition aria-label="Remove condition">${ICON.x}</button></div>`;
  }

  priceInput(label,value,attributes,placeholder = 'Leave unchanged') {
    return `<label>${label}<input type="text" inputmode="decimal" data-money ${attributes} value="${esc(value ?? '')}" placeholder="${esc(placeholder)}"></label>`;
  }

  /** Progressive disclosure keeps ordinary shared pricing short while advanced rules remain available. */
  renderEditor() {
    if (this.isClosed) return;
    const draft = this.draft;
    const published = this.items.filter(item => item.is_published).length;
    this.renderShell(`<div class="pw-intro"><div><h2>One group. Every size accounted for.</h2>
      <p>${this.opts.itemIds ? `${plural(this.opts.itemIds.length,'selected photo')} · selection stays fixed` : `${plural(this.items.length,'loaded photo')} of ${this.total} in this branch`}</p></div>
      <div class="pw-inline">${this.lastPlanId ? '<button class="ghost" data-resume>Last review / Undo</button>' : ''}<button class="ghost" data-new-draft>New pricing plan</button></div></div>
      ${this.total > this.items.length && !this.opts.itemIds ? `<div class="pw-notice">Showing the first ${LIMIT} photos. For items outside this set, select them in Catalog and choose Price selected.</div>` : ''}
      ${published ? `<p class="pw-muted">${plural(published,'published photo')} excluded. Change published prices in POS → Manage Prices.</p>` : ''}
      ${this.wasRestored ? '<p class="pw-muted">Retail draft restored. Costs are not saved on this device; review again before applying.</p>' : ''}
      <details class="pw-scope"${draft.filters.length ? ' open' : ''}><summary>Choose merchandise <span class="pw-muted">${draft.filters.length ? plural(draft.filters.length,'filter') : 'All loaded unpublished items'}</span></summary>
      <p class="pw-muted">Select one or more values per attribute. Every condition must match. Size conditions select only those sizes.</p>
      <div>${draft.filters.map((condition,index) => this.conditionHtml(condition,index,'filter')).join('')}</div><button class="ghost" data-add-filter>+ Add attribute filter</button></details>
      <div class="pw-work"><section class="pw-controls" aria-label="Pricing rules">
      <div class="pw-tabs"><button data-view="guided" aria-pressed="${draft.view === 'guided'}">Build a rule</button><button data-view="groups" aria-pressed="${draft.view === 'groups'}">Group table</button></div>
      <label>Retail pricing<select data-draft="retailMode">${option('fill','Fill missing prices',draft.retailMode === 'fill')}${option('revise','Revise prices',draft.retailMode === 'revise')}${option('leave','Leave retail unchanged',draft.retailMode === 'leave')}</select></label>
      ${draft.retailMode === 'revise' ? `<label class="pw-check"><input type="checkbox" data-draft="keepOverrides"${draft.keepOverrides ? ' checked' : ''}>Keep individual size prices</label>` : ''}
      <label class="pw-check"><input type="checkbox" data-draft="onlyMissing"${draft.onlyMissing ? ' checked' : ''}>Only photos with missing prices${draft.costMode !== 'leave' ? ' or costs' : ''}</label>
      ${this.priceInput('Shared retail price · per unit',draft.basePrice,'data-draft="basePrice"')}
      ${this.caps.can_view_cost ? `<details class="pw-costs"${draft.costMode !== 'leave' ? ' open' : ''}><summary>Cost prices <span class="pw-muted">${draft.costMode === 'leave' ? 'Unchanged' : draft.costMode}</span></summary>
        <label>Cost pricing<select data-draft="costMode">${option('leave','Leave costs unchanged',draft.costMode === 'leave')}${option('fill','Fill missing costs',draft.costMode === 'fill')}${option('revise','Revise costs',draft.costMode === 'revise')}</select></label>
        ${draft.costMode !== 'leave' ? this.priceInput('Shared cost · per unit',draft.baseCost,'data-draft="baseCost"') : ''}
        ${draft.costMode === 'revise' ? `<label class="pw-check"><input type="checkbox" data-draft="keepCostOverrides"${draft.keepCostOverrides ? ' checked' : ''}>Keep individual size costs</label>` : ''}</details>` : ''}
      <div data-rule-editor>${draft.view === 'groups' ? this.groupTableHtml() : this.rulesHtml()}</div>
      <label class="pw-check"><input type="checkbox" data-draft="useRuleOrder"${draft.useRuleOrder ? ' checked' : ''}>Resolve overlaps by rule order (later wins)</label>
      <p class="pw-muted">Blank leaves a value unchanged. Fill missing protects existing effective prices, including prices inherited from a photo.</p>
      </section><section class="pw-preview" aria-label="Price preview"><h3>Your price preview</h3><div data-preview></div></section></div>`,
      '<div data-impact aria-live="polite"></div><button class="primary" data-review>Review exact changes</button>');
    this.bindEditor(); this.refreshPreview();
  }

  /** Rule predicates use actual catalog attributes; nested AND conditions express narrower exceptions. */
  rulesHtml() {
    return `<div class="pw-rule-list">${this.draft.rules.map((rule,index) => `<details class="pw-rule" open data-rule="${index}">
      <summary>${esc(rule.label || `Exception ${index+1}`)} <span class="pw-muted" data-rule-count="${index}"></span></summary>
      ${rule.conditions.map((condition,position) => this.conditionHtml(condition,position,`rule:${index}`)).join('')}
      <div class="pw-inline"><button class="ghost" data-rule-and="${index}">+ AND condition</button><button class="ghost" data-remove-rule="${index}">Remove exception</button></div>
      ${this.priceInput('Retail for this exception',rule.retail,`data-rule-price="${index}" data-field="retail"`)}
      ${this.caps.can_view_cost && this.draft.costMode !== 'leave' ? this.priceInput('Cost for this exception',rule.cost,`data-rule-price="${index}" data-field="cost"`) : ''}
      </details>`).join('')}</div><button class="ghost" data-add-rule>+ Add product or size exception</button>`;
  }

  /** Group rows edit ordinary rules, so switching views never discards a separate price engine. */
  groupTableHtml() {
    const fields = this.fields().filter(field => !field.key.startsWith('variant:'));
    const groups = new Map();
    for (const item of selectPricingScope(this.items,this.draft,this.categories)) {
      const conditions = this.draft.groupKeys.map(key => ({key,operator:'include',values:[pricingValue(item,null,key)]}));
      const key = JSON.stringify(conditions);
      if (!groups.has(key)) groups.set(key,{conditions,items:[]}); groups.get(key).items.push(item);
    }
    this.visibleGroups = [...groups.values()];
    return `<label>Group merchandise by<select multiple size="3" data-group-keys>${fields.map(field => option(field.key,field.label,this.draft.groupKeys.includes(field.key))).join('')}</select></label>
      <p class="pw-muted">Group edits become named exceptions in Build a rule. Size differences stay in the expandable preview.</p>
      ${this.visibleGroups.map((group,index) => {
        const rule = this.draft.rules.find(entry => JSON.stringify(entry.conditions) === JSON.stringify(group.conditions));
        const label = group.conditions.map(condition => this.valuesFor(condition.key).find(value => value.value === condition.values[0])?.label || 'Not specified').join(' / ');
        return `<div class="pw-group"><b>${esc(label)}</b><small>${plural(group.items.length,'photo')}</small>
          ${this.priceInput('Group retail price',rule?.retail,`data-group-price="${index}" data-field="retail"`,'Use matching rules / shared price')}
          ${this.caps.can_view_cost && this.draft.costMode !== 'leave' ? this.priceInput('Group cost',rule?.cost,`data-group-price="${index}" data-field="cost"`) : ''}</div>`;
      }).join('')}`;
  }

  /** Bind local edits once per redraw; text inputs only refresh the preview to retain focus. */
  bindEditor() {
    this.overlay.querySelectorAll('[data-money]').forEach(input => bindPriceInput(input));
    this.overlay.querySelectorAll('[data-view]').forEach(button => {button.onclick = () => {this.draft.view = button.dataset.view; this.renderEditor();};});
    this.overlay.querySelector('[data-resume]')?.addEventListener('click',() => this.resumePlan());
    this.overlay.querySelector('[data-new-draft]').onclick = () => {this.draft = createPricingDraft(); this.wasRestored = false; this.renderEditor();};
    this.overlay.querySelector('[data-add-filter]').onclick = () => {this.draft.filters.push({key:'brand',operator:'include',values:[]}); this.renderEditor();};
    this.overlay.querySelector('[data-add-rule]')?.addEventListener('click',() => {
      this.draft.rules.push({id:crypto.randomUUID(),conditions:[{key:'brand',operator:'include',values:[]}],retail:'',cost:''}); this.renderEditor();
    });
    this.overlay.querySelectorAll('[data-rule-and]').forEach(button => {button.onclick = () => {
      this.draft.rules[Number(button.dataset.ruleAnd)].conditions.push({key:'variant:size',operator:'include',values:[]}); this.renderEditor();
    };});
    this.overlay.querySelectorAll('[data-remove-rule]').forEach(button => {button.onclick = () => {this.draft.rules.splice(Number(button.dataset.removeRule),1); this.renderEditor();};});
    this.overlay.querySelectorAll('[data-condition]').forEach(row => this.bindCondition(row));
    this.overlay.querySelectorAll('[data-draft]').forEach(input => {input.oninput = () => {
      const key = input.dataset.draft; this.draft[key] = input.type === 'checkbox' ? input.checked : input.value;
      if (key === 'retailMode' && input.value === 'revise') this.draft.onlyMissing = false;
      if (['retailMode','costMode','onlyMissing'].includes(key)) this.renderEditor(); else this.refreshPreview();
    };});
    this.overlay.querySelectorAll('[data-rule-price]').forEach(input => {input.oninput = () => {
      this.draft.rules[Number(input.dataset.rulePrice)][input.dataset.field] = input.value; this.refreshPreview();
    };});
    this.overlay.querySelector('[data-group-keys]')?.addEventListener('change',event => {
      this.draft.groupKeys = [...event.target.selectedOptions].map(entry => entry.value); if (!this.draft.groupKeys.length) this.draft.groupKeys = ['brand']; this.renderEditor();
    });
    this.overlay.querySelectorAll('[data-group-price]').forEach(input => {input.oninput = () => {
      const group = this.visibleGroups[Number(input.dataset.groupPrice)];
      let rule = this.draft.rules.find(entry => JSON.stringify(entry.conditions) === JSON.stringify(group.conditions));
      if (!rule) {rule = {id:crypto.randomUUID(),label:'Group price',conditions:group.conditions,retail:'',cost:''}; this.draft.rules.push(rule);}
      rule[input.dataset.field] = input.value; this.refreshPreview();
    };});
    this.overlay.querySelector('[data-review]').onclick = () => this.reviewPlan();
  }

  /** Value sets and numeric bands update the same condition without stealing input focus. */
  bindCondition(row) {
    const index = Number(row.dataset.condition),prefix = row.dataset.prefix;
    const conditions = prefix === 'filter' ? this.draft.filters : this.draft.rules[Number(prefix.split(':')[1])].conditions;
    row.querySelector('[data-condition-key]').onchange = event => {conditions[index].key = event.target.value; conditions[index].values = []; conditions[index].operator = 'include'; this.renderEditor();};
    row.querySelector('[data-condition-operator]').onchange = event => {conditions[index].operator = event.target.value; this.renderEditor();};
    row.querySelector('[data-condition-values]')?.addEventListener('change',event => {conditions[index].values = [...event.target.selectedOptions].map(entry => entry.value); this.renderEditor();});
    for (const bound of ['min','max']) row.querySelector(`[data-condition-${bound}]`)?.addEventListener('input',event => {conditions[index][bound] = event.target.value; this.refreshPreview();});
    row.querySelector('[data-remove-condition]').onclick = () => {conditions.splice(index,1); this.renderEditor();};
  }

  showError(error) {
    const element = this.overlay.querySelector('.pw-error');
    element.hidden = !error; element.textContent = error?.message || error || '';
    if (error?.status === 409) {
      const refresh = document.createElement('button'); refresh.className = 'ghost'; refresh.textContent = 'Refresh items';
      refresh.onclick = () => this.loadItems(); element.appendChild(refresh);
    }
  }

  /** Show photo evidence once, with sellable sizes and price reasons underneath. */
  photoPreviewHtml(item,rows,index) {
    return `<details class="pw-photo" data-photo-id="${esc(item.id)}"${index === 0 ? ' open' : ''}><summary>
      ${item.image_url ? `<img src="${esc(item.image_url)}" alt="${esc(item.name || item.brand || 'Product photo')}" loading="lazy">` : ''}
      <span><b>${esc(item.name || item.brand || 'Unnamed item')}</b><small>${plural(rows.length,'variant')} · ${plural(rows.reduce((total,row) => total+Number(row.line.quantity),0),'unit')}</small><small data-photo-price-summary>${esc(photoPriceSummary(rows))}</small>${item.stock_distribution_source !== 'human_confirmed' ? '<small>Stock breakdown still needs confirmation before approval.</small>' : ''}</span></summary>
      <div class="pw-lines">${rows.map(row => `<div class="pw-line" data-line-row="${esc(row.line.id)}"><div><b>${esc(Object.values(row.line.variant_attributes || {}).join(' / ') || 'All units')}</b><small>${plural(row.line.quantity,'unit')}</small></div>
        <div><small>Current retail</small>${esc(money(row.before))}${this.caps.can_view_cost && this.draft.costMode !== 'leave' ? `<small>Cost: ${esc(money(row.costBefore))}</small>` : ''}</div><div><small>Proposed retail</small><b data-proposed-price>${esc(money(row.after))}</b><small data-price-reason>${esc(row.reason)}</small>${this.caps.can_view_cost && this.draft.costMode !== 'leave' ? `<small data-proposed-cost>Cost: ${esc(money(row.costAfter))}</small>` : ''}</div>
        <details class="pw-line-edit"><summary>Edit this size</summary>${this.priceInput('Individual retail price',this.draft.lineEdits[row.line.id]?.retail === 'shared' ? '' : this.draft.lineEdits[row.line.id]?.retail,`data-line-price="${esc(row.line.id)}" data-field="retail"`)}
        <button class="ghost" data-use-shared="${esc(row.line.id)}" data-field="retail">Use shared retail</button>
        ${this.caps.can_view_cost && this.draft.costMode !== 'leave' ? `${this.priceInput('Individual cost',this.draft.lineEdits[row.line.id]?.cost === 'shared' ? '' : this.draft.lineEdits[row.line.id]?.cost,`data-line-price="${esc(row.line.id)}" data-field="cost"`)}<button class="ghost" data-use-shared="${esc(row.line.id)}" data-field="cost">Use shared cost</button>` : ''}</details></div>`).join('')}</div></details>`;
  }

  /** Local preview is a convenience; only the server review enables the final application. */
  refreshPreview() {
    this.persistDraft();
    try {
      const compiled = compilePricingDraft(this.items,this.draft,this.categories);
      this.compiled = compiled; this.showError(null);
      const target = this.overlay.querySelector('[data-preview]');
      const isEditingLine = target.contains(document.activeElement) && document.activeElement?.matches('[data-line-price]');
      const openPhotos = new Set([...target.querySelectorAll('[data-photo-id][open]')].map(element => element.dataset.photoId));
      if (!isEditingLine) target.innerHTML = `<p class="pw-muted">${plural(compiled.scoped.length,'photo')} · ${plural(compiled.rows.length,'variant')} · ${plural(compiled.rows.reduce((total,row) => total+Number(row.line.quantity),0),'unit')}</p>
        ${compiled.scoped.slice(0,this.photoLimit).map((item,index) => this.photoPreviewHtml(item,compiled.rows.filter(row => row.item.id === item.id),index)).join('') || '<p>No unpublished items match this scope.</p>'}
        ${compiled.scoped.length > this.photoLimit ? `<button class="ghost" data-more-photos>Show more photos (${this.photoLimit} of ${compiled.scoped.length} shown)</button>` : ''}`;
      target.querySelector('[data-more-photos]')?.addEventListener('click',() => {this.photoLimit += 40; this.refreshPreview();});
      target.querySelectorAll('[data-photo-id]').forEach(element => {if (openPhotos.has(element.dataset.photoId)) element.open = true;});
      if (isEditingLine) target.querySelectorAll('[data-line-row]').forEach(element => {
        const row = compiled.rows.find(entry => entry.line.id === element.dataset.lineRow);
        if (row) {
          element.querySelector('[data-proposed-price]').textContent = money(row.after);
          element.querySelector('[data-price-reason]').textContent = row.reason;
          const cost = element.querySelector('[data-proposed-cost]');
          if (cost) cost.textContent = `Cost: ${money(row.costAfter)}`;
        }
      });
      if (isEditingLine) target.querySelectorAll('[data-photo-id]').forEach(element => {
        element.querySelector('[data-photo-price-summary]').textContent = photoPriceSummary(compiled.rows.filter(row => row.item.id === element.dataset.photoId));
      });
      const changes = compiled.rows.filter(row => row.changed).length;
      this.overlay.querySelector('[data-impact]').textContent = `${changes} effective price changes · ${compiled.rows.filter(row => row.protected && !row.changed).length} protected`;
      this.overlay.querySelector('[data-review]').disabled = !compiled.rows.length || this.isBusy;
      this.overlay.querySelectorAll('[data-rule-count]').forEach(element => {
        const rule = this.draft.rules[Number(element.dataset.ruleCount)];
        element.textContent = plural(compiled.rows.filter(row => rule.conditions.every(condition => matchesPricingCondition(row.item,row.line,condition,this.categories))).length,'match');
      });
      if (!isEditingLine) target.querySelectorAll('[data-money]').forEach(input => bindPriceInput(input));
      target.querySelectorAll('[data-line-price]').forEach(input => {input.oninput = () => {
        (this.draft.lineEdits[input.dataset.linePrice] ||= {})[input.dataset.field] = input.value; this.refreshPreview();
      };});
      target.querySelectorAll('[data-use-shared]').forEach(button => {button.onclick = () => {
        (this.draft.lineEdits[button.dataset.useShared] ||= {})[button.dataset.field] = 'shared'; this.refreshPreview();
      };});
    } catch (error) {
      this.compiled = null; this.showError(error);
      this.overlay.querySelector('[data-review]').disabled = true;
      this.overlay.querySelector('[data-impact]').textContent = 'Resolve the pricing issue to continue';
    }
  }

  /** Persist the precise proposal before exposing an Apply action. */
  async reviewPlan() {
    if (this.isBusy) return;
    this.isBusy = true; this.overlay.querySelector('[data-review]').disabled = true;
    try {
      const compiled = compilePricingDraft(this.items,this.draft,this.categories);
      this.plan = await this.request('/catalog/pricing/preview',compiled.payload);
      this.lastPlanId = this.plan.id; this.persistDraft(); this.isBusy = false; this.renderPlan();
    } catch (error) {this.isBusy = false; this.showError(error); this.overlay.querySelector('[data-review]').disabled = false;}
  }

  async resumePlan() {
    if (this.isBusy) return; this.isBusy = true;
    try {this.plan = await this.request(`/catalog/pricing/plans/${this.lastPlanId}`,undefined,'GET'); this.didChange ||= this.plan.status !== 'preview'; this.isBusy = false; this.renderPlan();}
    catch (error) {this.isBusy = false; this.showError(error);}
  }

  /** Server rows show the exact reviewed values, including costs only when authorized. */
  renderPlan() {
    const plan = this.plan,isPreview = plan.status === 'preview',isApplied = plan.status === 'applied';
    const count = plan.summary.changed_count;
    // An undone receipt reads in the actual direction of restoration.
    const displayRows = plan.status !== 'undone' ? plan.rows : plan.rows.map(row => ({...row,
      price_before:row.price_after,price_after:row.price_before,cost_before:row.cost_after,cost_after:row.cost_before,
      price_protected:false,price_source:'Restored previous pricing'}));
    this.renderShell(`<div class="pw-intro"><div><h2>${isPreview ? 'Review exact changes' : isApplied ? 'Prices saved' : 'Pricing undone'}</h2>
      <p>${plural(plan.summary.item_count,'photo')} · ${plural(plan.summary.variant_count,'variant')} · ${plural(plan.summary.total_units,'unit')}</p></div><span class="pw-badge">${esc(plan.status)}</span></div>
      <div class="pw-notice">${isPreview ? 'These are the exact prices to apply. If prices, stock or product details change, you’ll need to review again.' : isApplied ? 'Your pricing receipt is saved. Undo is available until the affected items change or are published.' : 'The previous pricing values were restored.'}</div>
      ${plan.summary.missing_price_count ? `<p>${plural(plan.summary.missing_price_count,'variant')} still need a retail price. You can save this work and complete pricing later.</p>` : ''}
      <p>${plan.summary.changed_count} changed · ${plan.summary.protected_count} protected · ${plan.summary.unchanged_count ?? 0} unchanged</p>
      <div class="pw-review-table"><table><thead><tr><th>Item / size</th><th>Units</th><th>Retail before → after</th>${this.caps.can_view_cost ? '<th>Cost before → after</th>' : ''}</tr></thead><tbody>${displayRows.slice(0,this.reviewLimit).map(row => `<tr><td><b>${esc(row.name || row.brand || 'Item')}</b><small>${esc(Object.values(row.variant_attributes).join(' / ') || 'All units')}</small><small>${row.price_protected ? 'Existing price protected' : esc(row.price_source)}</small></td><td>${row.quantity}</td><td>${esc(money(row.price_before))}<br><b>→ ${esc(money(row.price_after))}</b></td>${this.caps.can_view_cost ? `<td>${esc(money(row.cost_before))}<br><b>→ ${esc(money(row.cost_after))}</b>${row.price_after != null && row.cost_after != null && row.price_after < row.cost_after ? '<small class="pw-warning">Below cost</small>' : ''}</td>` : ''}</tr>`).join('')}</tbody></table></div>
      ${plan.rows.length > this.reviewLimit ? `<button class="ghost" data-more-review>Show more variants (${this.reviewLimit} of ${plan.rows.length} shown)</button>` : ''}
      <p class="pw-muted">${isPreview ? 'Saving prices does not approve or import stock to POS.' : `Receipt ${esc(plan.id)}`}</p>`,
      `<button class="ghost" data-back>${isPreview ? 'Back to draft' : 'Continue pricing'}</button><span>${plural(count,'variant')} ${isPreview ? 'will change' : 'in receipt'}</span>
      ${isPreview ? `<button class="primary" data-apply>Apply prices to ${plural(count,'variant')}</button>` : isApplied ? '<button class="ghost" data-undo>Undo this pricing</button><button class="primary" data-done>Continue review</button>' : '<button class="primary" data-done>Continue review</button>'}`);
    this.overlay.querySelector('[data-more-review]')?.addEventListener('click',() => {this.reviewLimit += 100; this.renderPlan();});
    this.overlay.querySelector('[data-back]').onclick = () => {if (isPreview) this.renderEditor(); else this.loadItems();};
    this.overlay.querySelector('[data-done]')?.addEventListener('click',() => this.close());
    this.overlay.querySelector('[data-apply]')?.addEventListener('click',() => this.applyOrUndo('apply'));
    this.overlay.querySelector('[data-undo]')?.addEventListener('click',() => this.applyOrUndo('undo'));
  }

  /** Keep an uncertain network result recoverable through the same durable plan ID. */
  async applyOrUndo(operation) {
    if (this.isBusy) return; this.isBusy = true;
    this.didChange = true; // A lost response may still mean the server committed; refresh on close.
    this.overlay.querySelectorAll('button').forEach(button => {button.disabled = true;});
    try {
      this.plan = await this.request(`/catalog/pricing/plans/${this.plan.id}/${operation}`,{});
      this.didChange = true; this.isBusy = false; this.renderPlan();
    } catch (error) {
      this.isBusy = false; this.overlay.querySelectorAll('button').forEach(button => {button.disabled = false;});
      this.showError(error.status === 0 ? 'The result is uncertain. Retry this same action or reopen Last review to recover its receipt.' : error);
    }
  }
}
