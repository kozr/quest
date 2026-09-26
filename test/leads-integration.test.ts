import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {Timestamp} from 'firebase-admin/firestore';
import {testStore} from './firebase-fixture.js';
import {Store,documentKey,type AppRow,type DeviceRow,type Job} from '../src/database.js';
import {queueLeadReadyNotification,leadReadyPayload} from '../src/leads-notifications.js';
import {DeliveryWorker,RetryDelivery} from '../src/worker.js';
import {leadsRouter} from '../src/leads.js';
import {enqueueLeadCandidates} from '../src/leads-candidates.js';
import {processLeadDraftJob,processLeadJobs,queueLeadDraft,queueRecentProfileCandidates} from '../src/leads-jobs.js';
import {LEAD_PROFILE_PROMPT_VERSION,LEAD_QUALIFICATION_VERSION} from '../src/leads-types.js';
import {purgeAppData} from '../src/account-deletion.js';
import {leadContentHash} from '../src/leads-candidates.js';
import type {LeadAIProvider,LeadProfile,LeadQualification} from '../src/leads-types.js';
import type {StoredRedditPost} from '../src/reddit.js';

const baseTime=Date.now();
function env(users:string[]):NodeJS.ProcessEnv {return {LEADS_ENABLED:'true',LEADS_AI_ENABLED:'true',LEADS_MODEL_ID:'gpt-6-luna',
  LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION:'1',LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION:'4',OPENAI_API_KEY:'fixture-only-secret',
  REDDIT_MONITORING_ENABLED:'true',REDDIT_BETA_USER_IDS:users.join(',')};}
async function addApp(store:Store,userId:string,name='Lead fixture'):Promise<AppRow> {
  const row:AppRow={id:randomUUID(),user_id:userId,name,bundle_id:`test.${randomUUID()}`,apple_id:'123456789',source:'apple',icon_url:null,
    webhook_secret:randomUUID(),created_at:new Date().toISOString(),last_production_at:null,last_sandbox_at:null,active:true};
  await store.set('apps',row.id,row);return row;
}
function makeProfile(userId:string,appId:string,revision=1):LeadProfile {return {user_id:userId,app_id:appId,schemaVersion:1,revision,enabled:true,
  problems:[{id:randomUUID(),text:'Find figures already owned and duplicate entries'}],
  capabilities:[{id:'a9fbf79f-95a4-4e7f-96d8-22bb8ef01954',text:'Track figures I already own and detect duplicates',source:'user_confirmed'}],
  communities:['actionfigures'],keywords:['figures','duplicates'],descriptionSource:null,confirmedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};}
function makePost(id='abc123'):StoredRedditPost {return {id,subreddit:'actionfigures',title:'Is there an app to track figures I already own and duplicates?',
  body:'I need a simple inventory, not a marketplace.',url:`https://www.reddit.com/r/actionfigures/comments/${id}/`,createdAt:new Date(baseTime-60_000).toISOString(),score:2,comments:1,
  expireAt:Timestamp.fromMillis(baseTime+29*86400000)};}
const qualification=(post:StoredRedditPost):LeadQualification=>({decision:'qualified',explicitIntent:true,intentQuote:post.title,
  capabilityIds:['a9fbf79f-95a4-4e7f-96d8-22bb8ef01954'],fitEvidenceQuotes:[post.title],whyItFits:'It tracks owned figures and spots duplicate entries.'});
function provider(onQualify:(post:StoredRedditPost)=>Promise<void>|void=()=>{}):LeadAIProvider {return {
  draftProfile:async()=>({model:'gpt-6-luna',usage:{inputTokens:100,outputTokens:50},value:{problems:[{text:'Find duplicate figures',rationale:'People need an owned-figure list.'}],
    capabilities:[{text:'Track figures and detect duplicates',evidenceQuote:'Track figures you own and find duplicate figures.',rationale:'The description explicitly covers tracking.'}],suggestedCommunities:['actionfigures']}}),
  qualifyPost:async(post)=>{const row={...post,expireAt:Timestamp.fromMillis(baseTime+29*86400000)};await onQualify(row);return {model:'gpt-6-luna',usage:{inputTokens:100,outputTokens:50},value:qualification(row)};},
} as LeadAIProvider;}
async function addLeadFixture(store:Store,userId:string='alice',post=makePost()) {
  const app=await addApp(store,userId);const profile=makeProfile(userId,app.id);
  await store.set('lead_profiles',documentKey(userId,app.id),profile);await store.set('reddit_posts',post.id,post);
  return {app,profile,post};
}

test('worker qualifies one fresh lead once and settles cost from the configured token ceilings',async()=>{
  const store=testStore(),userId=`lead-${randomUUID()}`,fixture=await addLeadFixture(store,userId),calls={count:0},settings=env([userId]);
  await enqueueLeadCandidates(store,userId,fixture.app.id,fixture.profile,{now:baseTime});
  const fake=provider(()=>{calls.count++;});
  await processLeadJobs(store,fake,settings,baseTime);
  assert.equal(calls.count,1);
  const assessments=await store.list<any>('lead_assessments');assert.equal(assessments.length,1);assert.equal(assessments[0].decision,'qualified');
  const global=await store.get<any>('lead_ai_budgets',new Date(baseTime).toISOString().slice(0,7));
  assert.equal(global.reservedMicroUsd,0);assert.equal(global.spentMicroUsd,300);
  await processLeadJobs(store,fake,settings,baseTime+1000);assert.equal(calls.count,1);
});

async function addDevice(store:Store,userId:string,active=1) {
  const device:DeviceRow={id:randomUUID(),user_id:userId,session_hash:randomUUID(),token:'fixture',name:'Phone',environment:'sandbox',
    created_at:new Date(baseTime).toISOString(),last_seen_at:new Date(baseTime).toISOString(),active,generation:1};
  await store.set('devices',device.id,device);return device;
}

test('ongoing monitoring sends every qualified post to active phones without an initial scan, and retries safely',async t=>{
  const store=testStore(),userId=randomUUID(),f=await addLeadFixture(store,userId),settings=env([userId]);
  const phones=await Promise.all([addDevice(store,userId),addDevice(store,userId)]);
  await addDevice(store,userId,0);await addDevice(store,'other');
  await store.set('reddit_posts','second',makePost('second'));
  await store.set('reddit_posts','rejected',makePost('rejected'));
  await store.set('reddit_posts','dismissed',makePost('dismissed'));
  await store.set('lead_dismissals',documentKey(userId,f.app.id,'dismissed'),{expireAt:f.post.expireAt});
  const ai=provider();let calls=0;
  const original=ai.qualifyPost;
  ai.qualifyPost=async(...args)=>{calls++;const result=await original(...args);
    return args[0].id==='rejected'?{...result,value:{...result.value,decision:'rejected',explicitIntent:false}}:result;};
  await enqueueLeadCandidates(store,userId,f.app.id,f.profile,{now:baseTime});
  await processLeadJobs(store,ai,settings,baseTime);
  const jobs=await store.list<Job>('delivery_jobs');assert.equal(jobs.length,4);
  assert.equal((await store.list('lead_scans')).length,0);
  assert.equal((await store.list('lead_notifications')).length,2);
  for(const phone of phones) assert.equal(jobs.filter(j=>j.device_id===phone.id).length,2);
  assert.deepEqual(new Set(await Promise.all(jobs.map(async j=>(await leadReadyPayload(store,j))?.postId))),new Set([f.post.id,'second']));
  const initialCalls=calls;await processLeadJobs(store,ai,settings,baseTime+1000);
  assert.equal(calls,initialCalls);assert.equal((await store.list('delivery_jobs')).length,4);

  // Keep identity outside this transport test; real Firestore leases and delivery state are exercised.
  t.mock.method(store,'session',async(hash:string)=>({token_hash:hash,user_id:userId,user:{id:userId,email:'test@example.com'}}));
  let attempts=0;const sent:string[]=[];
  const worker=new DeliveryWorker(store,{send:async(_device,payload)=>{
    attempts++;if(attempts===1) return {ok:false,retryable:true,error:'Temporary outage'};
    sent.push(String(payload.postId));return {ok:true};
  }});
  await assert.rejects(worker.deliver(jobs[0].id),RetryDelivery);
  assert.equal((await store.get<Job>('delivery_jobs',jobs[0].id))?.state,'pending');
  await store.set('delivery_jobs',jobs[0].id,{next_attempt_at:Date.now()-1},true);
  for(const job of jobs) await worker.deliver(job.id);
  for(const job of jobs) await worker.deliver(job.id);
  assert.equal(attempts,5);assert.equal(sent.length,4);
  assert.equal((await store.list<Job>('delivery_jobs')).every(j=>j.state==='sent'),true);
  await purgeAppData(store,f.app.id);
  assert.equal((await store.list('lead_notifications')).length,0);
});

test('per-post receipts deduplicate concurrent queue attempts and requalification after profile edits',async()=>{
  const store=testStore(),userId=randomUUID(),f=await addLeadFixture(store,userId);
  await addDevice(store,userId);
  await enqueueLeadCandidates(store,userId,f.app.id,f.profile,{now:baseTime});
  await processLeadJobs(store,provider(),env([userId]),baseTime);
  const job=(await store.list<Job>('delivery_jobs'))[0];assert.ok(job?.lead);
  const assessment=await store.get<any>('lead_assessments',job.lead.assessmentId);
  await store.set('lead_profiles',documentKey(userId,f.app.id),{...f.profile,revision:2});
  await store.set('lead_assessments','requalified',{...assessment,profileRevision:2});
  await Promise.all(Array.from({length:5},()=>queueLeadReadyNotification(store,'requalified',baseTime+1000)));
  assert.equal((await store.list('delivery_jobs')).length,1);
  assert.equal(await leadReadyPayload(store,job),null,'The old profile alert is cancelled.');
});

test('notification receipts and jobs roll back together, and missing devices do not consume a post',async()=>{
  const store=testStore(),userId=randomUUID(),f=await addLeadFixture(store,userId);
  await enqueueLeadCandidates(store,userId,f.app.id,f.profile,{now:baseTime});
  await processLeadJobs(store,provider(),env([userId]),baseTime);
  const doc=(await store.collection('lead_assessments').get()).docs[0];assert.ok(doc);
  assert.equal((await store.list('lead_notifications')).length,0);
  await addDevice(store,userId);
  await assert.rejects(store.atomic(async s=>{
    await queueLeadReadyNotification(s,doc.id,baseTime+1000);
    throw new Error('Interrupted commit');
  }),/Interrupted commit/);
  assert.equal((await store.list('lead_notifications')).length,0);
  assert.equal((await store.list('delivery_jobs')).length,0);
  await Promise.all(Array.from({length:5},()=>queueLeadReadyNotification(store,doc.id,baseTime+1000)));
  assert.equal((await store.list('lead_notifications')).length,1);
  assert.equal((await store.list('delivery_jobs')).length,1);
});

test('a matcher upgrade revisits an empty legacy scan and qualifies a need without an app request only once',async()=>{
  const store=testStore(),userId=`problem-${randomUUID()}`,item={...makePost('need123'),title:'I keep accidentally buying the same one twice.',body:''};
  const fixture=await addLeadFixture(store,userId,item),statusId=documentKey(userId,fixture.app.id),collectionAt=new Date(baseTime).toISOString();
  await store.set('reddit_control','collector',{lastCompletedAt:collectionAt});
  await store.set('lead_status',statusId,{user_id:userId,app_id:fixture.app.id,candidateScanRevision:1,candidateScanAt:collectionAt,candidateScanCollectionAt:collectionAt});
  assert.equal(await queueRecentProfileCandidates(store,userId,fixture.app.id,fixture.profile,baseTime),1);
  assert.equal(await queueRecentProfileCandidates(store,userId,fixture.app.id,fixture.profile,baseTime+1),0);
  let calls=0; await processLeadJobs(store,provider(()=>{calls++;}),env([userId]),baseTime+2);
  const assessment=(await store.list<any>('lead_assessments'))[0];
  assert.equal(assessment.decision,'qualified');assert.equal(assessment.promptVersion,LEAD_QUALIFICATION_VERSION);
  const status=await store.get<any>('lead_status',statusId);assert.equal(status.candidateScanVersion,LEAD_QUALIFICATION_VERSION);
  // Losing only the scan marker can never repeat a billed/completed job.
  await store.set('lead_status',statusId,{...status,candidateScanVersion:'older-version'});
  assert.equal(await queueRecentProfileCandidates(store,userId,fixture.app.id,fixture.profile,baseTime+3),0);
  await processLeadJobs(store,provider(()=>{calls++;}),env([userId]),baseTime+4);
  assert.equal(calls,1);assert.equal((await store.list('lead_assessments')).length,1);
});

for(const outcome of ['success','error'] as const) test(`app deletion during a provider wait fences the late ${outcome} and accounts for the full reservation`,async()=>{
  const store=testStore(),userId=`lead-${randomUUID()}`,fixture=await addLeadFixture(store,userId),settings=env([userId]);
  let started!:()=>void,release!:()=>void;
  const waiting=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const fake=provider(async()=>{started();await gate;if(outcome==='error') throw new Error('uncertain transport');});
  await enqueueLeadCandidates(store,userId,fixture.app.id,fixture.profile,{now:baseTime});
  const running=processLeadJobs(store,fake,settings,baseTime);await waiting;
  const globalId=new Date(baseTime).toISOString().slice(0,7),before=await store.get<any>('lead_ai_budgets',globalId);
  assert.ok(before.reservedMicroUsd>0);
  await purgeAppData(store,fixture.app.id);
  release();await running;
  assert.equal((await store.list('lead_assessments')).length,0);
  assert.equal(await store.get('lead_profiles',documentKey(userId,fixture.app.id)),undefined);
  assert.equal((await store.list('lead_jobs')).length,0);
  const after=await store.get<any>('lead_ai_budgets',globalId);assert.equal(after.reservedMicroUsd,0);assert.equal(after.spentMicroUsd,before.reservedMicroUsd);
  const reservation=(await store.list<any>('lead_ai_reservations'))[0];assert.equal(reservation.state,'uncertain');assert.equal('app_id' in reservation,false);assert.equal('job_id' in reservation,false);
});

test('a Cloud Task retry after a safe worker-busy deferral makes exactly one draft call',async()=>{
  const store=testStore(),userId=`lead-${randomUUID()}`,app=await addApp(store,userId),settings=env([userId]),requestId=randomUUID();
  const queued=await queueLeadDraft(store,{userId,app,description:'Track figures you own and find duplicate figures.',country:'us',requestId,env:settings,now:baseTime});
  await store.set('lead_control','worker',{leaseToken:'other-task',leaseUntil:baseTime+60_000});
  let calls=0;const fake={...provider(),draftProfile:async()=>{calls++;return {model:'gpt-6-luna',usage:{inputTokens:100,outputTokens:50},value:{problems:[{text:'Find duplicate figures',rationale:'People need an owned-figure list.'}],
    capabilities:[{text:'Track figures and detect duplicates',evidenceQuote:'Track figures you own and find duplicate figures.',rationale:'The description explicitly covers tracking.'}],suggestedCommunities:['actionfigures']}};}} as LeadAIProvider;
  assert.equal((await processLeadDraftJob(store,queued.jobId,fake,settings,baseTime)).reasonCode,'WORKER_BUSY');assert.equal(calls,0);
  await store.set('lead_control','worker',{leaseToken:'',leaseUntil:0});
  assert.equal((await processLeadDraftJob(store,queued.jobId,fake,settings,baseTime)).processed,1);assert.equal(calls,1);
  assert.equal((await processLeadDraftJob(store,queued.jobId,fake,settings,baseTime)).processed,0);assert.equal(calls,1);
  assert.equal((await store.get<any>('lead_jobs',queued.jobId)).state,'succeeded');
});

test('new profile prompts bypass old cached drafts while preserving request retries and current caching',async()=>{
  const store=testStore(),userId=`profile-${randomUUID()}`,app=await addApp(store,userId),settings=env([userId]);
  const input={userId,app,description:'Track figures you own and find duplicate figures.',country:'us',requestId:randomUUID(),env:settings,now:baseTime};
  const first=await queueLeadDraft(store,input);
  await processLeadDraftJob(store,first.jobId,provider(),settings,baseTime);
  const original=await store.get<any>('lead_drafts',first.jobId);
  assert.equal(original.promptVersion,LEAD_PROFILE_PROMPT_VERSION);
  // Legacy drafts have no prompt version. A retried request remains idempotent.
  const {promptVersion:_,...legacy}=original;await store.set('lead_drafts',first.jobId,legacy);
  assert.equal((await queueLeadDraft(store,input)).jobId,first.jobId);
  const refreshed=await queueLeadDraft(store,{...input,requestId:randomUUID()});
  assert.notEqual(refreshed.jobId,first.jobId);
  await processLeadDraftJob(store,refreshed.jobId,provider(),settings,baseTime+1);
  const cached=await queueLeadDraft(store,{...input,requestId:randomUUID()});
  assert.equal(cached.jobId,refreshed.jobId);
  assert.equal((await store.list('lead_jobs')).length,2);
});

test('request ID conflict is checked before a cached App Store draft can be returned',async()=>{
  const store=testStore(),userId=`lead-${randomUUID()}`,app=await addApp(store,userId),settings=env([userId]),firstId=randomUUID();
  const first=await queueLeadDraft(store,{userId,app,description:'Track figures you own and find duplicate figures.',country:'us',requestId:firstId,env:settings,now:baseTime});
  const fake=provider();await processLeadDraftJob(store,first.jobId,fake,settings,baseTime);
  const second=await queueLeadDraft(store,{userId,app,description:'Track books that I own and find duplicate copies.',country:'us',requestId:randomUUID(),env:settings,now:baseTime});
  await processLeadDraftJob(store,second.jobId,fake,settings,baseTime);
  await assert.rejects(queueLeadDraft(store,{userId,app,description:'Track books that I own and find duplicate copies.',country:'us',requestId:firstId,env:settings,now:baseTime}),/REQUEST_ID_CONFLICT/);
});

test('candidate scan advances by examined document and skips unchanged collection/profile scans',async()=>{
  const store=testStore(),users=['scan-a','scan-b'],settings=env(users);let postQueries=0;
  const original=store.query.bind(store);
  (store as any).query=async(query:any)=>{if(query._queryOptions?.collectionId==='reddit_posts') postQueries++;return original(query);};
  for(const userId of users) for(let index=0;index<13;index++) {
    const app=await addApp(store,userId,`Scan fixture ${userId} ${index}`),profile=makeProfile(userId,app.id);
    await store.set('lead_profiles',documentKey(userId,app.id),profile);
  }
  const first=await (await import('../src/leads-candidates.js')).reconcileLeadCandidates(store,users,baseTime,20);
  assert.equal(first.profiles,20);assert.equal(first.partial,true);assert.equal(postQueries,20);
  const second=await (await import('../src/leads-candidates.js')).reconcileLeadCandidates(store,users,baseTime+60_000,20);
  assert.equal(second.profiles,6);assert.equal(second.partial,false);assert.equal(postQueries,26);
  await (await import('../src/leads-candidates.js')).reconcileLeadCandidates(store,users,baseTime+120_000,20);
  assert.equal(postQueries,26,'an unchanged collection watermark must not reread subreddit posts');
  const statuses=await store.list<any>('lead_status');assert.equal(statuses.length,26);assert.ok(statuses.every(row=>row.candidateScanCollectionAt==='never'&&row.candidateScanRevision===1));
});

test('profile and lead API expose collector freshness and gate draft status consistently',async t=>{
  const store=testStore(),userId=`lead-${randomUUID()}`,fixture=await addLeadFixture(store,userId),settings=env([userId]);
  const previous={LEADS_ENABLED:process.env.LEADS_ENABLED,LEADS_AI_ENABLED:process.env.LEADS_AI_ENABLED,LEADS_MODEL_ID:process.env.LEADS_MODEL_ID,
    LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION:process.env.LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION,
    LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION:process.env.LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION,
    REDDIT_MONITORING_ENABLED:process.env.REDDIT_MONITORING_ENABLED,REDDIT_BETA_USER_IDS:process.env.REDDIT_BETA_USER_IDS,OPENAI_API_KEY:process.env.OPENAI_API_KEY};
  Object.assign(process.env,settings);delete process.env.OPENAI_API_KEY;
  t.after(()=>{for(const [key,value] of Object.entries(previous)) if(value===undefined) delete process.env[key];else process.env[key]=value;});
  await store.set('reddit_control','collector',{lastCompletedAt:'2026-09-23T10:00:00.000Z',nextCheckAt:baseTime+1000});
  const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).user={id:req.headers['x-test-user']};next();});app.use('/api',leadsRouter(store));
  app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({error:error.message,code:error.code}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());const address=server.address() as any;
  const call=(path:string)=>fetch(`http://127.0.0.1:${address.port}/api${path}`,{headers:{'x-test-user':userId}});
  const access=await(await call('/leads/access')).json() as any;assert.equal(access.enabled,true);assert.equal(access.aiAvailable,false);
  const profile=await(await call(`/apps/${fixture.app.id}/leads/profile`)).json() as any;
  assert.equal(profile.status.lastCollectedAt,'2026-09-23T10:00:00.000Z');assert.equal(profile.status.nextCheckAt,new Date(baseTime+1000).toISOString());
  await enqueueLeadCandidates(store,userId,fixture.app.id,fixture.profile,{now:baseTime});
  const queued=(await store.list<any>('lead_jobs'))[0];assert.ok(queued);
  const feedPath=`/apps/${fixture.app.id}/leads`;
  const waiting=await(await call(feedPath)).json() as any;
  assert.equal(waiting.status.progress.phase,'queued');assert.equal(waiting.status.progress.fraction,0);
  await store.set('lead_jobs',queued.id,{...queued,state:'running',leaseUntil:Date.now()+60_000});
  const scanning=await(await call(feedPath)).json() as any;
  assert.equal(scanning.status.progress.phase,'assessing');assert.equal(scanning.status.progress.post.id,fixture.post.id);
  assert.equal(scanning.status.progress.post.title,fixture.post.title);
  assert.equal('user_id' in scanning.status.progress.post,false);
  await store.set('lead_jobs',queued.id,{...queued,state:'succeeded'});
  const finished=await(await call(feedPath)).json() as any;
  assert.equal(finished.status.progress.phase,'complete');assert.equal(finished.status.progress.post,null);
  process.env.LEADS_ENABLED='false';
  const jobId='a'.repeat(64);await store.set('lead_jobs',jobId,{id:jobId,user_id:'foreign-user',app_id:fixture.app.id,kind:'draft',state:'pending',inputHash:'hash',nextAttemptAt:baseTime,
    createdAt:new Date(baseTime).toISOString(),updatedAt:new Date(baseTime).toISOString(),expireAt:Timestamp.fromMillis(baseTime+86400000)});
  const denied=await call(`/apps/${fixture.app.id}/leads/drafts/${jobId}`);assert.equal(denied.status,403);
  process.env.LEADS_ENABLED='true';
  const foreign=await call(`/apps/${fixture.app.id}/leads/drafts/${jobId}`);assert.equal(foreign.status,404);
});

test('lead HTTP contracts preserve capability provenance, app isolation, exact undo, and stale cursors',async t=>{
  const store=testStore(),userId=`lead-${randomUUID()}`,settings=env([userId]);
  const first=await addLeadFixture(store,userId,makePost('abc123'));
  const secondPost=makePost('def456');await store.set('reddit_posts',secondPost.id,secondPost);
  const other=await addLeadFixture(store,userId,makePost('abc123'));
  const app2Profile={...other.profile,capabilities:other.profile.capabilities.map(cap=>({...cap,source:'app_store' as const,evidenceQuote:'Track figures you own and detect duplicate entries.'}))};
  const app1Profile={...first.profile,communities:['actionfigures','blindboxes'],descriptionSource:{contentHash:'abc',fetchedAt:'2026-09-24T00:00:00Z',country:'us',appleId:'123'},capabilities:first.profile.capabilities.map(cap=>({...cap,source:'app_store' as const,evidenceQuote:'Track figures you own and detect duplicate entries.'}))};
  await store.set('lead_profiles',documentKey(userId,first.app.id),app1Profile);
  await store.set('lead_profiles',documentKey(userId,other.app.id),app2Profile);
  const expiry=Timestamp.fromMillis(baseTime+29*86400000);
  for(const [app,profile,post,suffix] of [[first.app,app1Profile,first.post,'a'],[first.app,app1Profile,secondPost,'b'],[other.app,app2Profile,other.post,'c']] as const) {
    const assessment={user_id:userId,app_id:app.id,profileRevision:profile.revision,postId:post.id,postContentHash:leadContentHash(post),postCreatedAt:post.createdAt,
      decision:'qualified' as const,explicitIntent:true,intentQuote:post.title,capabilityIds:[profile.capabilities[0].id],sourceEvidenceQuotes:[post.title],
      whyItFits:'Tracks figures owned and catches duplicate entries.',modelVersion:'fixture',promptVersion:'fixture',assessedAt:new Date(baseTime).toISOString(),expireAt:expiry};
    await store.set('lead_assessments',suffix.repeat(64),assessment);
  }
  const previous={LEADS_ENABLED:process.env.LEADS_ENABLED,LEADS_AI_ENABLED:process.env.LEADS_AI_ENABLED,LEADS_MODEL_ID:process.env.LEADS_MODEL_ID,
    LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION:process.env.LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION,
    LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION:process.env.LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION,
    REDDIT_MONITORING_ENABLED:process.env.REDDIT_MONITORING_ENABLED,REDDIT_BETA_USER_IDS:process.env.REDDIT_BETA_USER_IDS,OPENAI_API_KEY:process.env.OPENAI_API_KEY};
  Object.assign(process.env,settings);delete process.env.OPENAI_API_KEY;
  const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).user={id:req.headers['x-test-user']};next();});app.use('/api',leadsRouter(store));
  app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({error:error.message,code:error.code}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as any;
  const call=(path:string,method='GET',body?:unknown)=>fetch(`http://127.0.0.1:${address.port}/api${path}`,{method,headers:{'x-test-user':userId,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  try {
    const initial=await(await call(`/apps/${first.app.id}/leads?limit=1`)).json() as any;
    assert.equal(initial.leads.length,1);assert.ok(initial.nextCursor);
    assert.equal((await call(`/apps/${first.app.id}/leads/profile`)).status,200);
    const foreign=await addApp(store,`foreign-${randomUUID()}`);
    assert.equal((await call(`/apps/${foreign.id}/leads/profile`)).status,404);

    const mutationId=randomUUID(),dismissPath=`/apps/${first.app.id}/leads/abc123/dismissal`;
    assert.equal((await call(dismissPath,'PUT',{mutationId})).status,200);
    const afterDismiss=await(await call(`/apps/${first.app.id}/leads`)).json() as any;
    assert.deepEqual(afterDismiss.leads.map((lead:any)=>lead.postId),['def456']);
    const otherFeed=await(await call(`/apps/${other.app.id}/leads`)).json() as any;
    assert.deepEqual(otherFeed.leads.map((lead:any)=>lead.postId),['abc123']);
    assert.equal((await call(dismissPath,'DELETE',{mutationId})).status,200);
    assert.equal((await(await call(`/apps/${first.app.id}/leads`)).json() as any).leads.length,2);

    const newerMutation=randomUUID();assert.equal((await call(dismissPath,'PUT',{mutationId:newerMutation})).status,200);
    const staleUndo=await call(dismissPath,'DELETE',{mutationId});assert.equal(staleUndo.status,409);
    assert.equal((await call(dismissPath,'DELETE',{mutationId:newerMutation})).status,200);

    const unchanged={expectedRevision:1,enabled:true,problems:app1Profile.problems,capabilities:[{id:app1Profile.capabilities[0].id,text:app1Profile.capabilities[0].text}],
      communities:[...app1Profile.communities].reverse(),keywords:[...app1Profile.keywords].reverse()};
    const noOp=await(await call(`/apps/${first.app.id}/leads/profile`,'PUT',unchanged)).json() as any;
    assert.equal(noOp.profile.revision,1);assert.equal(noOp.profile.capabilities[0].source,'app_store');
    assert.equal(noOp.profile.capabilities[0].evidenceQuote,app1Profile.capabilities[0].evidenceQuote);
    const changed=await call(`/apps/${first.app.id}/leads/profile`,'PUT',{...unchanged,expectedRevision:1,
      capabilities:[{id:app1Profile.capabilities[0].id,text:'Track owned action figures with duplicate detection'}]});
    assert.equal(changed.status,200);assert.equal(((await changed.json()) as any).profile.revision,2);
    const stale=await call(`/apps/${first.app.id}/leads?limit=1&cursor=${encodeURIComponent(initial.nextCursor)}`);
    assert.equal(stale.status,409);assert.equal(((await stale.json()) as any).code,'STALE_CURSOR');
    const staleWrite=await call(`/apps/${first.app.id}/leads/profile`,'PUT',unchanged);
    assert.equal(staleWrite.status,409);assert.equal(((await staleWrite.json()) as any).code,'STALE_PROFILE');
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    for(const [key,value] of Object.entries(previous)) if(value===undefined) delete process.env[key];else process.env[key]=value;
  }
});
