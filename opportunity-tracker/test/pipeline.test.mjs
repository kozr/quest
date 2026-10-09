import test from 'node:test';
import {PIPELINE_VERSION} from '../pipeline-contract.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {Store} from '../store.mjs';
import {FirestoreStore} from '../firestore-store.mjs';
import {createTrackerApp,validateProduct} from '../server.mjs';
import {validateSearchPlan,activeSearchPlan,validateSavedPlan,listeningReady} from '../search-plan.mjs';
import {stageContext,stageSnapshot,validateStageRecords} from '../pipeline-stages.mjs';
import {stageRequest,stageReservation,createStageProvider} from '../pipeline-provider.mjs';
import {validateV2Qualification} from '../listening-qualification.mjs';
import {validateInsights,independentThreads} from '../listening-insights.mjs';
import {validateActions,validateDrafts} from '../action-stages.mjs';
import {captureEvidence,reviewEvidenceFor,findEvidence} from '../conversation-evidence.mjs';
import {collectionSettings} from '../collection.mjs';
import {backfillPlan} from '../backfill.mjs';
import {qualificationSettings,budgetDay,qualificationBackup} from '../qualification.mjs';
import {dueSources} from '../monitor.mjs';
import {v2Business,plan,conversations,stageValue,pipelineProvider} from './pipeline.fixture.mjs';
const env={TRACKER_AI_ENABLED:'true',TRACKER_AI_MODE:'ongoing',TRACKER_AI_DAILY_BUDGET_USD:'2',TRACKER_OPENAI_API_KEY:'fixture',TRACKER_COLLECTION_PIPELINE:'experiment-v1',SCRAPEBADGER_API_KEY:'fixture'};
async function fixture(t,options={}){
 const dir=await mkdtemp(join(tmpdir(),'listening-v2-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const app=createTrackerApp({dataDirectory:dir,qualificationEnv:env,stageProvider:pipelineProvider(),...options});
 const p=await app.store.saveProduct(v2Business());return {...app,p,dir};
}
async function activate(f){await f.runStage(f.p.id,'search_plan');const r=(await f.store.snapshot()).pipelineStages[f.p.id].search_plan;await f.store.saveSearchPlan(f.p.id,{...r.data,reviewed:true},'v2');}
async function collect(f){await f.store.recordSearch(f.p.id,{semantic:true,items:[],candidates:conversations(),sources:[],searchedAt:new Date().toISOString()});}
async function throughInsights(f){await activate(f);await collect(f);await f.runStage(f.p.id,'qualify');await f.runStage(f.p.id,'insights');}

test('public progress counts the whole queue and current v2 fit preserves saved legacy records',async t=>{
 const f=await fixture(t);await activate(f);
 const templates=conversations(),rows=Array.from({length:75},(_,n)=>({...templates[n===0?3:n%3],url:`https://www.reddit.com/r/vancouver/comments/batch${n}/`,sourceId:`t3_batch${n}`,postId:`t3_batch${n}`,author:`batch_author_${n}`}));
 await f.store.recordSearch(f.p.id,{semantic:true,items:[],candidates:rows,sources:[],searchedAt:new Date().toISOString()});
 const seed=f.store.snapshot();seed.items=[{...rows[0],id:'legacy-saved',productId:f.p.id,kind:'opportunity',status:'saved',note:'My research note',draft:'My draft',reason:'Previous v1 fit'}];f.store.commit(seed);
 const listener=f.app.listen(0,'127.0.0.1');await once(listener,'listening');t.after(()=>new Promise(resolve=>listener.close(resolve)));
 const state=async()=>{const r=await fetch(`http://127.0.0.1:${listener.address().port}/api/state`);assert.equal(r.status,200);return r.json();};
 let visible=await state();assert.equal(visible.pipeline.products[f.p.id].pending,75);assert.equal(stageContext(f.store.snapshot(),f.p.id,'qualify').input.evidence.length,12);assert.equal(visible.items.find(i=>i.id==='legacy-saved').currentOpportunityFit,false);
 await f.runStage(f.p.id,'qualify');visible=await state();assert.equal(visible.pipeline.products[f.p.id].pending,63);
 const saved=visible.items.find(i=>i.id==='legacy-saved');assert.equal(saved.currentOpportunityFit,false);assert.equal(saved.status,'saved');assert.equal(saved.note,'My research note');assert.equal(saved.draft,'My draft');
 const accepted=visible.items.find(i=>i.currentOpportunityFit===true);assert.equal(accepted.currentOpportunityFit,true);assert(accepted.qualification.profileHash);
 const retained=f.store.snapshot();retained.conversationEvidence[f.p.id]=retained.conversationEvidence[f.p.id].filter(r=>r.url!==accepted.url);f.store.commit(retained);
 assert.equal((await state()).items.find(i=>i.id===accepted.id).currentOpportunityFit,true);
 f.store.saveSearchPlan(f.p.id,null,'v1');assert.equal((await state()).items.find(i=>i.id==='legacy-saved').currentOpportunityFit,undefined);
});

test('v2 plan is reviewed, swappable and independent of legacy keyword settings',async t=>{
 const f=await fixture(t);await f.runStage(f.p.id,'search_plan');const record=f.store.snapshot().pipelineStages[f.p.id].search_plan;
 assert.equal(f.store.snapshot().products[0].listeningVersion,undefined);
 assert.throws(()=>f.store.saveSearchPlan(f.p.id,record.data,'v2'),/Review/);
 await f.store.saveSearchPlan(f.p.id,{...record.data,reviewed:true},'v2');let p=f.store.snapshot().products[0];
 assert.equal(activeSearchPlan(p).themes[0].queries.length,2);assert.deepEqual(p.keywords,f.p.keywords);
 f.store.saveSearchPlan(f.p.id,null,'v1');p=f.store.snapshot().products[0];assert.equal(activeSearchPlan(p),null);assert.deepEqual(p.communities,['vancouver']);
 assert.throws(()=>validateSavedPlan({...record.data,themes:[{...record.data.themes[0],queries:[{...record.data.themes[0].queries[0],query:'site:evil.test secret'}]}]}),/ordinary/);
 assert.throws(()=>validateSearchPlan({...plan(),themes:[{...plan().themes[0],offeringIds:['o8']}]},f.p),/unknown/);
 await f.store.saveSearchPlan(f.p.id,null,'v2');p=f.store.snapshot().products[0];
 f.store.saveProduct(validateProduct({...p,profileVersion:'v1'}),p.id);assert.equal(listeningReady(f.store.snapshot().products[0]),false);
 assert.deepEqual(dueSources({...f.store.snapshot().products[0],monitoring:true},f.store.snapshot()),[]);
});

test('collector executes active queries with distinct watermarks, preserves closed evidence and leaves v1 jobs untouched',async t=>{
 const f=await fixture(t);await activate(f);const now=Date.now(),settings=collectionSettings(env);
 let c=f.store.beginCollection(f.p.id,'manual',now);assert.equal(c.queue[0].kind,'search');assert.equal(c.queue[0].query,'subreddit:vancouver AND croissant AND sandwich');
 const req=f.store.claimCollection(settings,f.p.id,now);assert.match(new URL(req.url).searchParams.get('q'),/croissant/);assert.equal(req.task.includeClosed,true);
 f.store.finishCollection(req.token,{credits:5,result:{rows:conversations().map((row,index)=>({...row,publishedAt:new Date(now-(index+1)*60000).toISOString()})),cursor:null}},now+1);
 assert.equal(f.store.snapshot().conversationEvidence[f.p.id].length,4);assert.equal(Object.keys(f.store.snapshot().qualifications||{}).length,0);
 const req2=f.store.claimCollection(settings,f.p.id,now+16000);assert.match(req2.task.query,/pickup/);f.store.finishCollection(req2.token,{credits:5,result:{rows:[],cursor:null}},now+16001);
 assert.equal(Object.keys(f.store.snapshot().collection.watermarks).length,2);
 const p=f.store.snapshot().products[0];assert.equal(backfillPlan(p,[],now).length,2);assert.match(backfillPlan(p,[],now)[0].query,/croissant/);
 const next=f.store.beginCollection(f.p.id,'manual',now+1000000);const running=f.store.claimCollection(settings,f.p.id,now+1000000);
 f.store.saveSearchPlan(p.id,null,'v1');assert.equal(f.store.finishCollection(running.token,{credits:5,result:{rows:conversations(),cursor:null}},now+1000001).status,'profile_changed');
});

test('all stages retain non-fit complaints, dated independent sources and editable drafts without publishing',async t=>{
 const f=await fixture(t);await throughInsights(f);
 let state=f.store.snapshot();assert.equal(state.conversationEvidence[f.p.id].length,4);assert.equal(state.items.length,4);
 const complaint=state.conversationEvidence[f.p.id].find(r=>r.qualification.category==='complaint');assert.equal(complaint.qualification.directFit,false);assert.equal(complaint.qualification.relevant,true);
 const insight=state.pipelineStages[f.p.id].insights.data.insights[0];assert.equal(insight.independentThreadCount,3);assert.equal(insight.sources.length,3);assert(insight.sources.every(s=>s.url&&s.publishedAt&&s.quote));
 await f.runStage(f.p.id,'actions');await f.runStage(f.p.id,'drafts');state=f.store.snapshot();
 const drafts=structuredClone(state.pipelineStages[f.p.id].drafts.data);drafts.drafts[0].body+=' Check today’s hours before heading over.';f.store.saveDrafts(f.p.id,drafts);
 assert.match(f.store.snapshot().pipelineStages[f.p.id].drafts.data.drafts[0].body,/today/);
 const reopened=new Store(f.dir);assert.deepEqual(reopened.snapshot().pipelineStages,state.pipelineStages===undefined?{}:f.store.snapshot().pipelineStages);
 const cached=await f.runStage(f.p.id,'insights');assert.equal(cached.cached,true);
 const changed=f.store.snapshot();changed.conversationEvidence[f.p.id][0].qualification.need='A new need';f.store.commit(changed);
 assert.equal(stageSnapshot(f.store.snapshot())[f.p.id].insights.stale,true);await assert.rejects(()=>f.runStage(f.p.id,'drafts'),/Run the current/);
});

test('qualification and insights reject borrowed quotes, duplicate authors, duplicated threads and crossposts',async t=>{
 const f=await fixture(t);await activate(f);await collect(f);let c=stageContext(f.store.snapshot(),f.p.id,'qualify');
 const invalid=stageValue('qualify',c.input);invalid.results[0].quote='invented evidence';assert.throws(()=>validateV2Qualification(invalid,c.product,c.input),/exact quote/);
 await f.runStage(f.p.id,'qualify');c=stageContext(f.store.snapshot(),f.p.id,'insights');const good=stageValue('insights',c.input);
 for(const mutate of [rows=>rows[0].author=rows[1].author,rows=>rows[0].threadId=rows[1].threadId,rows=>rows[0].crosspost=true,rows=>rows[0].author=null,rows=>rows[0].community='another']){
  const input=structuredClone(c.input);const questions=input.evidence.filter(r=>r.qualification.category==='question');mutate(questions);assert.throws(()=>validateInsights(good,c.product,input),/independently/);
 }
 const same=c.input.evidence.filter(r=>r.qualification.category==='question').map(r=>({...r,title:'same title',text:'same question'}));assert.equal(independentThreads(same).length,1);
});

test('action and draft validation block closed targets and missing affiliation',async t=>{
 const f=await fixture(t);await throughInsights(f);let c=stageContext(f.store.snapshot(),f.p.id,'actions'),v=stageValue('actions',c.input);
 const target=c.input.insights[0].sources.find(s=>s.discussionClosed);v.actions[0].type='answer';v.actions[0].targetEvidenceId=target.id;assert.throws(()=>validateActions(v,c.product,c.input),/recent, open/);
 await f.runStage(f.p.id,'actions');c=stageContext(f.store.snapshot(),f.p.id,'drafts');v=stageValue('drafts',c.input);v.drafts[0].body='Just try our cafe.';assert.throws(()=>validateDrafts(v,c.product,c.input),/disclosure/);
});

test('stage leases share budget, reject stale dispatch results and cannot reset spending through restore',async t=>{
 const f=await fixture(t),now=Date.now(),settings=qualificationSettings(env,now),ctx=stageContext(f.store.snapshot(),f.p.id,'search_plan');
 const claimed=f.store.claimStage(f.p.id,'search_plan',settings,false,now);const held=f.store.snapshot().aiBudget.dailyUsage[budgetDay(now)].reservedMicroUsd;assert.equal(held,stageReservation('search_plan',ctx.input));
 assert.throws(()=>f.store.claimStage(f.p.id,'search_plan',settings,false,now),/already running/);
 f.store.saveProduct({...f.p,communities:['vancouver','canada']},f.p.id);assert.throws(()=>f.store.finishStage(claimed.lease,{value:plan(),model:'fixture',costMicroUsd:100},now+1),/inputs changed/);
 f.store.releaseAnalysis(claimed.lease.token);assert.equal(f.store.snapshot().aiBudget.dailyUsage[budgetDay(now)].spentMicroUsd,held);
 f.store.importData({version:1,products:[],items:[],searches:{},...qualificationBackup(f.store.snapshot()),aiBudget:{spentMicroUsd:0,reservedMicroUsd:0,calls:0,daily:{},dailyUsage:{}}});assert.equal(f.store.snapshot().aiBudget.dailyUsage[budgetDay(now)].spentMicroUsd,held);
});

test('stage provider uses tracker credentials, bounded schema output and conservative usage accounting',async()=>{
 const input={business:{name:'Fixture'}};let count=0;const provider=createStageProvider({env,request:async(url,opts)=>{
  count++;assert.equal(opts.headers.Authorization,'Bearer fixture');const r=JSON.parse(opts.body);assert.equal(r.model,'gpt-6.1-sol');assert.equal(r.reasoning.effort,'medium');assert.equal(r.tools,undefined);assert.equal(r.text.format.strict,true);
  return new Response(JSON.stringify({status:'completed',model:r.model,usage:{input_tokens:10,output_tokens:20},output_text:JSON.stringify(plan())}));
 }});
 assert.equal((await provider.run('search_plan',input)).costMicroUsd,220);assert.equal(count,1);
 const bad=createStageProvider({env,request:async()=>new Response(JSON.stringify({private:'secret'}),{status:500})});await assert.rejects(()=>bad.run('search_plan',input),e=>e.status===502&&!e.message.includes('secret'));
 assert.equal(createStageProvider({env:{OPENAI_API_KEY:'wrong'}}).available,false);assert(stageRequest('qualify',input).max_output_tokens<=8000);
});

test('Firestore CAS persists stage outputs, evidence and drafts across instances with one dispatch',async()=>{
 let data={version:1,products:[],items:[],searches:{}},revision=0;
 const backend={read:async()=>({data:structuredClone(data),revision}),compareAndSwap:async(expected,next)=>{if(expected!==revision)return false;data=structuredClone(next);revision++;return true;}};
 const a=new FirestoreStore(backend),b=new FirestoreStore(backend);const p=await a.saveProduct(v2Business());
 const claims=await Promise.allSettled([a.claimStage(p.id,'search_plan',null,false),b.claimStage(p.id,'search_plan',null,false)]);assert.equal(claims.filter(c=>c.status==='fulfilled').length,1);
 const claim=claims.find(c=>c.status==='fulfilled').value;await b.finishStage(claim.lease,{value:plan(),model:'fixture'});let s=await a.snapshot();assert.equal(s.pipelineStages[p.id].search_plan.data.themes.length,1);
 await a.saveSearchPlan(p.id,{...s.pipelineStages[p.id].search_plan.data,reviewed:true},'v2');await b.recordSearch(p.id,{items:[],candidates:conversations(),sources:[],semantic:true,searchedAt:new Date().toISOString()});assert.equal((await a.snapshot()).conversationEvidence[p.id].length,4);
 const f={...createTrackerApp({store:b,qualificationEnv:env,stageProvider:pipelineProvider()}),p};await f.runStage(p.id,'qualify');await f.runStage(p.id,'insights');await f.runStage(p.id,'actions');await f.runStage(p.id,'drafts');assert.equal((await a.snapshot()).pipelineStages[p.id].drafts.data.drafts.length,1);
});

test('authenticated routes export and restore bounded historical stages and evidence; action tier can be disabled',async t=>{
 const f=await fixture(t);await throughInsights(f);await f.runStage(f.p.id,'actions');await f.runStage(f.p.id,'drafts');
 const server=f.app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}/api`;
 const state=await (await fetch(base+'/state')).json();assert.equal(state.pipeline.products[f.p.id].relevant,4);
 assert.equal((await fetch(base+`/products/${f.p.id}/stages/insights`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 const exported=await (await fetch(base+'/export')).json();const restored=await fetch(base+'/import',{method:'POST',headers:{'Content-Type':'application/json','X-Tracker-Token':state.token},body:JSON.stringify(exported)});assert.equal(restored.status,200,await restored.text());
 const after=f.store.snapshot();assert.equal(after.pipelineStages[f.p.id].drafts.imported,true);assert.equal(after.conversationEvidence[f.p.id].length,4);assert(after.conversationEvidence[f.p.id].every(r=>!r.qualification));assert.equal(stageSnapshot(after)[f.p.id].drafts.stale,true);
 const disabled=createTrackerApp({store:f.store,qualificationEnv:{...env,TRACKER_ACTIONS_ENABLED:'false'},stageProvider:pipelineProvider()});await assert.rejects(()=>disabled.runStage(f.p.id,'actions'),e=>e.status===403);
});

test('collection refreshes and new arrivals do not discard a valid in-flight qualification batch or stale unchanged insights',async t=>{
 const f=await fixture(t);await activate(f);const rows=conversations(),at=Date.now();
 const search=(candidates,searchedAt)=>f.store.recordSearch(f.p.id,{semantic:true,items:[],candidates,sources:[],searchedAt});
 search(rows,new Date(at).toISOString());const claim=f.store.claimStage(f.p.id,'qualify',null,false,at);
 search(rows,new Date(at+1).toISOString());
 const extra={...rows[0],url:'https://www.reddit.com/r/vancouver/comments/extranew/',author:'another_author',snippet:'Where is lunch?',postId:'t3_extranew'};search([extra],new Date(at+2).toISOString());
 f.store.finishStage(claim.lease,{value:stageValue('qualify',claim.input),model:'fixture'},at+3);
 assert.equal(f.store.snapshot().conversationEvidence[f.p.id].filter(r=>r.qualification).length,4);
 await f.runStage(f.p.id,'insights');const before=stageSnapshot(f.store.snapshot())[f.p.id].insights;assert.equal(before.stale,false);
 search(rows,new Date(at+4).toISOString());assert.equal(stageSnapshot(f.store.snapshot())[f.p.id].insights.stale,false);
});

 test('one invalid conversation preserves valid decisions and cannot be automatically repaid',async t=>{
  const f=await fixture(t);await activate(f);const source=conversations();
  f.store.recordSearch(f.p.id,{semantic:true,items:[],candidates:source,sources:[],searchedAt:new Date().toISOString()});
  const now=Date.now(),claimed=f.store.claimStage(f.p.id,'qualify',qualificationSettings(env,now),false,now),value=stageValue('qualify',claimed.input);
  const invalidId=value.results[0].evidenceId;value.results[0].quote='This sentence was invented.';
  const completed=f.store.finishStage(claimed.lease,{value,model:'fixture',costMicroUsd:1000},now+1);
  assert.equal(completed.data.results.length,3);assert.equal(completed.failed.length,1);assert.equal(completed.failed[0].evidenceId,invalidId);
  const after=f.store.snapshot();assert.equal(after.items.length,3);
  const cloud=new FirestoreStore({read:async()=>({data:after,revision:1})});assert.deepEqual((await cloud.snapshot()).conversationReviewFailures,after.conversationReviewFailures);
  f.store.importData(after);assert.deepEqual(f.store.snapshot().conversationReviewFailures,after.conversationReviewFailures);assert.equal(after.conversationReviewFailures[f.p.id][invalidId].reason,'Qualification needs an exact quote from its own conversation.');
  assert.equal(after.aiBudget.dailyUsage[budgetDay(now)].spentMicroUsd,1000);
  const evicted=structuredClone(after);evicted.conversationEvidence[f.p.id]=[];assert.equal(reviewEvidenceFor(evicted,after.products[0])[0].id,invalidId);assert.equal(findEvidence(evicted,f.p,invalidId).text,after.conversationReviewFailures[f.p.id][invalidId].row.text);
  assert.throws(()=>f.store.claimStage(f.p.id,'qualify',qualificationSettings(env,now),false,now+2),/No unqualified/);
  f.store.recordSearch(f.p.id,{semantic:true,items:[],candidates:source,sources:[],searchedAt:new Date(now+3).toISOString()});
  assert.throws(()=>f.store.claimStage(f.p.id,'qualify',qualificationSettings(env,now),false,now+4),/No unqualified/);
 });
 test('unknown qualification outcomes retain failed source evidence and stop automatic retries',async t=>{
  const f=await fixture(t);await activate(f);f.store.recordSearch(f.p.id,{semantic:true,items:[],candidates:conversations(),sources:[],searchedAt:new Date().toISOString()});
  let calls=0;const tracker=createTrackerApp({store:f.store,qualificationEnv:env,stageProvider:{available:true,run:async()=>{calls++;throw Object.assign(new Error('The stage could not finish.'),{status:502});}}});
  await assert.rejects(()=>tracker.runQualification(f.p.id),/could not finish/);
  assert.equal(Object.keys(f.store.snapshot().conversationReviewFailures[f.p.id]).length,4);
  assert.equal((await tracker.runQualification(f.p.id)).status,'complete');assert.equal(calls,1);
  assert.equal(f.store.snapshot().items.length,0);assert.equal(Object.keys(f.store.snapshot().analysisLeases).length,0);
 });


test('qualification uses its metered allowance while research keeps its request cap',async t=>{
 const f=await fixture(t);await activate(f);await collect(f);const now=Date.now(),day=budgetDay(now),settings=qualificationSettings(env,now);
 const data=f.store.snapshot();data.analysisUsage={[day]:40};f.store.commit(data);
 assert.throws(()=>f.store.claimStage(f.p.id,'search_plan',settings,true,now),/daily analysis request limit/);
 const claim=f.store.claimStage(f.p.id,'qualify',settings,false,now);assert.equal(f.store.snapshot().analysisUsage[day],40);
 f.store.finishStage(claim.lease,{value:stageValue('qualify',claim.input),model:'fixture',costMicroUsd:1000},now+1);
 const limited=f.store.snapshot();limited.aiBudget.dailyUsage[day].calls=settings.dailyMaxCalls;f.store.commit(limited);
 const rows=conversations().map(r=>({...r,url:r.url.replace(/\/comments\/([^/]+)\//,'/comments/$1new/'),postId:r.postId+'new',sourceId:r.sourceId+'new'}));f.store.recordSearch(f.p.id,{semantic:true,items:[],candidates:rows,sources:[],searchedAt:new Date(now+2).toISOString()});
 assert.throws(()=>f.store.claimStage(f.p.id,'qualify',settings,false,now+3),/daily AI allowance/);
});


test('background qualification gives the waiting business a turn before repeating another batch',async t=>{
 const f=await fixture(t);await activate(f);await collect(f);
 const other=f.store.saveProduct(v2Business());await f.runStage(other.id,'search_plan');f.store.saveSearchPlan(other.id,{...f.store.snapshot().pipelineStages[other.id].search_plan.data,reviewed:true},'v2');
 f.store.recordSearch(other.id,{semantic:true,items:[],candidates:conversations(),sources:[],searchedAt:new Date().toISOString()});
 const data=f.store.snapshot();data.products.forEach(p=>p.monitoring=true);data.pipelineStages[f.p.id].qualify={generatedAt:new Date().toISOString()};f.store.commit(data);
 await f.runQualification();assert(f.store.snapshot().items.some(i=>i.productId===other.id));assert.equal(f.store.snapshot().items.some(i=>i.productId===f.p.id),false);
});


test('legacy qualification stage imports remain unverified history without weakening live entity validation',()=>{
 const product={...v2Business(),id:'legacy-import',listeningVersion:'v2'},source={id:'a'.repeat(24),type:'post',title:'Fixture Cafe in Vancouver',text:'Fixture Cafe in Vancouver serves croissant sandwiches.'};
 const input={business:{offerings:product.businessProfileV2.offerings},evidence:[source]},output=stageValue('qualify',input);
 output.results[0].purposes.push({purpose:'mention',quote:source.text,reason:'Names the business.',offeringIds:[],reference:product.name});
 const row={version:PIPELINE_VERSION,stage:'qualify',inputHash:'a'.repeat(64),generatedAt:new Date().toISOString(),model:'legacy',data:output};
 const restored=validateStageRecords({[product.id]:{qualify:row}},[product])[product.id].qualify;
 assert.equal(restored.imported,true);assert.equal(restored.data.results[0].entityMatch.status,'uncertain');assert.equal(restored.data.results[0].purposes.some(signal=>signal.purpose==='mention'),false);assert.equal(restored.data.results[0].purposes.some(signal=>signal.purpose==='feedback'),true);
 assert.equal(output.results[0].entityMatch,undefined,'Import normalization does not change the original export.');
 assert.throws(()=>validateV2Qualification(output,product,input),/identity|entity/i);
 const malformed=structuredClone(row);malformed.data.results[0].entityMatch=null;assert.throws(()=>validateStageRecords({[product.id]:{qualify:malformed}},[product]),/Invalid imported/);
});
