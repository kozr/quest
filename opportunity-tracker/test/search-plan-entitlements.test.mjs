import test from 'node:test';
import assert from 'node:assert/strict';
import {cafe,breakdown} from './business-profile.fixture.mjs';
import {hash,PIPELINE_VERSION} from '../pipeline-contract.mjs';
import {capacityUsage} from '../plans.mjs';
import {QUERY_LOOPS,SEARCH_PLAN_SCHEMA,searchPlanInput,searchPlanInputHash,searchPlanGenerationInput,validateSearchPlan,validateSavedPlan,plannedQueries,activeSearchPlan} from '../search-plan.mjs';
import {STAGE_DEFINITIONS,stageContext,validateStageRecords} from '../pipeline-stages.mjs';

const product=(id='p')=>({...cafe,id,profileVersion:'v2',businessProfileV2:{...breakdown(),reviewed:true}});
const query=(id,loop='keyword')=>({id,loop,platform:'reddit',community:null,query:`customer need ${id}`});
const theme=(id,queries=[query(`${id}_keyword`)])=>({id,title:'Find useful lunch conversations',need:'Find a sandwich nearby',purposes:['potential_customer'],offeringIds:['o1'],keywords:['sandwich'],longTail:['Where can I find lunch?'],queries});
const plan=themes=>({themes,limitations:[]});
const activate=(p,value)=>({...p,listeningVersion:'v2',searchPlanV2:{...validateSearchPlan(value,p),reviewed:true}});

test('legacy queries migrate to keyword while preserving current business profile hash and theme capacity',()=>{
  const p=product(),value={...plan([theme('legacy',[{id:'old',platform:'reddit',community:null,query:'croissant sandwich'}])]),profileHash:searchPlanInputHash(p),reviewed:true};
  const migrated=validateSearchPlan(value,p);assert.equal(migrated.profileHash,value.profileHash);assert.equal(migrated.themes[0].queries[0].loop,'keyword');assert.equal(migrated.themes[0].legacyLongTail,true);
  assert.equal(capacityUsage({products:[{...p,searchPlanV2:migrated}]}).longTailThemes,1);
  assert.deepEqual(validateSavedPlan(migrated),migrated);
});
test('accepted pre-alias legacy hashes also survive executable family normalization',()=>{
  const p=product(),input=searchPlanInput(p),legacy={...input,business:Object.fromEntries(Object.entries(input.business).filter(([key])=>!['aliases','references','competitorNames'].includes(key)))};
  const value={...plan([theme('legacy',[{id:'old',platform:'reddit',community:null,query:'croissant sandwich'}])]),profileHash:hash(legacy),reviewed:true};
  assert.equal(validateSearchPlan(value,p).profileHash,value.profileHash);
});
test('query family filtering dispatches distinct executable searches without changing old callers',()=>{
  const p=activate(product(),plan([theme('mixed',[query('brand'),query('problem','long_tail')])]));
  assert.equal(plannedQueries(p,'reddit').length,2);assert.deepEqual(plannedQueries(p,'reddit',{loop:'keyword'}).map(q=>q.id),['brand']);
  assert.deepEqual(plannedQueries(p,'reddit',{loop:'long_tail'}).map(q=>q.id),['problem']);
  assert.equal(plannedQueries(p,'x',{loop:'long_tail'}).length,0);
  assert.equal(plannedQueries(p,'reddit',{loop:'long_tail'})[0].themeId,'mixed');
});
test('a long-tail-only theme never dispatches in the keyword family',()=>{
  const p=activate(product(),plan([{...theme('discovery',[query('need','long_tail')]),keywords:[]}]));
  assert.equal(plannedQueries(p,'reddit',{loop:'keyword'}).length,0);assert.equal(plannedQueries(p,'reddit',{loop:'long_tail'}).length,1);
  assert.deepEqual(capacityUsage({products:[p]}),{products:1,keywordSearches:0,longTailThemes:1,seats:0,members:0,pendingInvites:0});
});
test('the validator accommodates Team limits across more than six themes and twelve queries',()=>{
  const themes=Array.from({length:100},(_,i)=>theme(`keyword${i}`));
  themes.push(...Array.from({length:30},(_,i)=>theme(`discovery${i}`,Array.from({length:6},(_,j)=>query(`d${i}_${j}`,'long_tail')))));
  const value=validateSearchPlan(plan(themes),product());assert.equal(value.themes.length,130);
  assert.equal(capacityUsage({products:[{searchPlanV2:value}]}).keywordSearches,100);assert.equal(capacityUsage({products:[{searchPlanV2:value}]}).longTailThemes,30);
});
test('global keyword, long-tail-theme and per-theme expansion bounds cannot be bypassed',()=>{
  assert.throws(()=>validateSearchPlan(plan([theme('too_many',Array.from({length:101},(_,i)=>query(`q${i}`)))]),product()),error=>error.resource==='keywordSearches'&&error.limit===100);
  assert.throws(()=>validateSearchPlan(plan(Array.from({length:31},(_,i)=>theme(`t${i}`,[query(`q${i}`,'long_tail')]))),product()),error=>error.resource==='longTailThemes'&&error.limit===30);
  assert.throws(()=>validateSearchPlan(plan([theme('wide',Array.from({length:7},(_,i)=>query(`q${i}`,'long_tail')))]),product()),/no more than 6 long-tail/);
});
test('duplicates and invalid query families are rejected even across loops',()=>{
  assert.throws(()=>validateSearchPlan(plan([theme('mixed',[query('same'),query('same','long_tail')])]),product()),/IDs must be unique/);
  assert.throws(()=>validateSearchPlan(plan([theme('mixed',[{...query('a'),query:'Croissant sandwich'},{...query('b','long_tail'),query:'croissant  sandwich'}])]),product()),/duplicate search queries/);
  assert.throws(()=>validateSearchPlan(plan([theme('bad',[query('a','unknown')])]),product()),/unsupported value/);
  assert.throws(()=>validateSearchPlan(plan([theme('bad',[query('a',null)])]),product()),/unsupported value/);
});
test('generation receives only account capacity remaining after other active products',()=>{
  const current=activate(product(),plan([theme('current',Array.from({length:10},(_,i)=>query(`own${i}`)))]));
  const other={id:'other',searchPlanV2:{themes:[theme('other',Array.from({length:8},(_,i)=>query(`other${i}`))),theme('other_discovery',[query('discover','long_tail')])]}};
  const archived={id:'archived',archived:true,keywords:Array.from({length:100},()=> 'ignored')};
  const data={subscription:{planId:'growth',status:'manual'},products:[current,other,archived]};
  const input=searchPlanGenerationInput(data,current);assert.deepEqual(input.capacity,{keywordSearches:22,longTailThemes:9,maxLongTailQueriesPerTheme:6});
  assert.deepEqual(stageContext(data,current.id,'search_plan').input.capacity,input.capacity);
});
test('stage generation enforces available capacities and leaves generated plans unreviewed',()=>{
  const p=product(),input={...searchPlanInput(p),capacity:{keywordSearches:1,longTailThemes:1,maxLongTailQueriesPerTheme:6}};
  assert.throws(()=>STAGE_DEFINITIONS.search_plan.validate(plan([theme('too_many',[query('a'),query('b')])]),p,input),error=>error.code==='plan_capacity_exceeded'&&error.limit===1);
  const output=STAGE_DEFINITIONS.search_plan.validate({...plan([theme('okay')]),reviewed:true},p,input);
  assert.equal(output.reviewed,false);assert.equal(output.profileHash,searchPlanInputHash(p));
  assert.throws(()=>activeSearchPlan({...p,listeningVersion:'v2',searchPlanV2:output}),/Review/);
});
test('zero keyword capacity permits discovery only and zero total capacity avoids an unusable paid generation',()=>{
  const p=product(),other={id:'other',searchPlanV2:{themes:[theme('other',Array.from({length:30},(_,i)=>query(`q${i}`)))]}};
  const data={subscription:{planId:'growth',status:'manual'},products:[p,other]};const input=searchPlanGenerationInput(data,p);
  assert.equal(input.capacity.keywordSearches,0);assert.doesNotThrow(()=>STAGE_DEFINITIONS.search_plan.validate(plan([theme('discover',[query('need','long_tail')])]),p,input));
  other.searchPlanV2.themes.push(...Array.from({length:10},(_,i)=>theme(`d${i}`,[query(`d${i}`,'long_tail')])));
  assert.throws(()=>searchPlanGenerationInput(data,p),error=>error.resource==='searchPlanQueries'&&error.status===403);
});
test('plan upgrades change generation allowance but never invalidate a reviewed business-derived plan hash',()=>{
  const p=activate(product(),plan([theme('first')])),data={subscription:{planId:'starter',status:'manual'},products:[p]};
  const before=searchPlanGenerationInput(data,p),hashBefore=p.searchPlanV2.profileHash;data.subscription.planId='team';const after=searchPlanGenerationInput(data,p);
  assert.equal(before.capacity.keywordSearches,10);assert.equal(after.capacity.keywordSearches,100);
  assert.equal(activeSearchPlan(p).profileHash,hashBefore);assert.equal(validateSearchPlan(plan([theme('new')]),p,{input:after}).profileHash,hashBefore);
});
test('generated schema requires a valid query loop and legacy stage backups remain readable',()=>{
  const querySchema=SEARCH_PLAN_SCHEMA.properties.themes.items.properties.queries.items;
  assert(querySchema.required.includes('loop'));assert.deepEqual(querySchema.properties.loop.enum,QUERY_LOOPS);
  const p=product(),value=plan([theme('legacy',[{id:'old',platform:'reddit',community:null,query:'croissant sandwich'}])]);
  const record={version:PIPELINE_VERSION,stage:'search_plan',inputHash:'a'.repeat(64),generatedAt:new Date().toISOString(),model:'fixture',data:value};
  const restored=validateStageRecords({[p.id]:{search_plan:record}},[p]);assert.equal(restored[p.id].search_plan.data.themes[0].queries[0].loop,'keyword');assert.equal(restored[p.id].search_plan.imported,true);
});
