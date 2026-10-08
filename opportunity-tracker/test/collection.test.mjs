import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../store.mjs';
import {FirestoreStore} from '../firestore-store.mjs';
import {createTrackerApp} from '../server.mjs';
import {collectionSettings,createCollectionProvider,processCollection,collectionPublicState,xQueries} from '../collection.mjs';
import {qualificationSettings,processQualification,batchRequest,resolveBatch,solCost,qualificationBackup,validateQualificationHistory,budgetDay,createQualificationProvider} from '../qualification.mjs';
import {dueSources,MONITOR_INTERVAL_MS} from '../monitor.mjs';
const now=Date.parse('2026-10-08T08:00:00Z');
const env={TRACKER_COLLECTION_PIPELINE:'experiment-v1',SCRAPEBADGER_API_KEY:'fixture',TRACKER_OPENAI_API_KEY:'fixture',TRACKER_AI_ENABLED:'true',TRACKER_AI_MODE:'ongoing',TRACKER_AI_DAILY_BUDGET_USD:'2'};
const product={name:'Figure list',url:'https://example.com',description:'Track figures.',keywords:['figure checklist'],communities:['smiskis'],capabilities:['Track figures you own and want.'],needs:['Keep track of figures.'],aliases:[],exclusions:[],x:true,xQueries:['smiski wishlist','smiski duplicates'],monitoring:true};
const row=(id='abc1',extra={})=>({source:'Reddit',provider:'scrapebadger',sourceId:`t3_${id}`,postId:`t3_${id}`,parentId:null,type:'post',url:`https://www.reddit.com/r/smiskis/comments/${id}/`,title:'How do I keep track of my figures?',snippet:'I need a checklist of figures I own.',publishedAt:new Date(now-1000).toISOString(),collectedAt:new Date(now).toISOString(),commentCount:2,...extra});
async function fixture(t,custom=product){const directory=await mkdtemp(join(tmpdir(),'tracker-collection-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=new Store(directory),p=store.saveProduct(custom);return {store,p,directory};}
const settings=collectionSettings(env),ai=qualificationSettings(env,now);
const page=(rows=[],extra={})=>({credits:5,result:{rows,cursor:null,oldest:rows.length?Math.min(...rows.map(r=>Date.parse(r.publishedAt))):null,...extra}});
function allReject(batch){return {results:batch.jobs.map(j=>({id:j.key,decision:'rejected',explicitIntent:false,intentEvidenceId:null,postEvidenceIds:[],whyItFits:'',capabilityIds:[]}))};}

test('regular Reddit and X checks wait two hours; explicit X queries stay product-specific',()=>{
 assert.equal(MONITOR_INTERVAL_MS,7200000);
 const p={...product,id:'a',monitorAttempts:{reddit:new Date(now).toISOString(),x:new Date(now).toISOString()}};
 assert.deepEqual(dueSources(p,{searches:{}},now+7199999),[]);
 assert.deepEqual(dueSources(p,{searches:{}},now+7200000),['reddit','x']);
 assert.deepEqual(xQueries({...product,x:false}),[]);
 assert.deepEqual(xQueries(product),product.xQueries);
 assert.match(xQueries({...product,xQueries:[]})[0],/figure checklist/);
});

test('collection resumes across process restarts, reserves before dispatch, paces globally and never replays a lost response',async t=>{
 const {store,p,directory}=await fixture(t);store.beginCollection(p.id,'scheduled',now);
 const claim=store.claimCollection(settings,p.id,now);assert.equal(claim.task.kind,'listing');
 assert.equal(store.snapshot().collection.daily[budgetDay(now)].reservedCredits,102);
 const reopened=new Store(directory);assert.equal(reopened.claimCollection(settings,p.id,now+1000),null);
 const next=reopened.claimCollection(settings,p.id,now+45001);assert.equal(next.task.kind,'x');
 const daily=reopened.snapshot().collection.daily[budgetDay(now)];assert.equal(daily.uncertainCredits,102);
 assert.equal(reopened.finishCollection(claim.token,page([row()]),now+46000),null);
 assert.equal(reopened.snapshot().collection.receipts[0].credits,null);
});

test('rolling dates stop extra pages, listings supply post details, and unchanged comments skip until daily refresh',async t=>{
 const {store,p}=await fixture(t,{...product,x:false});
 store.beginCollection(p.id,'scheduled',now);
 const claim=store.claimCollection(settings,p.id,now);
 store.finishCollection(claim.token,page([row(),row('old1',{publishedAt:new Date(now-2*86400000).toISOString(),commentCount:0})],{cursor:'t3_more1'}),now+1000);
 assert.equal(store.snapshot().collection.cycles[p.id].queue[0].kind,'comments');
 const comments=store.claimCollection(settings,p.id,now+15000);
 assert.match(comments.url,/\/posts\/abc1\/comments/);
 assert.equal(comments.task.post.title,row().title);
 store.finishCollection(comments.token,page([]),now+16000);
 assert.equal(store.snapshot().collection.cycles[p.id].status,'complete');
 assert.equal(store.beginCollection(p.id,'scheduled',now+3600000),null);
 store.beginCollection(p.id,'scheduled',now+7200000);
 const second=store.claimCollection(settings,p.id,now+7200000);
 assert.equal(second.task.cutoff,now-15*60000);
 store.finishCollection(second.token,page([row()]),now+7201000);
 assert.equal(store.snapshot().collection.cycles[p.id].status,'complete','No redundant post-detail or comment request');
 store.beginCollection(p.id,'scheduled',now+86400000+20000);
 const daily=store.claimCollection(settings,p.id,now+86400000+20000);
 store.finishCollection(daily.token,page([row()]),now+86400000+21000);
 assert.equal(store.snapshot().collection.cycles[p.id].queue[0].kind,'comments');
});

test('failed pages keep the watermark, bounded pagination reports gaps and budget cap never dispatches',async t=>{
 const {store,p}=await fixture(t,{...product,x:false});store.beginCollection(p.id,'scheduled',now);
 const first=store.claimCollection(settings,p.id,now);store.finishCollection(first.token,{credits:5,error:'unavailable'},now+1);
 store.claimCollection(settings,p.id,now+15000);
 assert.deepEqual(store.snapshot().collection.watermarks,{});
 store.beginCollection(p.id,'scheduled',now+7200000);
 const next=store.claimCollection(settings,p.id,now+7200000);store.finishCollection(next.token,page([row()],{cursor:'t3_next'}),now+7200001);
 const second=store.claimCollection(settings,p.id,now+7215000);assert.equal(second.task.page,2);
 store.finishCollection(second.token,page([row()],{cursor:'t3_another'}),now+7215001);
 assert(store.snapshot().collection.cycles[p.id].errors.includes('listing:page_limit'));
 const state=store.snapshot();state.collection.daily[budgetDay(now)].spentCredits=3300;store.commit(state);
 assert.equal(store.claimCollection(settings,p.id,now+7230000),null);
 assert.equal(store.snapshot().collection.cycles[p.id].blocked,'daily_scraper_budget');
});

test('shared query cache saves paid calls without skipping another product’s own qualification',async t=>{
 const {store,p}=await fixture(t,{...product,x:false});const p2=store.saveProduct({...product,name:'Other',x:false});
 store.beginCollection(p.id,'manual',now);let c=store.claimCollection(settings,p.id,now);store.finishCollection(c.token,page([row('same',{commentCount:0})]),now+1);
 store.beginCollection(p2.id,'manual',now+16000);assert.equal(store.claimCollection(settings,p2.id,now+16000).cached,true);
 assert.equal(store.snapshot().collection.daily[budgetDay(now)].calls,1);
 assert.equal(Object.values(store.snapshot().qualifications).filter(j=>j.status==='pending').length,2);
});

test('Sol batches preserve canonical post/comment/X identity, validate authored evidence, retain usage and do not repay for duplicates',async t=>{
 const {store,p}=await fixture(t);const r=row(),comment=row('comment1',{source:'Reddit comment',sourceId:'t1_comment1',parentId:'t3_abc1',type:'comment',url:'https://www.reddit.com/r/smiskis/comments/abc1/_/comment1/'}),x=row('x1',{source:'X',sourceId:'x_123',postId:'x_123',url:'https://x.com/i/status/123'});
 store.recordSearch(p.id,{items:[],sources:[],semantic:true,candidates:[r,comment,x].map(r=>({...r,pipeline:'experiment-v1'})),searchedAt:new Date(now).toISOString(),trigger:'manual'});
 let calls=0;const provider={qualifyBatch:async batch=>{calls++;const request=batchRequest(batch.jobs);assert.equal(request.model,'gpt-6.1-sol');assert.equal(request.reasoning.effort,'medium');assert.equal(request.tools,undefined);
 return {value:{results:batch.jobs.map((j,index)=>({id:j.key,decision:'qualified',explicitIntent:true,intentEvidenceId:`candidate:${index}:post:body:0`,postEvidenceIds:[`candidate:${index}:post:body:0`],whyItFits:'Keep track of owned figures',capabilityIds:[j.profile.capabilities[0].id]}))},costMicroUsd:2000,usage:{input_tokens:500,output_tokens:100,output_tokens_details:{reasoning_tokens:30}}};}};
 assert.equal((await processQualification(store,ai,provider,{now})).assessed,3);assert.equal(calls,1);assert.equal(store.snapshot().items.length,3);
 const usage=store.snapshot().aiBudget.dailyUsage[budgetDay(now)];assert.equal(usage.calls,1);assert.equal(usage.spentMicroUsd,2000);assert.equal(usage.reservedMicroUsd,0);
 store.recordSearch(p.id,{items:[],sources:[],semantic:true,candidates:[r,comment,x].map(r=>({...r,pipeline:'experiment-v1'})),searchedAt:new Date(now+1).toISOString(),trigger:'manual'});
 assert.equal((await processQualification(store,ai,provider,{now:now+1})).status,'idle');assert.equal(calls,1);
 const backup=qualificationBackup(store.snapshot());assert.equal(Object.keys(validateQualificationHistory(backup).qualifications).length,3);
 const id=store.snapshot().items.find(i=>i.source==='X').id;store.updateItem(id,{status:'saved',note:'Keep',draft:'Keep my response'});
 store.recordSearch(p.id,{items:[],sources:[],semantic:true,candidates:[{...x,snippet:x.snippet+' I also need a wishlist.',pipeline:'experiment-v1'}],searchedAt:new Date(now+2).toISOString(),trigger:'manual'});
 await processQualification(store,ai,provider,{now:now+2});assert.equal(calls,2);assert.equal(store.snapshot().items.length,3);
 assert.equal(store.snapshot().items.find(i=>i.id===id).note,'Keep');
 assert.equal(store.snapshot().items.find(i=>i.id===id).draft,'Keep my response');
});

test('bad batch evidence consumes one conservative hold, retains uncertainty, and cannot be retried',async t=>{
 const {store,p}=await fixture(t);store.recordSearch(p.id,{items:[],sources:[],semantic:true,candidates:[{...row(),pipeline:'experiment-v1'}],searchedAt:new Date(now).toISOString(),trigger:'manual'});
 let calls=0;const provider={qualifyBatch:async batch=>{calls++;const result=allReject(batch);result.results[0].decision='qualified';result.results[0].intentEvidenceId='invented';return {value:result,costMicroUsd:100};}};
 assert.equal((await processQualification(store,ai,provider,{now})).status,'uncertain');assert.equal((await processQualification(store,ai,provider,{now:now+1})).status,'idle');assert.equal(calls,1);assert(store.snapshot().aiBudget.spentMicroUsd>100);
 assert.equal(solCost({input_tokens:1000,output_tokens:100,input_tokens_details:{cached_tokens:100,cache_write_tokens:100}}),2860);
});

test('concurrent cloud instances cannot overlap collector requests or Sol batches',async t=>{
 const {store,p}=await fixture(t,{...product,x:false});let data=store.snapshot(),revision=0;
 const backend={read:async()=>({revision,data:structuredClone(data)}),compareAndSwap:async(r,next)=>{if(r!==revision)return false;data=structuredClone(next);revision++;return true;}};
 const a=new FirestoreStore(backend),b=new FirestoreStore(backend);await a.beginCollection(p.id,'scheduled',now);
 const [x,y]=await Promise.all([a.claimCollection(settings,p.id,now),b.claimCollection(settings,p.id,now)]);assert.equal([x,y].filter(Boolean).length,1);
 await a.finishCollection((x||y).token,page([row('a1',{commentCount:0})]),now+1);
 const [one,two]=await Promise.all([a.claimQualificationBatch(ai,now+2),b.claimQualificationBatch(ai,now+2)]);assert.equal([one,two].filter(Boolean).length,1);
 assert.equal((await a.snapshot()).collection.daily[budgetDay(now)].calls,1);
});

test('provider meters actual Reddit and X receipts and never fetches post details for comment trees',async()=>{
 const requests=[];const provider=createCollectionProvider({env,fetchImpl:async(url,options)=>{requests.push(url);assert.equal(options.headers['X-API-Key'],'fixture');return new Response(JSON.stringify({data:[{id:'123',created_at:new Date(Date.now()-1000).toUTCString(),full_text:'Need a figure wishlist'}]}),{headers:{'X-Credits-Used':'1'}});}});
 const response=await provider.fetchPage({url:'https://scrapebadger.com/v1/twitter/tweets/advanced_search',task:{kind:'x'}});
 assert.equal(response.credits,1);assert.equal(response.result.rows[0].url,'https://x.com/i/status/123');assert.equal(requests.length,1);
});

test('manual checks enqueue immediately and scheduled processing continues the same cycle through the app',async t=>{
 const {store,p,directory}=await fixture(t,{...product,x:false,monitoring:false});let calls=0;
 const tracker=createTrackerApp({store,dataDirectory:directory,qualificationEnv:env,collectionProvider:{fetchPage:async()=>{calls++;return page([row('zero',{commentCount:0})]);}},discoverFn:async()=>{throw Error('Legacy collector should not run');}});
 await tracker.runSearch(p.id,false);assert.equal(calls,1);assert.equal(store.snapshot().collection.cycles[p.id].status,'complete');
 assert.equal(await tracker.runSearch(p.id,true),null);
});
