import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {Store} from '../store.mjs';
import {FirestoreStore} from '../firestore-store.mjs';
import {createTrackerApp} from '../server.mjs';
import {collectionSettings,collectionDueIds,collectionPublicState,createCollectionProvider} from '../collection.mjs';
import {backfillPlan,BACKFILL_LIMITS} from '../backfill.mjs';
import {qualificationSettings,qualificationKey,canonicalPost,budgetDay,processQualification} from '../qualification.mjs';
import {normalizeScrapeBadgerPost} from '../reddit/scrapebadger.mjs';
const now=Date.parse('2026-10-08T08:00:00Z'),DAY=86400000;
const env={TRACKER_COLLECTION_PIPELINE:'experiment-v1',SCRAPEBADGER_API_KEY:'fixture',TRACKER_OPENAI_API_KEY:'fixture',TRACKER_AI_ENABLED:'true',TRACKER_AI_MODE:'ongoing',TRACKER_AI_DAILY_BUDGET_USD:'2'};
const settings=collectionSettings(env),ai=qualificationSettings(env,now);
const product={name:'Fixture',url:'https://example.com',description:'Figure checklist',keywords:['figure checklist'],communities:['smiskis'],capabilities:['Track owned and missing figures.'],needs:['Need a checklist'],aliases:[],exclusions:[],x:true,xQueries:['smiski wishlist since:2020-01-01'],monitoring:false};
const row=(id='abc',extra={})=>({source:'Reddit',provider:'scrapebadger',sourceId:`t3_${id}`,postId:`t3_${id}`,type:'post',parentId:null,url:`https://www.reddit.com/r/smiskis/comments/${id}/`,title:'How can I track my figures?',snippet:'I need a checklist to track my figures.',publishedAt:new Date(now-180*DAY).toISOString(),commentCount:0,...extra});
const page=(rows=[],extra={})=>({credits:5,result:{rows,rawCount:rows.length,cursor:null,oldest:rows.length?Math.min(...rows.map(r=>Date.parse(r.publishedAt))):null,...extra}});
async function fixture(t,p=product){const dir=await mkdtemp(join(tmpdir(),'backfill-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new Store(dir),saved=store.saveProduct(p);return {store,p:saved,dir};}
function narrow(store,id,tasks){const d=store.snapshot(),j=d.collection.backfills[id];j.queue=tasks||j.queue.slice(0,1);store.commit(d);}

test('one-year onboarding plan uses profile-specific Reddit searches and twelve bounded X windows',()=>{
 const q=backfillPlan(product,product.xQueries,now),x=q.filter(t=>t.kind==='x'),r=q.filter(t=>t.kind==='search');
 assert.equal(x.length,12);assert.equal(Math.min(...x.map(t=>t.cutoff)),now-365*DAY);assert.equal(Math.max(...x.map(t=>t.until)),now);
 assert(x.every(t=>!t.query.includes('since:')));assert(r.some(t=>t.query.includes('subreddit:smiskis')));assert(r.some(t=>!t.name));assert(r.every(t=>t.sort==='relevance'));
 const cafe=backfillPlan({...product,keywords:['Vancouver cafe'],needs:['Find quiet seating and good coffee'],capabilities:['Quiet seating and espresso'],communities:['vancouver'],x:false},[],now);
 assert(cafe.some(t=>/coffee|espresso/.test(t.query)));assert(cafe.every(t=>!t.query.includes('smiski')));
});

test('new product and backfill are atomic, idempotent, durable, and work with monitoring off',async t=>{
 const {store,dir}=await fixture(t);const p=store.saveProduct(product,undefined,{backfill:true});const first=store.snapshot().collection.backfills[p.id];
 assert(first.queue.length);assert.equal(store.beginBackfill(p.id,now+1).id,first.id);
 const again=new Store(dir);assert(collectionDueIds(again.snapshot()).includes(p.id));assert.equal(again.snapshot().products.find(x=>x.id===p.id).monitoring,false);
});

test('historical search validates dates, includes outside-community topic results, and never advances regular watermarks',async t=>{
 const {store,p}=await fixture(t,{...product,x:false});store.beginBackfill(p.id,now);narrow(store,p.id);
 const request=store.claimCollection(settings,p.id,now),url=new URL(request.url);assert.equal(url.pathname,'/v1/reddit/search/posts');assert.equal(url.searchParams.get('t'),'year');
 const outside=row('outside',{url:'https://www.reddit.com/r/collectors/comments/outside/'});
 store.finishCollection(request.token,page([row(),outside,row('old',{publishedAt:new Date(now-366*DAY).toISOString()}),row('future',{publishedAt:new Date(now+DAY).toISOString()})]),now+1);
 const d=store.snapshot();assert.equal(d.collection.backfills[p.id].staged,2);assert.equal(d.collection.backfills[p.id].filtered,2);assert.deepEqual(d.collection.watermarks,{});assert.equal(d.searches[p.id],undefined);
 assert.equal(d.collection.backfills[p.id].status,'reviewing');assert(Object.values(d.qualifications).every(j=>j.status==='pending'));
});

test('previously skipped history becomes eligible, but settled or uncertain outcomes are never repaid',async t=>{
 const {store,p}=await fixture(t,{...product,x:false});const at=new Date(now).toISOString();
 store.recordSearch(p.id,{items:[],sources:[{name:'Reddit watchlist'}],searchedAt:at});
 store.recordSearch(p.id,{items:[],sources:[],semantic:true,candidates:[{...row(),pipeline:'experiment-v1',pipelineCutoff:at}],searchedAt:at,trigger:'manual'});
 assert.equal(Object.values(store.snapshot().qualifications)[0].status,'historical_skipped');
 store.beginBackfill(p.id,now);narrow(store,p.id);const c=store.claimCollection(settings,p.id,now);store.finishCollection(c.token,page([row(),row()]),now+1);
 assert.equal(Object.values(store.snapshot().qualifications).filter(j=>j.status==='pending').length,1);
 assert.equal(store.snapshot().collection.backfills[p.id].duplicates,1);
 const job=Object.values(store.snapshot().qualifications)[0];const d=store.snapshot();d.qualifications[job.key].status='uncertain';delete d.qualifications[job.key].row;delete d.qualifications[job.key].profile;
 const b=d.collection.backfills[p.id];b.status='running';b.queue=[c.task];store.commit(d);
 store.claimCollection(settings,p.id,now+16000);assert.equal(Object.values(store.snapshot().qualifications)[0].status,'uncertain');assert.equal(store.snapshot().collection.backfills[p.id].duplicates,3);
});

test('relevance-sorted Reddit pages do not stop at an old result; repeated cursors terminate with a gap',async t=>{
 const {store,p}=await fixture(t,{...product,x:false});store.beginBackfill(p.id,now);narrow(store,p.id);
 let c=store.claimCollection(settings,p.id,now);store.finishCollection(c.token,page([row('old',{publishedAt:new Date(now-400*DAY).toISOString()})],{cursor:'t3_more'}),now+1);
 assert.equal(store.snapshot().collection.backfills[p.id].queue[0].page,2);
 c=store.claimCollection(settings,p.id,now+16000);store.finishCollection(c.token,page([row()],{cursor:'t3_more'}),now+16001);
 assert(store.snapshot().collection.backfills[p.id].errors.includes('search:repeated_cursor'));
});

test('historical qualification streams during collection and preserves closed-discussion labels',async t=>{
 const {store,p}=await fixture(t,{...product,x:false});store.beginBackfill(p.id,now);
 const c=store.claimCollection(settings,p.id,now);store.finishCollection(c.token,page([row('closed',{discussionClosed:true})]),now+1);
 assert.equal(store.snapshot().collection.backfills[p.id].status,'running');
 let calls=0;const provider={qualifyBatch:async batch=>{calls++;return {costMicroUsd:1000,value:{results:batch.jobs.map((j,index)=>({id:j.key,decision:'qualified',explicitIntent:true,intentEvidenceId:`candidate:${index}:post:body:0`,postEvidenceIds:[`candidate:${index}:post:body:0`],whyItFits:'A checklist can record the figures the person owns.',capabilityIds:[j.profile.capabilities[0].id]}))}};}};
 await processQualification(store,ai,provider,{now:now+2});assert.equal(calls,1);assert.equal(store.snapshot().items.length,1);assert.equal(store.snapshot().items[0].historical,true);assert.equal(store.snapshot().items[0].discussionClosed,true);
});

test('regular collection and backfill alternate while preserving the two-hour regular cadence',async t=>{
 const {store,p}=await fixture(t,{...product,monitoring:true});store.beginBackfill(p.id,now);store.beginCollection(p.id,'scheduled',now);
 let c=store.claimCollection(settings,p.id,now);assert.equal(c.mode,'regular');store.finishCollection(c.token,page([]),now+1);
 c=store.claimCollection(settings,p.id,now+16000);assert.equal(c.mode,'backfill');store.finishCollection(c.token,page([]),now+16001);
 c=store.claimCollection(settings,p.id,now+32000);assert.equal(c.mode,'regular');store.finishCollection(c.token,page([]),now+32001);
 assert.equal(store.beginCollection(p.id,'scheduled',now+3600000),null);
});

test('backfill uses the shared daily budget and resumes without changing limits or replaying a lost dispatch',async t=>{
 const {store,p,dir}=await fixture(t,{...product,x:false});store.beginBackfill(p.id,now);
 const first=store.claimCollection(settings,p.id,now),reopened=new Store(dir);
 const second=reopened.claimCollection(settings,p.id,now+46000);assert.notEqual(second.token,first.token);assert.notEqual(second.task.query,first.task.query);
 reopened.finishCollection(second.token,page([]),now+46001);let d=reopened.snapshot();assert.equal(d.collection.daily[budgetDay(now)].uncertainCredits,102);
 d.collection.daily[budgetDay(now)].spentCredits=3300;reopened.commit(d);assert.equal(reopened.claimCollection(settings,p.id,now+62000),null);
 assert.equal(reopened.snapshot().collection.backfills[p.id].blocked,'daily_scraper_budget');assert(reopened.claimCollection(settings,p.id,now+DAY));
 assert.equal(reopened.finishCollection(first.token,page([row()]),now+DAY+1),null);
});

test('bounded pending queue applies backpressure instead of dropping unreviewed candidates',async t=>{
 const {store,p}=await fixture(t,{...product,x:false});store.beginBackfill(p.id,now);let d=store.snapshot(),job=d.collection.backfills[p.id];
 d.qualifications=Object.fromEntries(Array.from({length:150},(_,i)=>['job'+i,{productId:p.id,backfillId:job.id,status:'pending'}]));store.commit(d);
 assert.equal(store.claimCollection(settings,p.id,now),null);assert.equal(store.snapshot().collection.backfills[p.id].blocked,'awaiting_ai_review');assert.equal(store.snapshot().collection.backfills[p.id].requests,0);
 d=store.snapshot();for(const q of Object.values(d.qualifications))q.status='rejected';store.commit(d);assert(store.claimCollection(settings,p.id,now+16000));
});

test('completion waits for reviews; limits and empty results do not claim exhaustive coverage',async t=>{
 const {store,p}=await fixture(t,{...product,x:false});store.beginBackfill(p.id,now);narrow(store,p.id);const c=store.claimCollection(settings,p.id,now);store.finishCollection(c.token,page([row()]),now+1);
 assert.equal(store.snapshot().collection.backfills[p.id].status,'reviewing');let d=store.snapshot();for(const q of Object.values(d.qualifications))q.status='rejected';store.commit(d);store.claimCollection(settings,p.id,now+16000);
 const publicJob=collectionPublicState(store.snapshot(),now).backfills[p.id];assert.equal(publicJob.status,'complete');assert.match(publicJob.coverage,/not an exhaustive/);assert.equal(collectionDueIds(store.snapshot()).length,0);
});

test('provider includes archived historical posts only and rejects deleted or malformed posts',async()=>{
 const raw={id:'abc',subreddit:'smiskis',title:'How to track?',selftext:'Need a checklist',archived:true,locked:false,author:'user1',created_utc:(now-200*DAY)/1000,num_comments:1};
 assert.equal(normalizeScrapeBadgerPost(raw,new Date(now).toISOString()),null);
 assert.equal(normalizeScrapeBadgerPost(raw,new Date(now).toISOString(),{includeClosed:true}).discussionClosed,true);
 assert.equal(normalizeScrapeBadgerPost({...raw,selftext:'[deleted]'},new Date(now).toISOString(),{includeClosed:true}),null);
 const provider=createCollectionProvider({env,fetchImpl:async()=>new Response(JSON.stringify({posts:[raw],pagination:{after:null}}),{headers:{'X-Credits-Used':'5'}})});
 const out=await provider.fetchPage({url:'https://scrapebadger.com/v1/reddit/search/posts',task:{kind:'search',historical:true}});assert.equal(out.result.rows.length,1);assert.equal(out.credits,5);
});

test('concurrent onboarding creation and paid backfill claims use Firestore compare-and-swap',async t=>{
 const {store,p}=await fixture(t,{...product,x:false});let data=store.snapshot(),revision=0;
 const backend={read:async()=>({revision,data:structuredClone(data)}),compareAndSwap:async(r,next)=>{if(r!==revision)return false;data=structuredClone(next);revision++;return true;}};
 const a=new FirestoreStore(backend),b=new FirestoreStore(backend);const starts=await Promise.all([a.beginBackfill(p.id,now),b.beginBackfill(p.id,now)]);assert.equal(starts[0].id,starts[1].id);
 const claims=await Promise.all([a.claimCollection(settings,p.id,now),b.claimCollection(settings,p.id,now)]);assert.equal(claims.filter(Boolean).length,1);assert.equal((await a.snapshot()).collection.daily[budgetDay(now)].calls,1);
});

test('API automatically queues onboarding and explicit start is authenticated, idempotent and advances on worker ticks',async t=>{
 const {store,p,dir}=await fixture(t,{...product,x:false});let calls=0;
 const {app,runSearch}=createTrackerApp({store,dataDirectory:dir,qualificationEnv:env,collectionProvider:{fetchPage:async()=>{calls++;return page([]);}}});
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}`;
 const initial=await (await fetch(base+'/api/state')).json();const headers={'Content-Type':'application/json','X-Tracker-Token':initial.token};
 assert.equal((await fetch(base+`/api/products/${p.id}/backfill`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 let response=await fetch(base+`/api/products/${p.id}/backfill`,{method:'POST',headers,body:'{}'});assert.equal(response.status,200);
 const id=(await response.json()).backfill.id;response=await fetch(base+`/api/products/${p.id}/backfill`,{method:'POST',headers,body:'{}'});assert.equal((await response.json()).backfill.id,id);
 await runSearch(p.id,true);assert.equal(calls,1);assert.equal(store.snapshot().collection.cycles[p.id],undefined);
 response=await fetch(base+'/api/products',{method:'POST',headers,body:JSON.stringify({...product,x:false})});assert.equal(response.status,201);const created=(await response.json()).product;
 assert(store.snapshot().collection.backfills[created.id]);
});

test('backfill stages beyond sixty candidates while the first-pass cap leaves an explicit coverage gap',async t=>{
 const {store,p}=await fixture(t,{...product,x:false});store.beginBackfill(p.id,now);
 let c=store.claimCollection(settings,p.id,now);store.finishCollection(c.token,page(Array.from({length:50},(_,i)=>row('a'+i))),now+1);
 c=store.claimCollection(settings,p.id,now+16000);store.finishCollection(c.token,page(Array.from({length:50},(_,i)=>row('b'+i))),now+16001);
 assert.equal(store.snapshot().collection.backfills[p.id].staged,100);
 const d=store.snapshot();d.collection.backfills[p.id].requests=BACKFILL_LIMITS.requests;store.commit(d);
 assert.equal(store.claimCollection(settings,p.id,now+32000),null);const job=store.snapshot().collection.backfills[p.id];assert.equal(job.status,'reviewing');assert(job.errors.includes('request_limit'));assert.equal(job.queue.length,0);assert(job.unassessed>0);
});
