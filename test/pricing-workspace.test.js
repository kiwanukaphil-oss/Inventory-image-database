import {describe,it,expect} from 'vitest';
import {createPricingDraft,compilePricingDraft,selectPricingScope,pricingDraftForStorage,catalogPriceRange} from '../src/lib/pricing-workspace.js';
import {sortItems} from '../src/lib/itemsort.js';
import {matchesItem} from '../src/lib/facets.js';

const item = {id:'a',name:'Linen shirt',brand:'Essential',category_id:'shirts',attributes:{material:'Linen'},base_price:null,revision:'revision',lines:[
  {id:'s',variant_attributes:{size:'S'},quantity:1,effective_price:null,price_override:null,effective_cost:null,cost_override:null},
  {id:'xl',variant_attributes:{size:'XL'},quantity:10,effective_price:null,price_override:null,effective_cost:null,cost_override:null},
]};
const condition = (key,values,operator='include') => ({key,values,operator});
const draft = changes => ({...createPricingDraft(),basePrice:'90,000',...changes});

describe('pricing workspace',() => {
  it('compiles one photo into distinct size decisions without multiplying unit prices',() => {
    const result = compilePricingDraft([item],draft({rules:[{conditions:[condition('variant:size',['XL'])],retail:'100000'}]}));
    expect(result.payload.items[0]).toMatchObject({base_price:90000,target_line_ids:['s','xl'],lines:[{id:'xl',price_override:100000}]});
    expect(result.rows.map(row => row.after)).toEqual([90000,100000]);
  });
  it('filters by merchandise AND size, never widening to siblings',() => {
    const result=compilePricingDraft([item],draft({filters:[condition('brand',['Essential']),condition('variant:size',['XL'])]}));
    expect(result.payload.items[0]).not.toHaveProperty('base_price');
    expect(result.payload.items[0].target_line_ids).toEqual(['xl']);
    expect(result.payload.items[0].lines).toEqual([{id:'xl',price_override:90000}]);
  });
  it('supports category descendants, OR values and exclusions',() => {
    const criteria=draft({filters:[condition('category',['clothing']),condition('brand',['Classic','Essential']),condition('material',['Cotton'],'exclude')]});
    expect(selectPricingScope([item],criteria,[{id:'shirts',parent_id:'clothing'},{id:'clothing'}])).toHaveLength(1);
    criteria.filters.push(condition('variant:size',['XL'],'exclude'));
    expect(selectPricingScope([item],criteria,[{id:'shirts',parent_id:'clothing'}])[0].targetLines.map(line=>line.id)).toEqual(['s']);
  });

  it('keeps numeric bands distinct from clothing sizes and refuses incomplete scope',() => {
    const trousers={...item,lines:[{...item.lines[0],id:'30',variant_attributes:{size:'30'}},{...item.lines[1],id:'34',variant_attributes:{size:'34'}},{...item.lines[1],id:'M',variant_attributes:{size:'M'}}]};
    const config=draft({filters:[{key:'variant:size',operator:'between',min:'30',max:'32',values:[]}]});
    expect(compilePricingDraft([trousers],config).rows.map(row=>row.line.id)).toEqual(['30']);
    config.filters[0].min='35'; expect(()=>compilePricingDraft([trousers],config)).toThrow(/valid numeric range/);
    expect(()=>compilePricingDraft([item],draft({filters:[condition('brand',[])]}))).toThrow(/Complete/);
  });
  it('protects inherited prices and keeps explicit prices in revise mode',() => {
    const priced={...item,base_price:80000,lines:item.lines.map(line => ({...line,effective_price:line.id === 'xl' ? 95000:80000,price_override:line.id === 'xl'?95000:null}))};
    expect(compilePricingDraft([priced],draft()).rows.map(row=>row.after)).toEqual([80000,95000]);
    expect(compilePricingDraft([priced],draft({retailMode:'revise'})).rows.map(row=>row.after)).toEqual([90000,95000]);
    expect(compilePricingDraft([priced],draft({retailMode:'revise',keepOverrides:false})).rows.map(row=>row.after)).toEqual([90000,90000]);
  });
  it('blocks overlapping sibling rules until order is explicitly selected',() => {
    const config=draft({rules:[{conditions:[condition('brand',['Essential'])],retail:'100000'},
      {conditions:[condition('material',['Linen'])],retail:'120000'}]});
    expect(()=>compilePricingDraft([item],config)).toThrow(/Overlapping/);
    config.useRuleOrder=true;
    expect(compilePricingDraft([item],config).rows.map(row=>row.after)).toEqual([120000,120000]);
  });
  it('lets a nested narrower rule win without depending on rule order',() => {
    const brand=condition('brand',['Essential']);
    const config=draft({rules:[{conditions:[brand,condition('variant:size',['XL'])],retail:'130000'},{conditions:[brand],retail:'100000'}]});
    expect(compilePricingDraft([item],config).rows.map(row=>row.after)).toEqual([100000,130000]);
  });
  it('shares resolution across views and gives direct size edits explicit precedence',() => {
    const config=draft({lineEdits:{xl:{retail:'140000'}}});
    const guided=compilePricingDraft([item],config);
    config.view='groups'; expect(compilePricingDraft([item],config)).toEqual(guided);
    expect(guided.payload.items[0].lines[0]).toMatchObject({price_override:140000,replace_price_override:true});
  });
  it('keeps cost-only edits independent and strips costs from device drafts',() => {
    const config=draft({retailMode:'leave',costMode:'fill',baseCost:'45000',rules:[{conditions:[condition('brand',['Essential'])],retail:'',cost:'47000'}],lineEdits:{xl:{retail:'',cost:'49000'}}});
    const result=compilePricingDraft([item],config);
    expect(result.payload.items[0]).not.toHaveProperty('base_price');
    expect(result.payload.items[0].base_cost_price).toBe(47000);
    expect(result.rows.map(row=>row.after)).toEqual([null,null]);
    const saved=pricingDraftForStorage(config);
    expect(saved.costMode).toBe('leave'); expect(saved.baseCost).toBe('');
    expect(saved.rules[0]).not.toHaveProperty('cost'); expect(saved.lineEdits.xl).not.toHaveProperty('cost');
  });

  it('marks only the directly edited field for override replacement',() => {
    const config=draft({retailMode:'revise',costMode:'revise',lineEdits:{xl:{cost:'49000'}}});
    const result=compilePricingDraft([item],config);
    const edit=result.payload.items[0].lines.find(line=>line.id==='xl');
    expect(edit.replace_cost_override).toBe(true);
    expect(edit).not.toHaveProperty('replace_price_override');
  });
  it('rejects invalid/empty exceptions and supports blank base with size-only pricing',() => {
    expect(()=>compilePricingDraft([item],draft({basePrice:'invalid'}))).toThrow();
    expect(()=>compilePricingDraft([item],draft({rules:[{conditions:[condition('brand',[])],retail:'1000'}]}))).toThrow(/Choose/);
    const result=compilePricingDraft([item],draft({basePrice:'',rules:[{conditions:[condition('variant:size',['XL'])],retail:'100000'}]}));
    expect(result.rows.map(row=>row.after)).toEqual([null,100000]);
  });
  it('shows and sorts effective ranges without a default and matches real prices rather than gaps',() => {
    const varied={id:'varied',price:null,variant_lines:[{quantity:1,effective_price:90},{quantity:2,effective_price:130}]};
    expect(catalogPriceRange(varied)).toMatchObject({min:90,max:130,missing:0});
    expect(sortItems([varied,{id:'single',price:110}], 'price-desc').map(row=>row.id)).toEqual(['varied','single']);
    const ctx={textOf:()=>'',passesQueue:()=>true,valueOf:()=>''};
    expect(matchesItem(varied,{active:{},priceMin:'100',priceMax:'120'},ctx)).toBe(false);
    expect(matchesItem(varied,{active:{},priceMin:'120',priceMax:'140'},ctx)).toBe(true);
  });
});
