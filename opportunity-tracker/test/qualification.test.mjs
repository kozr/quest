import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Firestore} from 'firebase-admin/firestore';
import {Store} from '../store.mjs';
import {FirestoreBackend,FirestoreStore} from '../firestore-store.mjs';
import {discover} from '../discovery.mjs';
import {createTrackerApp} from '../server.mjs';
import {monitorCycle} from '../reddit/monitor-worker.mjs';
import {qualificationSettings,canonicalPost,qualificationKey,qualificationRequest,resolveQualification,reservationMicroUsd,processQualification,qualificationBackup,validateQualificationHistory,budgetDay,QUALIFICATION_MODEL,createQualificationProvider} from '../qualification.mjs';

const product={name:'Figure Shelf',url:'https://figureshelf.dev',description:'Keep a record of figures owned and missing.',capabilities:['Keep a record of figures owned and missing.'],needs:['Remember the figures already owned.'],keywords:['collection spreadsheet'],aliases:['Figure Shelf'],exclusions:['wholesale'],communities:['smiskis'],linkedin:true,monitoring:true};
const env={TRACKER_AI_ENABLED:'true',TRACKER_AI_DAILY_BUDGET_USD:'2',TRACKER_AI_MODE:'ongoing',TRACKER_OPENAI_API_KEY:'mock-fixture-key'};
const row=(id='ab123',extra={})=>({source:'Reddit watchlist',type:'post',provider:'redlib',sourceId:id,url:`https://www.reddit.com/r/smiskis/comments/${id}/some_title/`,title:'Which ones do I already have?',snippet:'I forget what is on my shelf when shopping. How can I remember the figures I already own?',publishedAt:new Date().toISOString(),...extra});
const linked=(id='7507254982996332545')=>row(id,{source:'LinkedIn',provider:'linkedin-mcp',url:`https://www.linkedin.com/posts/demo-person_collect-share-${id}-AbCd`,publishedAt:null});
const rejected={decision:'rejected',explicitIntent:false,intentEvidenceId:null,postEvidenceIds:[],capabilityIds:[],whyItFits:''};
function qualified(job) {const request=qualificationRequest(job),schema=request.text.format.schema;return {decision:'qualified',explicitIntent:true,intentEvidenceId:schema.properties.intentEvidenceId.enum[0],postEvidenceIds:[schema.properties.postEvidenceIds.items.enum.at(-1)],capabilityIds:[job.profile.capabilities[0].id],whyItFits:'Remember which figures you already own'};}
async function fixture(t) {const directory=await mkdtemp(join(tmpdir(),'tracker-ai-'));t.after(()=>rm(directory,{recursive:true,force:true}));const store=new Store(directory),p=store.saveProduct(product);return {store,p,directory};}
function stage(store,p,rows,extra={}) {store.recordSearch(p.id,{items:[],candidates:rows,semantic:true,searchedAt:new Date().toISOString(),trigger:'manual',sources:[{name:'Reddit watchlist',status:'ok'},{name:'LinkedIn',status:'ok'}],...extra});}
const mock=(value=qualified,costMicroUsd=200)=>({qualify:async job=>({value:typeof value==='function'?value(job):value,costMicroUsd,requestId:'fixture-response'})});

test('semantic collection includes subreddit posts without phrase overlap, with no model call',async()=>{
  const r=row(),comment=row('bc234',{type:'comment',url:'https://www.reddit.com/r/smiskis/comments/ab123/_/bc234/',snippet:'How do I track my figures with a collection spreadsheet?'});
  const result=await discover({...product,id:'fixture'},{watchOnly:true,semantic:true,scheduledSources:['reddit'],redditAdapter:{id:'redlib',list:async()=>({rows:[r,comment,row('cd345',{snippet:'wholesale supplier'})],coverage:{}})}});
  assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].sourceId,r.sourceId);assert.equal(result.items.length,1,'Existing comment filters remain in place');
  assert.equal(result.items[0].type,'comment');assert.equal(result.semantic,true);
});
test('canonical identity deduplicates Reddit slugs and LinkedIn permalinks per product',()=>{
  assert.equal(canonicalPost(row()).identity,canonicalPost(row('ab123',{url:'https://old.reddit.com/r/Smiskis/comments/ab123/another/?utm_source=fixture'})).identity);
  assert.equal(canonicalPost(linked()).identity,canonicalPost({...linked(),url:'https://www.linkedin.com/posts/other-person_new-share-7507254982996332545-AbCd?utm_source=fixture'}).identity);
  assert.equal(canonicalPost(row('ab123',{type:'comment'})),null);
  assert.notEqual(qualificationKey('a','reddit:ab123'),qualificationKey('b','reddit:ab123'));
});
test('Sol request uses strict evidence IDs, standard tier and no tools; invented evidence fails closed',async t=>{
  const {store,p}=await fixture(t);stage(store,p,[row()]);const job=store.claimQualification(qualificationSettings(env),Date.now(),p.id),request=qualificationRequest(job);
  assert.equal(request.model,'gpt-6.1-sol');assert.equal(request.service_tier,'default');assert.equal(request.store,false);assert.equal(request.tools,undefined);assert.equal(request.text.format.strict,true);
  assert.match(request.input[0].content,/Prefer fewer useful matches over weak matches/);assert.throws(()=>resolveQualification({...qualified(job),intentEvidenceId:'invented'},job),/evidence/);
  assert.throws(()=>resolveQualification({...rejected,whyItFits:'made up'},job),/rejection/);
  assert.equal(resolveQualification(qualified(job),job).intentQuote,job.row.title);
});
test('rejected outcomes survive restart and repeated manual/scheduled collection without another call',async t=>{
  const {store,p,directory}=await fixture(t);let calls=0;const provider={qualify:async()=>{calls++;return {value:rejected,costMicroUsd:100};}};
  stage(store,p,[row()]);assert.equal((await processQualification(store,qualificationSettings(env),provider)).status,'rejected');
  const reopened=new Store(directory);stage(reopened,p,[row('ab123',{url:'https://old.reddit.com/r/smiskis/comments/ab123/new_slug/'})],{trigger:'scheduled'});
  assert.equal((await processQualification(reopened,qualificationSettings(env),provider)).status,'idle');assert.equal(calls,1);assert.equal(reopened.snapshot().items.length,0);
});
test('qualified evidence enters inbox and preserves human decisions while a request is running',async t=>{
  const {store,p}=await fixture(t);stage(store,p,[row()]);const job=store.claimQualification(qualificationSettings(env),Date.now(),p.id);
  store.recordSearch(p.id,{items:[{...row(),url:job.url,kind:'mention'}],sources:[],searchedAt:new Date().toISOString()});
  const id=store.snapshot().items[0].id;store.updateItem(id,{status:'dismissed',note:'Already contacted independently.'});
  store.finishQualification(job.key,job.token,{assessment:resolveQualification(qualified(job),job),costMicroUsd:200},Date.now());
  const item=store.snapshot().items[0];assert.equal(item.id,id);assert.equal(item.status,'dismissed');assert.equal(item.note,'Already contacted independently.');assert.equal(item.kind,'mention');assert.equal(item.qualification.model,QUALIFICATION_MODEL);assert.equal(item.qualification.evidenceQuotes.length,1);
  stage(store,p,[row()]);assert.equal(store.claimQualification(qualificationSettings(env),Date.now(),p.id),null);
});
test('migration retains processed items, freezes old Reddit history and baselines undated LinkedIn without backfill',async t=>{
  const {store,p}=await fixture(t);const before=Date.parse('2026-10-05T10:00:00Z');
  store.recordSearch(p.id,{items:[{...row('ab123'),kind:'opportunity'}],sources:[{name:'Reddit watchlist'},{name:'LinkedIn'}],searchedAt:new Date(before).toISOString()});
  store.updateItem(store.snapshot().items[0].id,{status:'saved',note:'Keep my review.'});
  stage(store,p,[row('ab123'),row('bc234',{publishedAt:new Date(before-1000).toISOString()}),row('cd345',{publishedAt:null}),row('de456',{publishedAt:new Date(before+1000).toISOString()}),linked()]);
  const statuses=Object.values(store.snapshot().qualifications).map(j=>j.status).sort();assert.deepEqual(statuses,['historical_skipped','historical_skipped','historical_skipped','legacy_processed','pending']);
  stage(store,p,[linked('7507254982996332546')]);assert.equal(Object.values(store.snapshot().qualifications).filter(j=>j.status==='pending').length,2);
  assert.equal(store.snapshot().items[0].note,'Keep my review.');
});
test('failed LinkedIn collection does not consume migration baseline',async t=>{
  const {store,p}=await fixture(t);store.recordSearch(p.id,{items:[],sources:[{name:'LinkedIn'}],searchedAt:new Date().toISOString()});
  stage(store,p,[],{sources:[{name:'LinkedIn',status:'error'}]});assert.equal(store.snapshot().qualificationMigrations[p.id].linkedinBaseline,true);
  stage(store,p,[linked()]);assert.equal(Object.values(store.snapshot().qualifications)[0].status,'historical_skipped');
});
test('Reddit jobs take priority and a profile edit never silently requalifies a processed post',async t=>{
  const {store,p}=await fixture(t);stage(store,p,[linked(),row()]);const job=store.claimQualification(qualificationSettings(env),Date.now());assert.equal(job.platform,'reddit');
  store.finishQualification(job.key,job.token,{assessment:resolveQualification(rejected,job),costMicroUsd:100},Date.now());
  store.saveProduct({...product,capabilities:['Keep a record of wishlist figures.']},p.id);stage(store,{...p,capabilities:['Keep a record of wishlist figures.']},[row()]);
  assert.equal(store.claimQualification(qualificationSettings(env),Date.now()),null);assert.equal(Object.values(store.snapshot().qualifications).filter(j=>j.status==='rejected').length,1);assert.equal(Object.values(store.snapshot().qualifications).filter(j=>j.status==='profile_changed').length,1);
});
test('unknown provider outcomes keep their full charge hold and cannot be retried',async t=>{
  const {store,p}=await fixture(t);stage(store,p,[row()]);let calls=0;const provider={qualify:async()=>{calls++;throw Error('private-provider-response');}};
  const expected=reservationMicroUsd(Object.values(store.snapshot().qualifications)[0]);
  assert.equal((await processQualification(store,qualificationSettings(env),provider)).status,'uncertain');
  assert.equal(store.snapshot().aiBudget.spentMicroUsd,expected);assert.equal(store.snapshot().aiBudget.reservedMicroUsd,0);
  assert.equal((await processQualification(store,qualificationSettings(env),provider)).status,'idle');assert.equal(calls,1);
  assert(!JSON.stringify(store.snapshot()).includes('private-provider-response'));
});
test('Responses adapter uses only the dedicated server key and meters standard Sol tokens once',async t=>{
  const {store,p}=await fixture(t);stage(store,p,[row()]);let requests=0;
  const provider=createQualificationProvider({env,fetchImpl:async(url,options)=>{
    requests++;assert.equal(url,'https://api.openai.com/v1/responses');assert.equal(options.headers.Authorization,'Bearer mock-fixture-key');assert.equal(options.redirect,'error');assert(options.signal);
    const body=JSON.parse(options.body);assert.equal(body.tools,undefined);assert.equal(body.service_tier,'default');
    return new Response(JSON.stringify({id:'fixture-response',status:'completed',model:QUALIFICATION_MODEL,service_tier:'default',usage:{input_tokens:500,output_tokens:100},output_text:JSON.stringify(rejected)}));
  }});
  assert.equal(createQualificationProvider({env:{OPENAI_API_KEY:'unrelated-fixture'}}),null);
  assert.equal((await processQualification(store,qualificationSettings(env),provider)).status,'rejected');assert.equal(requests,1);assert.equal(store.snapshot().aiBudget.spentMicroUsd,2000);
});
test('incomplete, invalid JSON, wrong-model, bad usage, and HTTP failures become durable uncertainty without retry',async t=>{
  const {store,p}=await fixture(t);const base={status:'completed',model:QUALIFICATION_MODEL,service_tier:'default',usage:{input_tokens:500,output_tokens:100},output_text:JSON.stringify(rejected)};
  const failures=[new Response('upstream fixture',{status:429}),new Response(JSON.stringify({...base,status:'incomplete'})),new Response(JSON.stringify({...base,output_text:'invalid'})),new Response(JSON.stringify({...base,model:'other-model'})),new Response(JSON.stringify({...base,usage:{input_tokens:500,output_tokens:1601}}))];
  let requests=0;
  for(let index=0;index<failures.length;index++) {
    stage(store,p,[row(`fail${index}`)]);const provider=createQualificationProvider({env,fetchImpl:async()=>{requests++;return failures[index];}});
    assert.equal((await processQualification(store,qualificationSettings(env),provider)).status,'uncertain');assert.equal((await processQualification(store,qualificationSettings(env),provider)).status,'idle');
  }
  assert.equal(requests,failures.length);assert.equal(Object.values(store.snapshot().qualifications).filter(job=>job.status==='uncertain').length,failures.length);
});
test('expired dispatch stays uncertain and late settlement cannot create a duplicate',async t=>{
  const {store,p}=await fixture(t);stage(store,p,[row()]);const now=Date.now(),settings=qualificationSettings(env),job=store.claimQualification(settings,now,p.id);
  assert.equal(store.claimQualification(settings,now+120001,p.id),null);assert.equal(store.snapshot().qualifications[job.key].status,'uncertain');
  assert.equal(store.finishQualification(job.key,job.token,{assessment:resolveQualification(qualified(job),job),costMicroUsd:100},now+121000),null);assert.equal(store.snapshot().items.length,0);
});
test('$2 daily aggregate cap reserves before dispatch, persists across products and resets at Pacific midnight',async t=>{
  const {store,p}=await fixture(t),other=store.saveProduct({...product,name:'Other'}),now=Date.parse('2026-10-06T06:59:59Z');stage(store,p,[row()]);stage(store,other,[row('bc234')]);
  const settings=qualificationSettings(env,now),key=budgetDay(now);assert.equal(key,'2026-10-05');assert.equal(budgetDay(now+1000),'2026-10-06');
  const job=store.claimQualification(settings,now,p.id);assert(job);assert.equal(store.snapshot().aiBudget.dailyUsage[key].reservedMicroUsd,job.reservationMicroUsd);
  assert.equal(store.claimQualification(settings,now,other.id),null,'Global claim prevents overlapping paid calls');
  store.finishQualification(job.key,job.token,{assessment:resolveQualification(rejected,job),costMicroUsd:job.reservationMicroUsd},now);
  const data=store.snapshot();data.aiBudget.dailyUsage[key].spentMicroUsd=2_000_000;store.commit(data);
  assert.equal(store.claimQualification(settings,now,other.id),null);assert.ok(store.claimQualification(settings,now+1000,other.id));
  assert.equal(budgetDay(Date.parse('2026-11-01T07:30:00Z')),'2026-11-01');assert.equal(budgetDay(Date.parse('2026-11-02T07:59:59Z')),'2026-11-01');assert.equal(budgetDay(Date.parse('2026-11-02T08:00:00Z')),'2026-11-02');
});
test('disabled, missing-key, unapproved/expired budget, per-day call cap and test worker mode start zero requests',async t=>{
  const {store,p}=await fixture(t);stage(store,p,[row()]);let calls=0;const provider={qualify:async()=>{calls++;return {value:rejected,costMicroUsd:100};}};
  for(const settings of [qualificationSettings({}),qualificationSettings({...env,TRACKER_OPENAI_API_KEY:''}),qualificationSettings({...env,TRACKER_AI_DAILY_BUDGET_USD:'3'}),qualificationSettings({...env,TRACKER_AI_MODE:'misspelled'}),qualificationSettings({...env,TRACKER_AI_BUDGET_UNTIL:'2020-01-01'})])assert.equal((await processQualification(store,settings,provider)).status,'disabled');
  assert.equal((await processQualification(store,qualificationSettings({...env,TRACKER_AI_MODE:'test'}),provider)).status,'idle');assert.equal(calls,0);
  const settings=qualificationSettings({...env,TRACKER_AI_DAILY_MAX_CALLS:'1'});assert.equal((await processQualification(store,settings,provider,{productId:p.id})).status,'rejected');stage(store,p,[row('bc234')]);assert.equal((await processQualification(store,settings,provider,{productId:p.id})).status,'idle');assert.equal(calls,1);
});
test('a full durable history stops new AI jobs while retaining free collection receipts and mentions',async t=>{
  const {store,p}=await fixture(t),data=store.snapshot();
  data.qualifications=Object.fromEntries(Array.from({length:10000},(_,index)=>{const identity=`reddit:a${index}`,key=qualificationKey(p.id,identity);return [key,{key,productId:p.id,identity,status:'legacy_processed'}];}));store.commit(data);
  stage(store,p,[row('new123')],{items:[{source:'Hacker News',kind:'mention',url:'https://news.ycombinator.com/item?id=123',title:'Figure Shelf fixture'}]});
  assert.equal(store.snapshot().searches[p.id].qualification.historyFull,true);assert.equal(store.snapshot().items.length,1);assert.equal(Object.keys(store.snapshot().qualifications).length,10000);assert.equal(store.claimQualification(qualificationSettings(env),Date.now()),null);
});
test('reported cost beyond the reserved maximum permanently stops paid dispatch',async t=>{
  const {store,p}=await fixture(t);stage(store,p,[row(),row('bc234')]);const job=store.claimQualification(qualificationSettings(env),Date.now());
  store.finishQualification(job.key,job.token,{assessment:resolveQualification(rejected,job),costMicroUsd:job.reservationMicroUsd+1},Date.now());
  assert.equal(store.snapshot().aiBudget.overrun,true);assert.equal(store.claimQualification(qualificationSettings(env),Date.now()+86400000),null);
});
test('invalid assessment retains the safe response ID and cannot hide a known charge overrun',async t=>{
  const {store,p}=await fixture(t);stage(store,p,[row(),row('bc234')]);const reserve=reservationMicroUsd(Object.values(store.snapshot().qualifications)[0]);
  assert.equal((await processQualification(store,qualificationSettings(env),mock({...rejected,decision:'invalid'},reserve+1))).status,'uncertain');
  const receipt=Object.values(store.snapshot().qualifications).find(job=>job.status==='uncertain');assert.equal(receipt.requestId,'fixture-response');assert.equal(receipt.chargedMicroUsd,reserve+1);assert.equal(store.snapshot().aiBudget.overrun,true);
  assert.equal(store.claimQualification(qualificationSettings(env),Date.now()),null);
});
test('restoring an older backup cannot erase rejection, uncertain holds or daily spend; pending imports never replay',async t=>{
  const {store,p}=await fixture(t);const old=store.snapshot();stage(store,p,[row(),row('bc234')]);await processQualification(store,qualificationSettings(env),mock(rejected));
  const spent=store.snapshot().aiBudget.spentMicroUsd,backup={...store.snapshot(),...qualificationBackup(store.snapshot())};assert(!JSON.stringify(qualificationBackup(store.snapshot())).includes('profileHash'));
  assert.equal(validateQualificationHistory(backup).qualifications[qualificationKey(p.id,'reddit:bc234')].status,'uncertain');store.importData(old);
  assert.equal(store.snapshot().aiBudget.spentMicroUsd,spent);stage(store,p,[row(),row('bc234')]);assert.equal(store.claimQualification(qualificationSettings(env),Date.now()),null);
  assert.throws(()=>validateQualificationHistory({...backup,aiBudget:{...backup.aiBudget,spentMicroUsd:-1}}),/invalid AI/);
});
test('restore refuses an in-flight paid request and does not release its reservation',async t=>{
  const {store,p}=await fixture(t);stage(store,p,[row()]);const job=store.claimQualification(qualificationSettings(env),Date.now());
  assert.throws(()=>store.importData({version:1,products:[],items:[],searches:{}}),/running AI/);assert.equal(store.snapshot().qualifications[job.key].status,'running');
});
test('owner and worker endpoints enforce CSRF/bearer separately, expose safe state and retain free collection at cap',async t=>{
  const {store,p}=await fixture(t);let collected=0,paid=0;
  const provider={qualify:async job=>{paid++;return {value:qualified(job),costMicroUsd:200};}};
  const tracker=createTrackerApp({store,qualificationEnv:{...env,TRACKER_AI_MODE:'test'},qualificationProvider:provider,monitorToken:'fixture-monitor-token-of-at-least-32-characters',discoverFn:async(_p,options)=>{collected++;assert.equal(options.semantic,true);assert.equal(options.paidWeb,false);return {items:[],semantic:true,candidates:[row()],sources:[{name:'Reddit watchlist'}],searchedAt:new Date().toISOString()};}});
  const listener=tracker.app.listen(0,'127.0.0.1');await once(listener,'listening');t.after(()=>new Promise(resolve=>listener.close(resolve)));const origin=`http://127.0.0.1:${listener.address().port}`;
  const state=await fetch(origin+'/api/state').then(r=>r.json()),headers={'Content-Type':'application/json','X-Tracker-Token':state.token};
  assert.equal((await fetch(origin+'/api/qualification/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({productId:p.id})})).status,403);
  await fetch(origin+`/api/products/${p.id}/search`,{method:'POST',headers,body:'{}'});assert.equal(collected,1);assert.equal(paid,0);
  assert.equal((await fetch(origin+'/api/monitor/qualifications',{method:'POST'})).status,401);
  assert.equal((await fetch(origin+'/api/monitor/qualifications',{method:'POST',headers:{Authorization:'Bearer fixture-monitor-token-of-at-least-32-characters'}}).then(r=>r.json())).status,'disabled');
  const publicState=await fetch(origin+'/api/state').then(r=>r.json());assert.equal(publicState.qualifications,undefined);assert.equal(publicState.qualification.counts.pending,1);assert(!JSON.stringify(publicState).includes('mock-fixture-key'));
  const receipt=await fetch(origin+'/api/qualification/run',{method:'POST',headers,body:JSON.stringify({productId:p.id})}).then(r=>r.json());assert.equal(receipt.status,'qualified');assert.equal(paid,1);
  const restored=await fetch(origin+'/api/export').then(r=>r.json());assert.equal((await fetch(origin+'/api/import',{method:'POST',headers,body:JSON.stringify(restored)})).status,200);
  await fetch(origin+`/api/products/${p.id}/search`,{method:'POST',headers,body:'{}'});assert.equal(collected,2);assert.equal(paid,1);
});
test('monitor worker dispatches bounded qualification calls only when explicitly available',async()=>{
  const paths=[];await monitorCycle({baseURL:'https://tracker.vercel.app',token:'x'.repeat(32),fetchImpl:async url=>{paths.push(url.pathname);return new Response(JSON.stringify(url.pathname==='/api/monitor/workspaces'?{ids:['personal'],accountMode:false}:url.pathname==='/api/monitor'?{ids:[],qualifications:{available:true,pending:10}}:{status:'rejected'}));}});
  assert.deepEqual(paths,['/api/monitor/workspaces','/api/monitor','/api/monitor/qualifications','/api/monitor/qualifications']);
});
const emulator=process.env.FIRESTORE_EMULATOR_HOST;
test('real Firestore CAS prevents duplicate paid dispatch across independent instances', {skip:emulator?false:'Needs local Firestore emulator'},async t=>{
  assert.match(emulator,/^(127\.0\.0\.1|localhost):\d+$/);const db=new Firestore({projectId:'demo-opportunity-tracker'}),workspace=`ai-${randomUUID()}`;
  t.after(async()=>{await db.recursiveDelete(db.collection('opportunityTrackers').doc(workspace));await db.terminate();});
  const a=new FirestoreStore(new FirestoreBackend(db,workspace)),b=new FirestoreStore(new FirestoreBackend(db,workspace)),p=await a.saveProduct(product);
  await a.recordSearch(p.id,{items:[],semantic:true,candidates:[row()],sources:[],searchedAt:new Date().toISOString()});
  let calls=0,release;const waiting=new Promise(resolve=>{release=resolve;});const provider={qualify:async()=>{calls++;await waiting;return {value:rejected,costMicroUsd:200};}};
  const first=processQualification(a,qualificationSettings(env),provider);
  for(let index=0;index<30&&!calls;index++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1);
  assert.equal((await processQualification(b,qualificationSettings(env),provider)).status,'idle');assert.equal((await b.snapshot()).aiBudget.calls,1);
  await assert.rejects(()=>b.importData({version:1,products:[],items:[],searches:{}}),/running AI/);release();assert.equal((await first).status,'rejected');
  assert.equal((await new FirestoreStore(new FirestoreBackend(db,workspace)).snapshot()).aiBudget.spentMicroUsd,200);
});

 test('dated $3 top-up adds allowance without raising tomorrow’s recurring budget',async t=>{
  const boosted={...env,TRACKER_AI_EXTRA_BUDGET_USD:'3',TRACKER_AI_EXTRA_BUDGET_DAY:'2026-10-08'};
  const now=Date.parse('2026-10-09T06:59:59Z'),settings=qualificationSettings(boosted,now);
  assert.equal(settings.active,true);assert.equal(settings.budgetMicroUsd,5_000_000);
  assert.equal(qualificationSettings(boosted,now+1000).budgetMicroUsd,2_000_000);
  assert.equal(qualificationSettings({...boosted,TRACKER_AI_EXTRA_BUDGET_USD:'4'},now).active,false);
  assert.equal(qualificationSettings({...boosted,TRACKER_AI_EXTRA_BUDGET_DAY:''},now).active,false);
  const {store,p}=await fixture(t);stage(store,p,[row()]);
  const data=store.snapshot();data.aiBudget={spentMicroUsd:1_994_822,reservedMicroUsd:0,calls:68,daily:{},dailyUsage:{[budgetDay(now)]:{spentMicroUsd:1_994_822,reservedMicroUsd:0,calls:68}}};store.commit(data);
  const claim=store.claimQualification(settings,now,p.id);assert(claim);assert.equal(store.snapshot().aiBudget.dailyUsage[budgetDay(now)].spentMicroUsd,1_994_822);
 });
