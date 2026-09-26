import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {Timestamp} from 'firebase-admin/firestore';
import {testStore} from './firebase-fixture.js';
import {Store,documentKey,type AppRow} from '../src/database.js';
import {advanceMarketScan,marketScanDTO,purgeMarketAccountData,purgeMarketAppData,queueMarketScan as queueNewMarketScan,recoverMarketScans,type MarketRunProvider} from '../src/market-jobs.js';
import {estimateMarketInputBytes} from '../src/market-ai.js';
import type {LeadProfile} from '../src/leads-types.js';
import type {MarketAIProvider,MarketAnalysisOutput,MarketSource} from '../src/market-types.js';
import type {ApifyRun} from '../src/reddit-apify.js';

// Existing jobs remain readable after web research becomes the default.
async function queueMarketScan(...args:Parameters<typeof queueNewMarketScan>) {
  const row=await queueNewMarketScan(...args);
  const legacy={...row,researchMode:false,collectionPhase:'search' as const};
  await args[0].set('market_scans',row.id,legacy);
  return legacy;
}

const base=Date.now();
const capabilityID='70000000-0000-4000-8000-000000000001';
function runtimeEnv(userId:string):NodeJS.ProcessEnv {return {MARKET_ENABLED:'true',MARKET_AI_ENABLED:'true',LEADS_MODEL_ID:'gpt-6-luna',
  LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION:'1',LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION:'4',OPENAI_API_KEY:'fixture-market-key',APIFY_TOKEN:'fixture-apify-token',
  REDDIT_MONITORING_ENABLED:'true',REDDIT_PUBLIC_ACCESS:'false',REDDIT_BETA_USER_IDS:userId};}
async function appFixture(store:Store,userId:string) {
  const app:AppRow={id:randomUUID(),user_id:userId,name:'Market fixture',bundle_id:`test.${randomUUID()}`,apple_id:'123456789',source:'apple',icon_url:null,
    webhook_secret:randomUUID(),created_at:new Date(base).toISOString(),last_production_at:null,last_sandbox_at:null,active:true};
  const profile:LeadProfile={user_id:userId,app_id:app.id,schemaVersion:1,revision:1,enabled:false,
    problems:[{id:'50000000-0000-4000-8000-000000000001',text:'Keep a reliable list of owned collectibles'}],
    capabilities:[{id:capabilityID,text:'Track owned collectibles',source:'user_confirmed'}],communities:['collectibles'],keywords:['collection'],
    descriptionSource:null,confirmedAt:new Date(base).toISOString(),updatedAt:new Date(base).toISOString()};
  await store.set('apps',app.id,app);await store.set('lead_profiles',documentKey(userId,app.id),profile);return {app,profile};
}
function requestKey() {return randomUUID();}
function run(id:string,dataset:string,status='RUNNING'):ApifyRun {return {id,defaultDatasetId:dataset,status};}
function sourceFixture():MarketSource {
  const id=`reddit:post:${randomUUID().replaceAll('-','').slice(0,8)}`,threadId=id.slice('reddit:post:'.length),createdAt=new Date(base-60_000).toISOString();
  return {id,provider:'reddit',kind:'post',threadId,parentId:null,authorKey:'reddit:t2_fixtureauthor',authorDisplayName:'Fixture',
    title:'Need a better collection list',text:'I need a reliable way to track my collectible inventory.',community:'collectibles',
    url:`https://www.reddit.com/r/collectibles/comments/${threadId}/`,createdAt,fetchedAt:new Date(base).toISOString(),contentHash:`hash-${threadId}`,
    expiresAt:new Date(base+29*86400000).toISOString(),expireAt:Timestamp.fromMillis(base+29*86400000)};
}
async function seedAnalyzingScan(store:Store,userId:string,app:AppRow,profile:LeadProfile,env:NodeJS.ProcessEnv,at=base) {
  const scan=await queueMarketScan(store,userId,app.id,{expectedRevision:profile.revision,idempotencyKey:requestKey()},env,at),source=sourceFixture();
  await store.set('market_sources',source.id,source);
  await store.set('market_scans',scan.id,{state:'analyzing',collectionPhase:'analyzing',sourceIds:[source.id],nextAttemptAt:at,
    collectionDispatched:false,aiDispatched:false},true);
  return {scan,source};
}
function marketAI(onCall:(input:Parameters<MarketAIProvider['analyze']>[0])=>Promise<void>|void=()=>{}):MarketAIProvider {
  return {analyze:async(input)=>{
    await onCall(input);const source=input.sources[0]!;
    const value:MarketAnalysisOutput={groups:[{problemId:null,groupKey:'owned-collectible-inventory',title:'Tracking owned collectibles',
      summary:'People need a reliable list of collectibles they already own.',signalKind:'recurring_problem',observations:[{sourceId:source.id,quote:source.text,
        explanation:'The author wants a dependable inventory.',prospectReason:'The need remains unresolved.',needStatus:'unresolved',isProductBuilder:false,
        isSatisfied:false,matchedCapabilityIds:[capabilityID],competitorName:null}]}]};
    return {value,inputTokens:20,outputTokens:10,inputBytes:estimateMarketInputBytes(input),model:'gpt-6-luna'};
  }} as MarketAIProvider;
}
const unusedSource:MarketRunProvider={startSearch:async()=>{throw new Error('Unexpected source start.');},startThreadComments:async()=>{throw new Error('Unexpected comments start.');},
  status:async()=>{throw new Error('Unexpected source status.');},datasetRows:async()=>{throw new Error('Unexpected source dataset.');}};

test('coalesced idempotency keys keep resolving to one active scan after it finishes',async()=>{
  const store=testStore(),userId=`market-idem-${randomUUID()}`,{app,profile}=await appFixture(store,userId),env=runtimeEnv(userId);
  const first=await queueMarketScan(store,userId,app.id,{expectedRevision:profile.revision,idempotencyKey:requestKey()},env,base);
  const secondKey=requestKey();
  const coalesced=await queueMarketScan(store,userId,app.id,{expectedRevision:profile.revision,idempotencyKey:secondKey},env,base+1);
  assert.equal(coalesced.id,first.id);
  const alias=await store.get<any>('market_scan_keys',documentKey(userId,app.id,secondKey));assert.equal(alias?.scanId,first.id);
  await store.set('market_scans',first.id,{state:'complete',finishedAt:new Date(base+2).toISOString()},true);
  const retry=await queueMarketScan(store,userId,app.id,{expectedRevision:profile.revision,idempotencyKey:secondKey},env,base+3);
  assert.equal(retry.id,first.id);assert.equal(marketScanDTO(retry,base+3).status,'complete');
  assert.equal((await store.list('market_scans')).length,1);
});

test('expired scan recovery fences the job and settles outstanding shared budgets once',async()=>{
  const store=testStore(),userId=`market-expired-${randomUUID()}`,{app,profile}=await appFixture(store,userId),env=runtimeEnv(userId);
  const queued=await queueMarketScan(store,userId,app.id,{expectedRevision:profile.revision,idempotencyKey:requestKey()},env,base);
  const month=new Date(base).toISOString().slice(0,7),hash=createHash('sha256').update(userId).digest('hex'),accountBudgetID=`${month}-${hash}`;
  const expired=Timestamp.fromMillis(base-1);
  await store.set('market_scans',queued.id,{expireAt:expired,collectionDispatched:true,aiDispatched:true,aiReservationMicroUsd:340,
    leaseToken:'stale-worker',leaseUntil:base+60_000},true);
  await store.set('reddit_budgets',month,{reserved:0.5,spent:0});
  await store.set('market_collection_reservations',documentKey(queued.id,'search'),{scan_id:queued.id,user_id:userId,app_id:app.id,month,phase:'search',
    reservedUsd:0.5,state:'reserved',dispatched:false});
  for(const [id,extra] of [[month,{}],[accountBudgetID,{account_hash:hash}] ] as const)
    await store.set('lead_ai_budgets',id,{reservedMicroUsd:340,spentMicroUsd:0,...extra});
  await store.set('market_ai_reservations',documentKey(queued.id,'market-ai'),{scan_id:queued.id,user_id:userId,app_id:app.id,account_hash:hash,month,
    reservedMicroUsd:340,state:'reserved'});

  assert.deepEqual(await recoverMarketScans(store,base,10),[]);
  const job=await store.get<any>('market_scans',queued.id);assert.equal(job.state,'cancelled');assert.equal(job.reasonCode,'SCAN_EXPIRED');
  assert.equal(job.leaseToken,'');assert.equal(job.fence,1);
  const reddit=await store.get<any>('reddit_budgets',month);assert.equal(reddit.reserved,0);assert.equal(reddit.spent,0.5);
  const aiGlobal=await store.get<any>('lead_ai_budgets',month);assert.equal(aiGlobal.reservedMicroUsd,0);assert.equal(aiGlobal.spentMicroUsd,340);
  const aiAccount=await store.get<any>('lead_ai_budgets',accountBudgetID);assert.equal(aiAccount.reservedMicroUsd,0);assert.equal(aiAccount.spentMicroUsd,340);
  assert.equal((await store.get<any>('market_ai_reservations',documentKey(queued.id,'market-ai'))).state,'uncertain');
  assert.equal((await store.get<any>('market_collection_reservations',documentKey(queued.id,'search'))).state,'uncertain');
  await recoverMarketScans(store,base+1,10);
  assert.equal((await store.get<any>('reddit_budgets',month)).spent,0.5,'settlement is idempotent');
});

for (const terminalStatus of ['SUCCEEDED','ABORTED','TIMED-OUT','FAILED'])
test(`durable scan analyzes validated ${terminalStatus} partial datasets without repeating collection`,async()=>{
  const store=testStore(),userId=`market-worker-${randomUUID()}`,{app,profile}=await appFixture(store,userId),env=runtimeEnv(userId);
  const queued=await queueMarketScan(store,userId,app.id,{expectedRevision:profile.revision,idempotencyKey:requestKey()},env,base);
  const post={dataType:'post',id:'threadone',parsedId:'threadone',subredditName:'collectibles',title:'Need a better collection list',
    body:'I need a simple way to track my collection.',createdAt:new Date(base-60_000).toISOString(),authorFullname:'t2_postauthor',authorName:'Poster',
    url:'https://www.reddit.com/r/collectibles/comments/threadone/'};
  const comment={dataType:'comment',id:'commentone',parsedId:null,parsedPostId:'threadone',postId:'t3_threadone',parentId:'t3_threadone',
    subredditName:'collectibles',body:'I still have to organize every shelf by hand.',commentCreatedAt:new Date(base-30_000).toISOString(),
    authorFullname:'t2_commentauthor',authorName:'Commenter',url:'https://www.reddit.com/r/collectibles/comments/threadone/_/commentone/'};
  let phase:'search'|'comments'='search';let statusCalls=0;let analyzedSources:string[]=[];
  const source:MarketRunProvider={
    startSearch:async()=>{phase='search';return run('market-search','market-search-data');},
    startThreadComments:async(posts)=>{assert.equal(posts.length,1);phase='comments';return run('market-comments','market-comments-data');},
    status:async(id)=>{statusCalls++;assert.equal(id,phase==='search'?'market-search':'market-comments');return {...run(id,phase==='search'?'market-search-data':'market-comments-data',terminalStatus),
      finishedAt:new Date(base-20_000).toISOString(),usageTotalUsd:0.12};},
    datasetRows:async(id)=>id==='market-search-data'?[post]:id==='market-comments-data'?[comment]:[],
  };
  const ai:MarketAIProvider={analyze:async(input)=>{
    analyzedSources=input.sources.map(item=>item.id);
    const selected=input.sources.find(item=>item.kind==='post')!;
    const value:MarketAnalysisOutput={groups:[{problemId:null,groupKey:'owned-collection-tracking',title:'Tracking owned collectibles',
      summary:'Collectors need a dependable list of what they already own.',signalKind:'recurring_problem',observations:[{sourceId:selected.id,
        quote:selected.text,explanation:'The author wants a collection inventory.',prospectReason:'The difficulty remains unresolved.',needStatus:'unresolved',
        isProductBuilder:false,isSatisfied:false,matchedCapabilityIds:[capabilityID],competitorName:null}]}]};
    return {value,inputTokens:20,outputTokens:10,inputBytes:estimateMarketInputBytes(input),model:'gpt-6-luna'};
  }};

  assert.equal((await advanceMarketScan(store,queued.id,source,ai,env,base)).pending,true);
  assert.equal((await advanceMarketScan(store,queued.id,source,ai,env,base+6_000)).pending,true);
  assert.equal((await advanceMarketScan(store,queued.id,source,ai,env,base+12_000)).pending,true);
  assert.equal((await advanceMarketScan(store,queued.id,source,ai,env,base+18_000)).pending,undefined);
  const beforeAI=await store.get<any>('market_scans',queued.id);assert.equal(beforeAI.state,'analyzing');assert.equal(beforeAI.collectionPhase,'analyzing');
  const finished=await advanceMarketScan(store,queued.id,source,ai,env,base+24_000);
  assert.equal(finished.done,true);assert.equal(analyzedSources.length,2);
  const scan=await store.get<any>('market_scans',queued.id);assert.equal(scan.state,'complete');assert.equal(scan.coverage,terminalStatus==='SUCCEEDED'?'complete_for_configured_scan':'partial');
  assert.equal(statusCalls,2);
  const snapshot=await store.get<any>('market_snapshots',scan.snapshotId);assert.equal(snapshot.sourceIds.length,2);
  assert.equal(snapshot.coverage,terminalStatus==='SUCCEEDED'?'complete_for_configured_scan':'partial');
  assert.equal(snapshot.observationIds.length,1,'all eligible sources remain in the snapshot even when only one supports a group');
  const collectionBudget=await store.get<any>('reddit_budgets',new Date(base).toISOString().slice(0,7));
  assert.equal(collectionBudget.reserved,0);assert.equal(collectionBudget.spent,0.24);
  const globalAI=await store.get<any>('lead_ai_budgets',new Date(base).toISOString().slice(0,7));
  assert.equal(globalAI.reservedMicroUsd,0);assert.equal(globalAI.spentMicroUsd,60);
});

test('app purge settles and fences a reserved Market scan before deleting its rows',async()=>{
  const store=testStore(),userId=`market-purge-${randomUUID()}`,{app,profile}=await appFixture(store,userId),env=runtimeEnv(userId);
  const queued=await queueMarketScan(store,userId,app.id,{expectedRevision:profile.revision,idempotencyKey:requestKey()},env,base);
  const month=new Date(base).toISOString().slice(0,7);
  await store.set('reddit_budgets',month,{reserved:0.5,spent:0});
  await store.set('market_collection_reservations',documentKey(queued.id,'search'),{scan_id:queued.id,user_id:userId,app_id:app.id,month,phase:'search',
    reservedUsd:0.5,state:'reserved',dispatched:false});
  await purgeMarketAppData(store,app.id,base+1);
  assert.equal(await store.get('market_scans',queued.id),undefined);
  assert.equal((await store.get<any>('reddit_budgets',month)).spent,0.5);
  assert.equal((await store.list('market_collection_reservations')).length,0);
});

test('shared provider pause and budget caps block Market before a paid AI call',async()=>{
  const store=testStore(),userId=`market-budget-${randomUUID()}`,{app,profile}=await appFixture(store,userId),normal=runtimeEnv(userId);
  const lowCap={...normal,LEADS_AI_GLOBAL_CAP_USD:'0.0001'};
  const first=await seedAnalyzingScan(store,userId,app,profile,lowCap);
  let calls=0;const provider=marketAI(()=>{calls++;});
  await advanceMarketScan(store,first.scan.id,unusedSource,provider,lowCap,base);
  const budgetFailure=await store.get<any>('market_scans',first.scan.id);
  assert.equal(budgetFailure.state,'failed');assert.equal(budgetFailure.reasonCode,'AI_BUDGET_EXHAUSTED');assert.equal(calls,0);
  assert.equal(await store.get('market_ai_reservations',documentKey(first.scan.id,'market-ai')),undefined);

  const second=await seedAnalyzingScan(store,userId,app,profile,normal,base+1);
  await store.set('lead_control','provider',{paused:true,ready:false,reasonCode:'LEADS_PROVIDER_PAUSED'});
  await advanceMarketScan(store,second.scan.id,unusedSource,provider,normal,base+1);
  const pauseFailure=await store.get<any>('market_scans',second.scan.id);
  assert.equal(pauseFailure.state,'failed');assert.equal(pauseFailure.reasonCode,'LEADS_PROVIDER_PAUSED');assert.equal(calls,0);
});

test('an ambiguous paid collection start is settled and never repeated',async()=>{
  const store=testStore(),userId=`market-start-${randomUUID()}`,{app,profile}=await appFixture(store,userId),env=runtimeEnv(userId);
  const scan=await queueMarketScan(store,userId,app.id,{expectedRevision:profile.revision,idempotencyKey:requestKey()},env,base);
  let starts=0;
  const provider:MarketRunProvider={startSearch:async()=>{starts++;throw new Error('connection closed after dispatch');},startThreadComments:unusedSource.startThreadComments,
    status:unusedSource.status,datasetRows:unusedSource.datasetRows};
  await advanceMarketScan(store,scan.id,provider,marketAI(),env,base);
  await advanceMarketScan(store,scan.id,provider,marketAI(),env,base+1);
  const job=await store.get<any>('market_scans',scan.id);assert.equal(job.state,'failed');assert.equal(job.reasonCode,'COLLECTION_START_UNCERTAIN');
  assert.equal(starts,1);
  const reservation=await store.get<any>('market_collection_reservations',documentKey(scan.id,'search'));
  assert.equal(reservation.state,'uncertain');assert.equal(reservation.settledUsd,0.5);
});

test('provider pause arriving during an in-flight response preserves paid output and blocks the next scan',async()=>{
  const store=testStore(),userId=`market-paused-inflight-${randomUUID()}`,{app,profile}=await appFixture(store,userId),env=runtimeEnv(userId);
  const first=await seedAnalyzingScan(store,userId,app,profile,env,base);let started!:()=>void,release!:()=>void;
  const began=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  const ai=marketAI(async()=>{calls++;started();await gate;});
  const running=advanceMarketScan(store,first.scan.id,unusedSource,ai,env,base);await began;
  const reserved=await store.get<any>('lead_ai_budgets',new Date(base).toISOString().slice(0,7));assert.ok(reserved.reservedMicroUsd>0);
  await store.set('lead_control','provider',{paused:true,ready:false,reasonCode:'LEADS_PROVIDER_PAUSED'});
  release();await running;
  const completed=await store.get<any>('market_scans',first.scan.id);assert.equal(completed.state,'complete');assert.ok(completed.snapshotId);
  assert.equal((await store.get<any>('lead_control','provider')).paused,true);

  const second=await seedAnalyzingScan(store,userId,app,profile,env,base+1);
  await advanceMarketScan(store,second.scan.id,unusedSource,ai,env,base+1);
  const blocked=await store.get<any>('market_scans',second.scan.id);assert.equal(blocked.reasonCode,'LEADS_PROVIDER_PAUSED');assert.equal(calls,1);
});

test('profile changes during AI work cancel the stale scan and charge only its known response cost',async()=>{
  const store=testStore(),userId=`market-stale-${randomUUID()}`,{app,profile}=await appFixture(store,userId),env=runtimeEnv(userId);
  const fixture=await seedAnalyzingScan(store,userId,app,profile,env,base);let started!:()=>void,release!:()=>void;
  const began=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const running=advanceMarketScan(store,fixture.scan.id,unusedSource,marketAI(async()=>{started();await gate;}),env,base);await began;
  await store.set('lead_profiles',documentKey(userId,app.id),{...profile,revision:2,updatedAt:new Date(base+1).toISOString()});
  release();await running;
  const job=await store.get<any>('market_scans',fixture.scan.id);assert.equal(job.state,'cancelled');assert.equal(job.reasonCode,'STALE_PROFILE');
  assert.equal(job.leaseToken,'');assert.equal((await store.list('market_snapshots')).length,0);
  const budget=await store.get<any>('lead_ai_budgets',new Date(base).toISOString().slice(0,7));
  assert.equal(budget.reservedMicroUsd,0);assert.equal(budget.spentMicroUsd,60);
});

for(const scope of ['app','account'] as const) test(`${scope} deletion fences an in-flight Market response before purging`,async()=>{
  const store=testStore(),userId=`market-delete-${scope}-${randomUUID()}`,{app,profile}=await appFixture(store,userId),env=runtimeEnv(userId);
  const fixture=await seedAnalyzingScan(store,userId,app,profile,env,base);let started!:()=>void,release!:()=>void;
  const began=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const running=advanceMarketScan(store,fixture.scan.id,unusedSource,marketAI(async()=>{started();await gate;}),env,base);await began;
  const month=new Date(base).toISOString().slice(0,7),before=await store.get<any>('lead_ai_budgets',month);
  assert.ok(before.reservedMicroUsd>0);
  if(scope==='app') {
    await store.set('apps',app.id,{active:false},true);await purgeMarketAppData(store,app.id,base+1);
  } else {
    await store.set('account_deletions',userId,{state:'pending'});await purgeMarketAccountData(store,userId,base+1);
  }
  release();await running;
  assert.equal((await store.list('market_snapshots')).length,0);
  assert.equal((await store.list('market_scans')).length,0);
  const after=await store.get<any>('lead_ai_budgets',month);assert.equal(after.reservedMicroUsd,0);
  assert.equal(after.spentMicroUsd,before.spentMicroUsd+before.reservedMicroUsd,'an uncertain dispatched request is charged at its reservation ceiling');
});

test('new Market scans research the wider web even with no collected Reddit posts and settle shared search and extraction costs',async()=>{
  const store=testStore(),userId=`market-web-${randomUUID()}`,{app,profile}=await appFixture(store,userId),env=runtimeEnv(userId);
  env.LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION='0.125';env.LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION='0.5';
  const queued=await queueNewMarketScan(store,userId,app.id,{expectedRevision:profile.revision,idempotencyKey:requestKey()},env,base);
  assert.equal(queued.researchMode,true);
  let searches=0;
  const value={findings:[{title:'Keeping track of owned figures',summary:'Collectors describe maintaining lists. This is an early research finding.',sources:[{title:'Public forum discussion',url:'https://forum.example.com/collections'}]}]};
  const {researchInputBytes}=await import('../src/market-research.js');
  const ai:MarketAIProvider={analyze:async()=>{throw new Error('Legacy analysis should not run');},research:async input=>{
    searches++;return {value,model:'gpt-6-luna',inputTokens:100,outputTokens:100,searchCalls:2,detailsCostMicroUsd:38,inputBytes:researchInputBytes(input)};
  }};
  const source:MarketRunProvider={startSearch:async()=>{throw new Error('No Apify collection for web research');},startThreadComments:async()=>{throw new Error('No comment run');},status:async()=>{throw new Error('No collector polling');},datasetRows:async()=>{throw new Error('No dataset');}};
  await advanceMarketScan(store,queued.id,source,ai,env,base);
  await advanceMarketScan(store,queued.id,source,ai,env,base+6000);
  assert.equal(searches,1);
  const scan=await store.get<any>('market_scans',queued.id);assert.equal(scan.state,'complete');
  const snapshot=await store.get<any>('market_snapshots',scan.snapshotId);assert.deepEqual(snapshot.research,value);assert.equal(snapshot.coverage,'partial');assert.deepEqual(snapshot.problems,[]);
  const budget=await store.get<any>('lead_ai_budgets',new Date(base).toISOString().slice(0,7));assert.equal(budget.reservedMicroUsd,0);assert.equal(budget.spentMicroUsd,20101);
});

test('research exceeding its dollar reservation pauses paid work and saves no findings',async()=>{
 const store=testStore(),userId=`market-overrun-${randomUUID()}`,{app,profile}=await appFixture(store,userId),env=runtimeEnv(userId);
 env.LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION='0.125';env.LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION='0.5';
 const queued=await queueNewMarketScan(store,userId,app.id,{expectedRevision:profile.revision,idempotencyKey:requestKey()},env,base);
 const {researchInputBytes}=await import('../src/market-research.js');
 const ai:MarketAIProvider={analyze:async()=>{throw new Error('Unexpected legacy call');},research:async input=>({value:{findings:[]},model:'gpt-6-luna',inputTokens:100,outputTokens:100,searchCalls:100,inputBytes:researchInputBytes(input)})};
 await advanceMarketScan(store,queued.id,{} as MarketRunProvider,ai,env,base);
 await advanceMarketScan(store,queued.id,{} as MarketRunProvider,ai,env,base+6000);
 const row=await store.get<any>('market_scans',queued.id);assert.equal(row.state,'failed');assert.equal(row.reasonCode,'AI_COST_LIMIT_BREACH');assert.equal(row.snapshotId,undefined);
 const control=await store.get<any>('lead_control','provider');assert.equal(control.paused,true);
 const budget=await store.get<any>('lead_ai_budgets',new Date(base).toISOString().slice(0,7));assert.equal(budget.reservedMicroUsd,0);assert.equal(budget.spentMicroUsd,1000063);
});

test('account-specific Market cap enables only that account and never bypasses global spending',async()=>{
 for(const scenario of ['approved','other-account','invalid','global-full']){
  const store=testStore(),userId=`market-limit-${randomUUID()}`,{app,profile}=await appFixture(store,userId),env=runtimeEnv(userId);
  env.MARKET_RESEARCH_PIPELINE='sol-luna';env.LEADS_AI_ACCOUNT_CAP_USD='4';env.LEADS_AI_GLOBAL_CAP_USD='5';
  const hash=createHash('sha256').update(userId).digest('hex'),month=new Date(base).toISOString().slice(0,7);
  await store.set('market_account_limits',scenario==='other-account'?'different-account':hash,{capMicroUsd:scenario==='invalid'?-1:5e6});
  await store.set('lead_ai_budgets',month,{spentMicroUsd:scenario==='global-full'?4e6:1.8e6,reservedMicroUsd:0});
  await store.set('lead_ai_budgets',`${month}-${hash}`,{account_hash:hash,spentMicroUsd:1.8e6,reservedMicroUsd:0});
  const queued=await queueNewMarketScan(store,userId,app.id,{expectedRevision:profile.revision,idempotencyKey:requestKey()},env,base);
  let called=false;const {researchInputBytes}=await import('../src/market-research.js');
  const ai:MarketAIProvider={analyze:async()=>{throw Error('Unexpected');},research:async input=>{called=true;return {value:{findings:[]},model:'gpt-6-sol',inputTokens:100,outputTokens:100,searchCalls:1,inputBytes:researchInputBytes(input)};}};
  await advanceMarketScan(store,queued.id,{} as MarketRunProvider,ai,env,base);
  assert.equal(called,scenario==='approved',scenario);
  const scan=await store.get<any>('market_scans',queued.id);assert.equal(scan.state,scenario==='approved'?'complete':'failed');
  const budget=await store.get<any>('lead_ai_budgets',month);assert.equal(budget.reservedMicroUsd,0);
 }
});
