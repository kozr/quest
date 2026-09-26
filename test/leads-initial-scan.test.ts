import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testStore} from './firebase-fixture.js';
import {documentKey,type AppRow} from '../src/database.js';
import {queueInitialLeadScan,advanceInitialLeadScan,type InitialLeadScan} from '../src/leads-initial-scan.js';
import {processLeadQualificationJob,queueRecentProfileCandidates} from '../src/leads-jobs.js';
import {enqueueHistoricalCandidates} from '../src/leads-candidates.js';
import {purgeAppData} from '../src/account-deletion.js';
import type {LeadProfile,LeadJob,LeadAIProvider} from '../src/leads-types.js';
import type {RedditApify} from '../src/reddit-apify.js';
import {Timestamp} from 'firebase-admin/firestore';
const now=Date.now();
const env={LEADS_ENABLED:'true',LEADS_AI_ENABLED:'true',REDDIT_MONITORING_ENABLED:'true',REDDIT_PUBLIC_ACCESS:'true',
  REDDIT_MONTHLY_BUDGET_USD:'15',LEADS_AI_ACCOUNT_CAP_USD:'4',LEADS_MODEL_ID:'gpt-6-luna',LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION:'1',
  LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION:'4',OPENAI_API_KEY:'fixture-only-secret'};
async function fixture() {
  const store=testStore(),userId=randomUUID(),appId=randomUUID();
  const app:AppRow={id:appId,user_id:userId,name:'Journal',bundle_id:'test.journal',apple_id:'123',source:'apple',icon_url:null,
    webhook_secret:randomUUID(),created_at:new Date(now).toISOString(),last_production_at:null,last_sandbox_at:null,active:true};
  const profile:LeadProfile={user_id:userId,app_id:appId,schemaVersion:1,revision:1,enabled:true,
    problems:[{id:'p',text:'Keep daily journal entries'}],capabilities:[{id:'c',text:'Write daily journal entries',source:'user_confirmed'}],
    communities:['journaling'],keywords:['journal'],descriptionSource:null,confirmedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
  await store.set('apps',appId,app);await store.set('lead_profiles',documentKey(userId,appId),profile);
  return {store,userId,appId,profile};
}
function collector(options:{failStart?:boolean;posts?:any[]}={}) {
  const calls={start:0,status:0,posts:0,search:0};
  const provider={start:async()=>{throw new Error('Historical setup must not collect the recent listing.');},
    startThreads:async(urls:string[])=>{calls.start++;assert.deepEqual(urls,['https://www.reddit.com/r/journaling/comments/oldpost/']);if(options.failStart) throw new Error('ambiguous start');return {id:'run-one',status:'RUNNING',defaultDatasetId:'data'};},
    status:async()=>{calls.status++;return {id:'run-one',status:'SUCCEEDED',defaultDatasetId:'data',finishedAt:new Date(now+1000).toISOString(),usageTotalUsd:.01};},
    posts:async()=>{calls.posts++;return options.posts??[];}} as unknown as RedditApify;
  const ai={discoverThreads:async()=>{calls.search++;return {model:'gpt-6-luna',usage:{inputTokens:50,outputTokens:20,searchCalls:1},value:{urls:['https://www.reddit.com/r/journaling/comments/oldpost/']}};}} as LeadAIProvider;
  return {provider,calls,ai};
}
test('concurrent first opens create one durable attempt; a completed empty scan cannot restart',async()=>{
  const {store,userId,appId}=await fixture();
  const starts=await Promise.all(Array.from({length:8},()=>queueInitialLeadScan(store,userId,appId,1,now,env)));
  assert.equal(starts.filter(r=>r.started).length,1);assert.equal((await store.list('lead_scans')).length,1);
  assert.equal(starts[0].scan.maxSearchRounds,3);assert.equal(starts[0].scan.targetMatches,undefined);
  await store.set('lead_scans',starts[0].scan.id,{...starts[0].scan,state:'complete'});
  assert.equal((await queueInitialLeadScan(store,userId,appId,1,now+1000,env)).started,false);
  await assert.rejects(queueInitialLeadScan(store,'foreign',appId,1,now,env),/App not found/);
  await assert.rejects(queueInitialLeadScan(store,userId,appId,2,now,env),/profile changed/);
});
test('a recent cache scan does not count as historical search coverage',async()=>{
  const {store,userId,appId}=await fixture();
  await store.set('lead_status',documentKey(userId,appId),{candidateScanRevision:1,candidateScanAt:new Date(now).toISOString()});
  const result=await queueInitialLeadScan(store,userId,appId,1,now,env);
  assert.equal(result.started,true);assert.equal(result.scan.state,'queued');assert.equal(result.scan.mode,'historical');
});
test('an empty first retrieval searches additional rounds without fetching duplicate URLs or restarting a finished scan',async()=>{
  const {store,userId,appId}=await fixture(),fake=collector();
  await store.set('reddit_control','collector',{active:null,nextCheckAt:now+2*60*60_000,message:''});
  const {scan}=await queueInitialLeadScan(store,userId,appId,1,now,env);
  assert.equal(await advanceInitialLeadScan(store,scan.id,fake.provider,env,now,fake.ai),false);assert.equal(fake.calls.start,1);
  const pending=await store.get<InitialLeadScan>('lead_scans',scan.id);assert.ok(pending?.collectionClaim);assert.equal(pending.state,'collecting');
  assert.equal(await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+17_000,fake.ai),false);
  assert.equal(await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+47_000,fake.ai),false);
  assert.equal(await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+107_000,fake.ai),true);
  assert.equal((await store.get<InitialLeadScan>('lead_scans',scan.id))?.state,'complete');
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+18_000,fake.ai);
  assert.deepEqual(fake.calls,{start:1,status:1,posts:1,search:3});
  assert.equal((await store.get<InitialLeadScan>('lead_scans',scan.id))?.stopReason,'search_limit');
  assert.equal((await queueInitialLeadScan(store,userId,appId,1,now+20_000,env)).started,false);
});
test('recent collection coverage does not replace an all-time historical search',async()=>{
  const {store,userId,appId}=await fixture(),fake=collector();
  await store.set('reddit_control','collector',{active:null,nextCheckAt:now+1000,lastCompletedAt:new Date(now-1000).toISOString(),lastCompletedCommunities:['journaling']});
  const {scan}=await queueInitialLeadScan(store,userId,appId,1,now,env);
  assert.equal(await advanceInitialLeadScan(store,scan.id,fake.provider,env,now,fake.ai),false);assert.equal(fake.calls.start,1);
});
test('an ambiguous paid start is never repeated and becomes interrupted',async()=>{
  const {store,userId,appId}=await fixture(),fake=collector({failStart:true});
  const {scan}=await queueInitialLeadScan(store,userId,appId,1,now,env);
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now,fake.ai);
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+130_000,fake.ai);
  assert.equal(fake.calls.start,1);assert.equal((await store.get<InitialLeadScan>('lead_scans',scan.id))?.state,'interrupted');
});
test('collection budget and profile changes stop automatic work; app purge removes its receipt',async()=>{
  const {store,userId,appId,profile}=await fixture(),fake=collector();
  await store.set('reddit_budgets',new Date(now).toISOString().slice(0,7),{reserved:0,spent:15});
  const {scan}=await queueInitialLeadScan(store,userId,appId,1,now,env);
  assert.equal(await advanceInitialLeadScan(store,scan.id,fake.provider,env,now,fake.ai),true);
  assert.equal((await store.get<InitialLeadScan>('lead_scans',scan.id))?.state,'paused');assert.equal(fake.calls.start,0);
  await store.set('lead_profiles',documentKey(userId,appId),{...profile,revision:2});
  const next=await queueInitialLeadScan(store,userId,appId,2,now,env);
  await store.set('lead_profiles',documentKey(userId,appId),{...profile,revision:3});
  assert.equal(await advanceInitialLeadScan(store,next.scan.id,fake.provider,env,now,fake.ai),true);
  assert.equal((await store.get<InitialLeadScan>('lead_scans',next.scan.id))?.state,'cancelled');
  await purgeAppData(store,appId);assert.equal((await store.list('lead_scans')).length,0);
});
test('immediate qualification is fenced against duplicate task delivery',async()=>{
  const {store,userId,appId,profile}=await fixture();
  await store.set('reddit_posts','abc',{id:'abc',subreddit:'journaling',title:'Is there an app to write daily journal entries?',body:'I need a journal app.',createdAt:new Date(now-1000).toISOString(),expireAt:Timestamp.fromMillis(now+86400000)});
  await queueRecentProfileCandidates(store,userId,appId,profile,now);
  const job=(await store.list<LeadJob>('lead_jobs'))[0];assert.ok(job);
  let calls=0;
  const provider={qualifyPost:async()=>{calls++;return {model:'gpt-6-luna',usage:{inputTokens:50,outputTokens:20},value:{decision:'rejected',explicitIntent:false,intentQuote:'',capabilityIds:[],fitEvidenceQuotes:[],whyItFits:''}};}} as unknown as LeadAIProvider;
  await processLeadQualificationJob(store,job.id,provider,env,now);
  await processLeadQualificationJob(store,job.id,provider,env,now+1000);
  assert.equal(calls,1);assert.equal((await store.get<LeadJob>('lead_jobs',job.id))?.state,'succeeded');
});

test('historical search retrieves old source text and queues it once without moving the monitoring watermark',async()=>{
  const {store,userId,appId,profile}=await fixture();
  const old={id:'oldpost',subreddit:'journaling',title:'My notes are scattered across notebooks.',body:'I want to keep my thoughts together.',url:'https://www.reddit.com/r/journaling/comments/oldpost/',createdAt:'2022-01-01T00:00:00.000Z',score:1,comments:2};
  const fake=collector({posts:[old,{...old,id:'unsourced'}]}),watermark=new Date(now-60000).toISOString();
  await store.set('reddit_control','collector',{active:null,nextCheckAt:now+3600000,lastCompletedAt:watermark,lastCompletedCommunities:['journaling']});
  const {scan}=await queueInitialLeadScan(store,userId,appId,1,now,env);
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now,fake.ai);
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+17000,fake.ai);
  const jobs=await store.list<LeadJob>('lead_jobs'),qualification=jobs.find(j=>j.kind==='qualify')!;
  assert.equal(jobs.filter(j=>j.kind==='discover').length,1);assert.ok(qualification.historical);
  assert.equal(qualification.postId,'oldpost');assert.equal(await store.get('reddit_posts','unsourced'),undefined);
  assert.equal((await store.get<any>('reddit_control','collector')).lastCompletedAt,watermark);
  const stored=await store.get<any>('reddit_posts','oldpost');assert.equal(stored.createdAt,old.createdAt);assert.ok(stored.expireAt.toMillis()>now);
  const ai={qualifyPost:async()=>({model:'gpt-6-luna',usage:{inputTokens:20,outputTokens:20},value:{decision:'qualified',explicitIntent:true,intentQuote:old.title,fitEvidenceQuotes:[old.title],capabilityIds:[profile.capabilities[0].id],whyItFits:'Keeps scattered thoughts together.'}})} as unknown as LeadAIProvider;
  await processLeadQualificationJob(store,qualification.id,ai,env,now+18000);
  const assessment=(await store.list<any>('lead_assessments'))[0];assert.equal(assessment.decision,'qualified');assert.ok(assessment.expireAt.toMillis()>now);assert.equal(assessment.postCreatedAt,old.createdAt);
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+19000,fake.ai);assert.equal(fake.calls.search,1);assert.equal(fake.calls.start,1);
});

test('search budget stops before any web search or source fetch',async()=>{
  const {store,userId,appId}=await fixture(),fake=collector();
  const {scan}=await queueInitialLeadScan(store,userId,appId,1,now,env);
  await advanceInitialLeadScan(store,scan.id,fake.provider,{...env,LEADS_AI_ACCOUNT_CAP_USD:'0.001'},now,fake.ai);
  assert.equal(fake.calls.search,0);assert.equal(fake.calls.start,0);assert.equal((await store.get<InitialLeadScan>('lead_scans',scan.id))?.state,'paused');
});

test('a busy or finishing shared collection waits without consuming the historical attempt',async()=>{
  const {store,userId,appId}=await fixture(),fake=collector();
  const {scan}=await queueInitialLeadScan(store,userId,appId,1,now,env);
  await store.set('reddit_control','collector',{active:null,leaseUntil:now+60000,nextCheckAt:now+3600000});
  assert.equal(await advanceInitialLeadScan(store,scan.id,fake.provider,env,now,fake.ai),false);assert.equal(fake.calls.start,0);
  await store.set('reddit_control','collector',{leaseUntil:0,nextCheckAt:now+3600000,active:{claim:'unrelated',runId:'other',startedAt:now-30000,after:new Date(now-60000).toISOString(),before:new Date(now).toISOString(),communities:['other'],month:new Date(now).toISOString().slice(0,7)}});
  assert.equal(await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+17000,fake.ai),false);
  assert.equal((await store.get<InitialLeadScan>('lead_scans',scan.id))?.state,'queued');
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+20000,fake.ai);assert.equal(fake.calls.start,1);assert.equal(fake.calls.search,1);
});

test('deleting a scan while its search is running never recreates its receipt',async()=>{
  const {store,userId,appId}=await fixture(),fake=collector();
  const {scan}=await queueInitialLeadScan(store,userId,appId,1,now,env);
  const ai={discoverThreads:async()=>{await store.collection('lead_scans').doc(scan.id).delete();return fake.ai.discoverThreads!({} as LeadProfile,'');}} as LeadAIProvider;
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now,ai);
  assert.equal(await store.get('lead_scans',scan.id),undefined);assert.equal(fake.calls.start,0);
});

test('initial search waits for qualification and completes all three rounds even after ten matches',async()=>{
  const {store,userId,appId,profile}=await fixture();
  const {scan}=await queueInitialLeadScan(store,userId,appId,1,now,env);
  const contexts:any[]=[],batches=[['a0','a1'],Array.from({length:9},(_,i)=>`b${i}`),['c0']];
  let active:string[]=[],starts=0;
  const url=(id:string)=>`https://www.reddit.com/r/journaling/comments/${id}/`;
  const source=(id:string)=>({id,subreddit:'journaling',title:'How can I keep my journal entries together?',body:'My notes are scattered.',url:url(id),createdAt:'2021-05-01T00:00:00.000Z',score:1,comments:2});
  const provider={startThreads:async(urls:string[])=>{active=urls.map(u=>u.split('/')[6]);starts++;return {id:`run-${starts}`,status:'RUNNING'};},
    status:async()=>({id:`run-${starts}`,status:'SUCCEEDED',defaultDatasetId:'data',finishedAt:new Date(now+1000).toISOString(),usageTotalUsd:.01}),posts:async()=>active.map(source)} as unknown as RedditApify;
  const ai={discoverThreads:async(_p:any,_a:any,context:any)=>{contexts.push(context);return {model:'gpt-6-luna',usage:{inputTokens:20,outputTokens:20,searchCalls:context.phase==='quick'?2:4},
    value:{urls:batches[context.round].map(url),trace:{queries:[`angle ${context.round}`],sourceCount:12,returnedCount:batches[context.round].length,toolCalls:4}}};},
    qualifyPost:async(post:any)=>({model:'gpt-6-luna',usage:{inputTokens:20,outputTokens:20},value:post.id==='b8'
      ?{decision:'rejected',explicitIntent:false,intentQuote:'',fitEvidenceQuotes:[],capabilityIds:[],whyItFits:''}
      :{decision:'qualified',explicitIntent:true,intentQuote:post.title,fitEvidenceQuotes:[post.title],capabilityIds:[profile.capabilities[0].id],whyItFits:'Keep journal entries together.'}})} as unknown as LeadAIProvider;
  async function qualify(at:number) {for(const job of await store.list<LeadJob>('lead_jobs')) if(job.kind==='qualify'&&job.state==='pending') await processLeadQualificationJob(store,job.id,ai,env,at);}
  assert.equal(await advanceInitialLeadScan(store,scan.id,provider,env,now,ai),false);
  assert.equal(await advanceInitialLeadScan(store,scan.id,provider,env,now+17000,ai),false);
  assert.equal(await advanceInitialLeadScan(store,scan.id,provider,env,now+18000,ai),false);
  assert.equal(contexts.length,1);assert.equal(starts,1); // Do not repeat paid work while assessment is pending.
  await qualify(now+18000);
  assert.equal((await store.list<LeadJob>('lead_jobs')).filter(j=>j.kind==='qualify'&&j.state==='succeeded').length,2,JSON.stringify(await store.get<InitialLeadScan>('lead_scans',scan.id)));
  assert.equal(await advanceInitialLeadScan(store,scan.id,provider,env,now+19000,ai),false);
  assert.equal(await advanceInitialLeadScan(store,scan.id,provider,env,now+20000,ai),false);
  assert.equal(contexts[0].phase,'quick');
  assert.deepEqual(contexts[1],{round:1,totalRounds:3,phase:'background',excludeURLs:batches[0].map(url),previousQueries:['angle 0']});
  assert.equal(await advanceInitialLeadScan(store,scan.id,provider,env,now+37000,ai),false);
  await qualify(now+37000);
  assert.equal(await advanceInitialLeadScan(store,scan.id,provider,env,now+38000,ai),false);
  const continuing=await store.get<InitialLeadScan>('lead_scans',scan.id);
  assert.equal(continuing?.qualifiedCount,10);assert.equal(continuing?.state,'queued');assert.equal(continuing?.searchRound,2);
  assert.equal(await advanceInitialLeadScan(store,scan.id,provider,env,now+39000,ai),false);
  assert.deepEqual(contexts[2],{round:2,totalRounds:3,phase:'background',excludeURLs:batches.slice(0,2).flat().map(url),previousQueries:['angle 0','angle 1']});
  assert.equal(await advanceInitialLeadScan(store,scan.id,provider,env,now+56000,ai),false);
  await qualify(now+56000);
  assert.equal(await advanceInitialLeadScan(store,scan.id,provider,env,now+57000,ai),true);
  const completed=await store.get<InitialLeadScan>('lead_scans',scan.id);
  assert.equal(completed?.qualifiedCount,11);assert.equal(completed?.stopReason,'search_limit');assert.equal(completed?.allFetchedPostIds?.length,12);
  assert.equal(completed?.discoveryJobIds?.length,3);
  await advanceInitialLeadScan(store,scan.id,provider,env,now+60000,ai);
  assert.equal(contexts.length,3);assert.equal(starts,3);
});

test('legacy receipts keep their paid round identities and completed receipts never reopen',async()=>{
  const {store,userId,appId}=await fixture(),fake=collector();
  const {scan}=await queueInitialLeadScan(store,userId,appId,1,now,env);
  const {maxSearchRounds,...legacy}=scan;
  await store.set('lead_scans',scan.id,{...legacy,targetMatches:10});
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now,fake.ai);
  const firstJob=(await store.get<InitialLeadScan>('lead_scans',scan.id))?.discoveryJobId;
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+17000,fake.ai);
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+47000,fake.ai);
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+107000,fake.ai);
  const completed=await store.get<InitialLeadScan>('lead_scans',scan.id);
  assert.equal(completed?.state,'complete');assert.equal(completed?.stopReason,'search_limit');
  assert.equal(completed?.discoveryJobIds?.[0],firstJob);assert.equal(completed?.discoveryJobIds?.length,3);
  await store.set('lead_scans',scan.id,{...completed,stopReason:'target_reached'});
  assert.equal((await queueInitialLeadScan(store,userId,appId,1,now+60000,env)).started,false);
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+60000,fake.ai);
  assert.equal(fake.calls.search,3);assert.equal(fake.calls.start,1);
});

test('continuation search honors the shared budget and never replays a completed first round',async()=>{
  const {store,userId,appId}=await fixture(),fake=collector();
  const {scan}=await queueInitialLeadScan(store,userId,appId,1,now,env);
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now,fake.ai);
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+17000,fake.ai);
  assert.equal(await advanceInitialLeadScan(store,scan.id,fake.provider,{...env,LEADS_AI_ACCOUNT_CAP_USD:'0.001'},now+47000,fake.ai),true);
  assert.equal((await store.get<InitialLeadScan>('lead_scans',scan.id))?.state,'paused');
  assert.equal(fake.calls.search,1);assert.equal(fake.calls.start,1);
});

test('a recorded operator allowance is app-scoped, historical-only, counted once, and bounded',async()=>{
  const {store,userId,appId,profile}=await fixture();
  for(const id of ['old1','old2','old3']) await store.set('reddit_posts',id,{id,subreddit:'journaling',title:'How do I track journal entries?',body:'I need a journal.',createdAt:new Date(now-1000).toISOString(),expireAt:Timestamp.fromMillis(now+86400000)});
  await enqueueHistoricalCandidates(store,profile,['old1','old2','old3'],now);
  const jobs=(await store.list<LeadJob>('lead_jobs')).sort((a,b)=>a.postId!.localeCompare(b.postId!));
  const dailyId=documentKey(userId,new Date(now).toISOString().slice(0,10));
  await store.set('lead_daily_usage',dailyId,{qualify:300,operatorHistoricalAllowance:{appId:'another-app',limit:1,used:0,reason:'Requested test'}});
  let calls=0;const ai={qualifyPost:async()=>{calls++;return {model:'gpt-6-luna',usage:{inputTokens:20,outputTokens:20},value:{decision:'rejected',explicitIntent:false,intentQuote:'',fitEvidenceQuotes:[],capabilityIds:[],whyItFits:''}};}} as unknown as LeadAIProvider;
  await processLeadQualificationJob(store,jobs[0].id,ai,env,now);assert.equal(calls,0);
  await store.set('lead_daily_usage',dailyId,{qualify:300,operatorHistoricalAllowance:{appId,limit:1,used:0,reason:'Requested test'}});
  await store.set('lead_jobs',jobs[0].id,{nextAttemptAt:now},true);
  await processLeadQualificationJob(store,jobs[0].id,ai,env,now);await processLeadQualificationJob(store,jobs[0].id,ai,env,now);
  const daily=await store.get<any>('lead_daily_usage',dailyId);assert.equal(calls,1);assert.equal(daily.qualify,301);assert.equal(daily.operatorHistoricalAllowance.used,1);
  await processLeadQualificationJob(store,jobs[1].id,ai,env,now);assert.equal(calls,1);assert.equal((await store.get<LeadJob>('lead_jobs',jobs[1].id))?.reasonCode,'DAILY_LIMIT');
  await store.set('lead_daily_usage',dailyId,{...daily,operatorHistoricalAllowance:{...daily.operatorHistoricalAllowance,limit:60}});
  await store.set('lead_jobs',jobs[2].id,{historical:false},true);
  await processLeadQualificationJob(store,jobs[2].id,ai,env,now);assert.equal(calls,1);
});

 test('daily qualification cap permits review 300 and defers review 301',async()=>{
  const {store,userId,appId,profile}=await fixture();
  for(const id of ['cap1','cap2']) await store.set('reddit_posts',id,{id,subreddit:'journaling',title:'How do I track journal entries?',body:'I need a journal.',createdAt:new Date(now-1000).toISOString(),expireAt:Timestamp.fromMillis(now+86400000)});
  await enqueueHistoricalCandidates(store,profile,['cap1','cap2'],now);
  const jobs=await store.list<LeadJob>('lead_jobs');
  const dailyId=documentKey(userId,new Date(now).toISOString().slice(0,10));
  await store.set('lead_daily_usage',dailyId,{qualify:299});
  let calls=0;const ai={qualifyPost:async()=>{calls++;return {model:'gpt-6-luna',usage:{inputTokens:20,outputTokens:20},value:{decision:'rejected',explicitIntent:false,intentQuote:'',fitEvidenceQuotes:[],capabilityIds:[],whyItFits:''}};}} as unknown as LeadAIProvider;
  await processLeadQualificationJob(store,jobs[0].id,ai,env,now);
  assert.equal(calls,1);assert.equal((await store.get<any>('lead_daily_usage',dailyId)).qualify,300);
  await processLeadQualificationJob(store,jobs[1].id,ai,env,now);
  assert.equal(calls,1);const pending=await store.get<LeadJob>('lead_jobs',jobs[1].id);assert.equal(pending?.reasonCode,'DAILY_LIMIT');assert.equal(pending?.state,'pending');
 });


test('empty search retries use durable exponential backoff and never replay paid rounds',async()=>{
  const {store,userId,appId}=await fixture(),fake=collector();
  const ai={discoverThreads:async()=>{fake.calls.search++;return {model:'gpt-6-luna',usage:{inputTokens:50,outputTokens:20,searchCalls:1},value:{urls:[]}};}} as LeadAIProvider;
  const {scan}=await queueInitialLeadScan(store,userId,appId,1,now,env);
  assert.equal(await advanceInitialLeadScan(store,scan.id,fake.provider,env,now,ai),false);
  assert.equal((await store.get<InitialLeadScan>('lead_scans',scan.id))?.nextSearchAt,now+30000);
  await Promise.all(Array.from({length:3},()=>advanceInitialLeadScan(store,scan.id,fake.provider,env,now+29999,ai)));
  assert.equal(fake.calls.search,1);
  assert.equal((await queueInitialLeadScan(store,userId,appId,1,now+29999,env)).started,false);
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+30000,ai);
  assert.equal(fake.calls.search,2);
  assert.equal((await store.get<InitialLeadScan>('lead_scans',scan.id))?.nextSearchAt,now+90000);
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+89999,ai);assert.equal(fake.calls.search,2);
  assert.equal(await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+90000,ai),true);
  await advanceInitialLeadScan(store,scan.id,fake.provider,env,now+200000,ai);
  assert.equal(fake.calls.search,3);assert.equal(fake.calls.start,0);
});

for(const historical of [true,false]) test(`setup source reviews bypass the daily cap, including monitoring overlap (${historical})`,async()=>{
  const {store,userId,appId,profile}=await fixture();
  for(const id of ['setup1','other1']) await store.set('reddit_posts',id,{id,subreddit:'journaling',title:'How do I track journal entries?',body:'I need a journal.',createdAt:new Date(now-1000).toISOString(),expireAt:Timestamp.fromMillis(now+86400000)});
  const {scan}=await queueInitialLeadScan(store,userId,appId,1,now,env);
  await store.set('lead_scans',scan.id,{fetchedPostIds:['setup1']},true);
  await enqueueHistoricalCandidates(store,profile,['setup1','other1'],now);
  const jobs=await store.list<LeadJob>('lead_jobs'),setup=jobs.find(j=>j.postId==='setup1')!,other=jobs.find(j=>j.postId==='other1')!;
  await store.set('lead_jobs',setup.id,{historical},true);
  const dailyId=documentKey(userId,new Date(now).toISOString().slice(0,10));await store.set('lead_daily_usage',dailyId,{qualify:300});
  let calls=0;const ai={qualifyPost:async()=>{calls++;return {model:'gpt-6-luna',usage:{inputTokens:20,outputTokens:20},value:{decision:'rejected',explicitIntent:false,intentQuote:'',fitEvidenceQuotes:[],capabilityIds:[],whyItFits:''}};}} as unknown as LeadAIProvider;
  await processLeadQualificationJob(store,setup.id,ai,{...env,LEADS_AI_ACCOUNT_CAP_USD:'0.00001'},now);
  assert.equal(calls,0);assert.equal((await store.get<LeadJob>('lead_jobs',setup.id))?.reasonCode,'BUDGET_PAUSED');
  await store.set('lead_jobs',setup.id,{nextAttemptAt:now},true);
  await processLeadQualificationJob(store,setup.id,ai,env,now);
  await processLeadQualificationJob(store,setup.id,ai,env,now);
  assert.equal(calls,1);const daily=await store.get<any>('lead_daily_usage',dailyId);
  assert.equal(daily.qualify,300);assert.equal(daily.onboardingQualify,1);
  await processLeadQualificationJob(store,other.id,ai,env,now);assert.equal(calls,1);
  assert.equal((await store.get<LeadJob>('lead_jobs',other.id))?.reasonCode,'DAILY_LIMIT');
  await store.set('lead_scans',scan.id,{fetchedPostIds:['setup1','other1']},true);
  await enqueueHistoricalCandidates(store,profile,['other1'],now);
  assert.equal((await store.get<LeadJob>('lead_jobs',other.id))?.nextAttemptAt,now);
  assert.equal((await store.get<LeadJob>('lead_jobs',other.id))?.reasonCode,'');
  await processLeadQualificationJob(store,other.id,ai,env,now);assert.equal(calls,2);
  assert.equal((await store.get<any>('lead_daily_usage',dailyId))?.qualify,300);
});
