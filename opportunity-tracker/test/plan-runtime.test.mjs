import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {Store} from '../store.mjs';
import {createTrackerApp} from '../server.mjs';
import {cafe,breakdown} from './business-profile.fixture.mjs';
import {validateSearchPlan} from '../search-plan.mjs';
import {PLAN_CATALOG} from '../plans.mjs';
import {monthlyPeriod,analysisUsageState} from '../usage.mjs';
import {captureEvidence} from '../conversation-evidence.mjs';
const owner={sub:'12345678901234567890',email:'owner@example.com'};
const env={TRACKER_COLLECTION_PIPELINE:'experiment-v1',SCRAPEBADGER_API_KEY:'fixture',TRACKER_OPENAI_API_KEY:'fixture',TRACKER_AI_ENABLED:'true',TRACKER_AI_MODE:'ongoing',TRACKER_AI_DAILY_BUDGET_USD:'2'};
const profile=()=>{const p={...cafe,monitoring:true};return {...p,profileVersion:'v2',businessProfileV2:{...breakdown(p),reviewed:true}};};
const reviewedPlan=p=>({...validateSearchPlan({themes:[{id:'lunch',title:'Find lunch',need:'Need lunch',purposes:['potential_customer'],offeringIds:['o1'],keywords:['sandwich'],longTail:[],queries:[{id:'literal',loop:'keyword',platform:'reddit',query:'croissant sandwich',community:'vancouver'},{id:'need',loop:'long_tail',platform:'reddit',query:'need lunch nearby',community:'vancouver'}]}],limitations:[]},p),reviewed:true});
async function fixture(t,{planId='starter',collector=true}={}){
 const directory=await mkdtemp(join(tmpdir(),'plan-runtime-'));const store=new Store(directory);store.mutate(data=>{data.subscription={planId,status:'manual'};});
 const calls={collection:0,match:0,research:0,stage:0,legacy:0};
 const tracker=createTrackerApp({store,dataDirectory:directory,workspace:'test',accountMode:true,principalFor:()=>owner,qualificationEnv:{...env,...(!collector?{TRACKER_COLLECTION_PIPELINE:'disabled'}:{})},stageProvider:{available:true,run:async(stage,input)=>{calls.stage++;return {value:{results:input.evidence.map(row=>({evidenceId:row.id,relevant:false,directFit:false,category:'other',need:'',quote:'',offeringIds:[],reason:'No relevant need.',resolved:'unknown',purposes:[]}))},model:'fixture',costMicroUsd:1};}},analysisProvider:{available:true,match:async()=>{calls.match++;return {summary:'Fixture',model:'fixture',costMicroUsd:1};},research:async()=>{calls.research++;return {summary:'Fixture',model:'fixture',costMicroUsd:1};}},collectionProvider:{fetchPage:async()=>{calls.collection++;return {credits:1,result:{rows:[],cursor:null,oldest:null}};}},discoverFn:async()=>{calls.legacy++;return {items:[],sources:[]};}});
 const server=tracker.app.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
 const auth=await fetch(origin+'/api/state').then(r=>r.json());const headers={'Content-Type':'application/json','X-Tracker-Token':auth.token};
 const request=async(path,body={},method='POST')=>{const res=await fetch(origin+path,{method,headers,body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 return {store,calls,request,origin,headers};
}
const item=(id,productId)=>({id,productId,source:'Reddit',sourceId:`t3_${id}`,postId:`t3_${id}`,type:'post',url:`https://www.reddit.com/r/vancouver/comments/${id}/`,title:'Lunch',snippet:`Need lunch ${id}`,publishedAt:new Date(Date.now()-1000).toISOString(),status:'new',kind:'conversation'});
for(const planId of Object.keys(PLAN_CATALOG))test(`${planId} HTTP plan activation queues reviewed 365-day history atomically`,async t=>{
 const {store,request}=await fixture(t,{planId});const p=profile();const saved=await request('/api/products',p);assert.equal(saved.status,201,JSON.stringify(saved.body));const id=saved.body.product.id,old=store.snapshot().collection?.backfills?.[id];
 const plan=reviewedPlan({...p,id});const activated=await request(`/api/products/${id}/search-plan`,{version:'v2',plan},'PUT');assert.equal(activated.status,200,JSON.stringify(activated.body));
 const job=store.snapshot().collection?.backfills?.[id];assert(job);assert.equal(job.status,'running');assert.equal(Date.parse(job.to)-Date.parse(job.from),365*86400000);assert(job.branches.some(b=>b.queryFamily==='long_tail'));if(old)assert.notEqual(job.id,old.id);
 const again=await request(`/api/products/${id}/search-plan`,{version:'v2',plan},'PUT');assert.equal(again.status,200);assert.equal(store.snapshot().collection.backfills[id].id,job.id);
});
test('HTTP manual match drains one candidate, obeys cadence, caches refresh, and preserves unique billing',async t=>{
 const {store,calls,request}=await fixture(t);const p=store.saveProduct(profile());store.mutate(data=>data.items=[item('a',p.id),item('b',p.id)]);
 const first=await request('/api/items/a/analysis',{refresh:true});assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(calls.match,1);assert.equal(analysisUsageState(store.snapshot()).monthly.completed,1);
 const second=await request('/api/items/b/analysis',{refresh:true});assert.equal(second.status,200);assert.equal(second.body.status,'not_due');assert.equal(calls.match,1);
 store.mutate(data=>{data.loopSchedules[p.id].analysis.lastStartedAt=new Date(Date.now()-86400001).toISOString();});
 const retry=await request('/api/items/a/analysis',{refresh:true});assert.equal(retry.status,200);assert.equal(retry.body.cached,true);assert.equal(calls.match,1);assert.equal(analysisUsageState(store.snapshot()).monthly.completed,1);
});
test('HTTP manual match cannot dispatch beyond the workspace monthly unique allowance',async t=>{
 const {store,calls,request}=await fixture(t);const p=store.saveProduct(profile());store.mutate(data=>{data.items=[item('a',p.id)];const period=monthlyPeriod(Date.now());data.usage={version:1,periods:{[period.key]:{startsAt:period.startsAt,resetAt:period.resetAt,units:Object.fromEntries(Array.from({length:1000},(_,i)=>[`fixture${i}`,{completed:true,completedAt:new Date().toISOString(),claims:[]}]))}},historical:{},reservations:{},executions:{}};});
 const response=await request('/api/items/a/analysis',{refresh:true});assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.status,'blocked');assert.equal(response.body.blocked.code,'monthly_analysis_limit');assert.equal(calls.match,0);
});
test('HTTP collection, research, stage and manual AI do not dispatch for an inactive account or blocked product',async t=>{
 const {store,calls,request}=await fixture(t);const p=store.saveProduct(profile());store.saveSearchPlan(p.id,reviewedPlan(p),'v2');store.mutate(data=>data.items=[item('a',p.id)]);
 const endpoints=[`/api/products/${p.id}/search`,`/api/products/${p.id}/research`,`/api/products/${p.id}/stages/search_plan`,'/api/items/a/analysis'];
 store.mutate(data=>data.subscription.status='cancelled');for(const path of endpoints){const res=await request(path,{refresh:true});assert(res.status>=400,`${path}: ${JSON.stringify(res)}`);}assert.deepEqual(calls,{collection:0,match:0,research:0,stage:0,legacy:0});
 store.mutate(data=>{data.subscription.status='manual';data.products[0].planMonitoringBlocked='plan_capacity';});for(const path of endpoints){const res=await request(path,{refresh:true});assert(res.status>=400||res.body.status==='plan_capacity',`${path}: ${JSON.stringify(res)}`);}assert.deepEqual(calls,{collection:0,match:0,research:0,stage:0,legacy:0});
});
test('HTTP provisioned v1 collection cannot fall through to uncadenced legacy dispatch when collector is disabled',async t=>{
 const {store,calls,request}=await fixture(t,{collector:false});const p=store.saveProduct({...cafe,monitoring:true});const res=await request(`/api/products/${p.id}/search`);assert.equal(res.status,503);assert.equal(res.body.code,'collection_required');assert.equal(calls.legacy,0);
});
test('HTTP V2 qualification drains its frozen daily snapshot across bounded requests',async t=>{
 const {store,calls,request}=await fixture(t);const p=store.saveProduct(profile());store.saveSearchPlan(p.id,reviewedPlan(p),'v2');
 store.mutate(data=>captureEvidence(data,data.products[0],Array.from({length:13},(_,i)=>item(`first${i}`,p.id)),new Date().toISOString()));
 const first=await request('/api/qualification/run',{productId:p.id});assert.equal(first.status,200,JSON.stringify(first.body));assert.equal(calls.stage,1);assert.equal(store.snapshot().analysisCycles[p.id].queue.length,1);
 store.mutate(data=>captureEvidence(data,data.products[0],[item('later',p.id)],new Date().toISOString()));
 const second=await request('/api/qualification/run',{productId:p.id});assert.equal(second.status,200,JSON.stringify(second.body));assert.equal(calls.stage,2);assert.equal(store.snapshot().analysisCycles[p.id].status,'complete');
 const third=await request('/api/qualification/run',{productId:p.id});assert.equal(third.status,200);assert.equal(third.body.status,'not_due');assert.equal(calls.stage,2);assert.equal(analysisUsageState(store.snapshot()).monthly.completed,13);
});
