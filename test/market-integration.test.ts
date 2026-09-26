import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {Timestamp} from 'firebase-admin/firestore';
import {testStore} from './firebase-fixture.js';
import {Store,documentKey,type AppRow} from '../src/database.js';
import {marketRouter} from '../src/market.js';
import {marketSourceContentHash} from '../src/market-sources.js';
import type {LeadProfile} from '../src/leads-types.js';
import type {MarketObservation,MarketProblemDTO,MarketProblemRecord,MarketSnapshot,MarketSource} from '../src/market-types.js';

const now=Date.now();
const routeEnv=(userId:string):NodeJS.ProcessEnv=>({MARKET_ENABLED:'true',MARKET_AI_ENABLED:'true',MARKET_CURSOR_SECRET:'test-market-cursor-secret-with-sufficient-entropy',
  REDDIT_MONITORING_ENABLED:'true',REDDIT_PUBLIC_ACCESS:'false',REDDIT_BETA_USER_IDS:userId,APIFY_TOKEN:'fixture-token',OPENAI_API_KEY:'fixture-key',
  LEADS_MODEL_ID:'gpt-6-luna',LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION:'1',LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION:'4'});

async function addApp(store:Store,userId:string,name='Market fixture'):Promise<AppRow> {
  const app:AppRow={id:randomUUID(),user_id:userId,name,bundle_id:`test.${randomUUID()}`,apple_id:'123456789',source:'apple',icon_url:null,
    webhook_secret:randomUUID(),created_at:new Date(now).toISOString(),last_production_at:null,last_sandbox_at:null,active:true};
  await store.set('apps',app.id,app);return app;
}
function makeProfile(userId:string,appId:string,revision=1):LeadProfile {
  return {user_id:userId,app_id:appId,schemaVersion:1,revision,enabled:false,problems:[{id:randomUUID(),text:'Keep track of owned collectibles'}],
    capabilities:[{id:randomUUID(),text:'Track collectibles already owned',source:'user_confirmed'}],communities:['collectibles'],keywords:['collection'],
    descriptionSource:null,confirmedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
}
function makeSource(input:{id:string;authorKey:string|null;authorDisplayName:string|null;threadId:string;kind?:'post'|'comment';createdAt?:number;expireAt?:number}):MarketSource {
  const kind=input.kind??'post',createdAt=new Date(input.createdAt??now-60_000).toISOString();
  const core={id:input.id,provider:'reddit' as const,kind,threadId:input.threadId,parentId:kind==='comment'?`t3_${input.threadId}`:null,
    authorKey:input.authorKey,authorDisplayName:input.authorDisplayName,title:kind==='post'?'How do I track what I own?':null,
    text:'I need a simple way to track my collectible inventory.',community:'collectibles',
    url:kind==='post'?`https://www.reddit.com/r/collectibles/comments/${input.threadId}/`:`https://www.reddit.com/r/collectibles/comments/${input.threadId}/_/${input.id.split(':').at(-1)}/`,
    createdAt};
  const expireAt=input.expireAt??Date.parse(createdAt)+30*86400000;
  return {...core,fetchedAt:new Date(now).toISOString(),contentHash:marketSourceContentHash(core),
    expiresAt:new Date(Date.parse(createdAt)+30*86400000).toISOString(),expireAt:Timestamp.fromMillis(expireAt)};
}
function makeObservation(source:MarketSource,userId:string,appId:string,revision:number,problemId:string):MarketObservation {
  return {id:documentKey(userId,appId,String(revision),problemId,source.id,source.contentHash,'fixture'),user_id:userId,app_id:appId,profileRevision:revision,
    sourceId:source.id,problemId,signalKind:'recurring_problem',quote:source.text.slice(0,50),explanation:'This expresses a concrete tracking difficulty.',
    prospectStatus:'potential_fit',prospectReason:'The need is unresolved and matches a confirmed capability.',matchedCapabilityIds:[],competitorName:null,
    sourceContentHash:source.contentHash,model:'fixture',promptVersion:'fixture',observedAt:new Date(now).toISOString(),needStatus:'unresolved',
    isProductBuilder:false,isSatisfied:false,expireAt:source.expireAt};
}
function makeProblem(userId:string,appId:string,problemId:string):MarketProblemRecord {
  return {id:problemId,user_id:userId,app_id:appId,title:'Tracking owned collectibles',summary:'People need a reliable list of what they own.',
    signalKind:'recurring_problem',groupKey:'owned-collectibles',createdAt:new Date(now-60_000).toISOString(),updatedAt:new Date(now-30_000).toISOString(),
    expireAt:Timestamp.fromMillis(now+29*86400000)};
}
async function addSnapshot(store:Store,userId:string,appId:string,revision:number,items:Array<{source:MarketSource;observation:MarketObservation}>,problem:MarketProblemRecord) {
  for(const {source,observation} of items) {await store.set('market_sources',source.id,source);await store.set('market_observations',observation.id,observation);}
  await store.set('market_problems',problem.id,problem);
  const problemDTO:MarketProblemDTO={id:problem.id,title:problem.title,summary:problem.summary,signalKind:problem.signalKind,peopleCount:0,conversationCount:0,
    observationCount:items.length,representativeEvidenceId:items[0]?.observation.id??null,lastObservedAt:new Date(now-60_000).toISOString()};
  const snapshotId=randomUUID();
  const snapshot:MarketSnapshot={id:snapshotId,user_id:userId,app_id:appId,profileRevision:revision,generatedAt:new Date(now-1_000).toISOString(),
    windowStart:new Date(now-30*86400000).toISOString(),windowEnd:new Date(now).toISOString(),coverage:'partial',sourceIds:items.map(item=>item.source.id),
    sourceContentHashes:Object.fromEntries(items.map(item=>[item.source.id,item.source.contentHash])),observationIds:items.map(item=>item.observation.id),
    problems:[problemDTO],expireAt:Timestamp.fromMillis(now+29*86400000)};
  await store.set('market_snapshots',snapshotId,snapshot);
  await store.set('market_snapshot_heads',documentKey(userId,appId,String(revision)),{user_id:userId,app_id:appId,profileRevision:revision,snapshotId,generatedAt:snapshot.generatedAt,expireAt:snapshot.expireAt});
  return snapshotId;
}
async function serve(t:{after:(fn:()=>Promise<void>)=>void},store:Store,userId:string,env=routeEnv(userId)) {
  const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).user={id:req.headers['x-test-user']};next();});
  app.use('/api',marketRouter(store,{env,now:()=>now}));
  app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({error:error.message,code:error.code}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address() as any;
  t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())));
  const call=(path:string,method='GET',body?:unknown,asUser=userId)=>fetch(`http://127.0.0.1:${address.port}/api${path}`,{
    method,headers:{'x-test-user':asUser,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {call};
}

test('Market overview and people pages share a fresh snapshot and count distinct authors and threads',async t=>{
  const store=testStore(),userId=`market-${randomUUID()}`,app=await addApp(store,userId),profile=makeProfile(userId,app.id),problem=makeProblem(userId,app.id,randomUUID());
  await store.set('lead_profiles',documentKey(userId,app.id),profile);
  const items=[
    makeSource({id:'reddit:post:threada',authorKey:'reddit:t2_authora',authorDisplayName:'collector',threadId:'threada'}),
    makeSource({id:'reddit:comment:commenta',authorKey:'reddit:name:collector',authorDisplayName:'collector',threadId:'threada',kind:'comment'}),
    makeSource({id:'reddit:post:threadb',authorKey:'reddit:t2_authorb',authorDisplayName:'builderb',threadId:'threadb'}),
    makeSource({id:'reddit:post:threadc',authorKey:'reddit:t2_authorc',authorDisplayName:'collectorc',threadId:'threadc'}),
    makeSource({id:'reddit:post:threadu',authorKey:null,authorDisplayName:null,threadId:'threadu'}),
    makeSource({id:'reddit:post:threadexpired',authorKey:'reddit:t2_expired',authorDisplayName:'expired',threadId:'threadexpired',createdAt:now-30*86400000-1}),
  ];
  const entries=items.map(source=>({source,observation:makeObservation(source,userId,app.id,profile.revision,problem.id)}));
  const snapshotId=await addSnapshot(store,userId,app.id,profile.revision,entries,problem),{call}=await serve(t,store,userId);
  const overviewResponse=await call(`/apps/${app.id}/market`);assert.equal(overviewResponse.status,200);
  const overview=await overviewResponse.json() as any;
  assert.equal(overview.snapshotId,snapshotId);assert.equal(overview.isSample,false);assert.equal(overview.sources[0].collectedCount,5);
  assert.equal(overview.problems[0].peopleCount,3,'the username-only row merges into its one stable author; unknown and expired authors do not count');
  assert.equal(overview.problems[0].conversationCount,4,'the post and comment share one thread; unknown authors still support conversation counts');
  assert(overview.evidence.every((row:any)=>row.isSample===false&&row.source.isSample===false));

  const first=await(await call(`/apps/${app.id}/market/people?limit=2`)).json() as any;
  assert.equal(first.snapshotId,snapshotId);assert.equal(first.people.length,2);assert.ok(first.nextCursor);
  const second=await(await call(`/apps/${app.id}/market/people?limit=2&snapshotId=${snapshotId}&cursor=${encodeURIComponent(first.nextCursor)}`)).json() as any;
  assert.equal(second.snapshotId,snapshotId);assert.equal(second.people.length,1);assert.equal(second.nextCursor,null);
  assert.equal(new Set([...first.people,...second.people].map((person:any)=>person.authorKey)).size,3);

  await store.set('market_problems',problem.id,{title:'Renamed in a later scan'},true);
  const sourceToChange=entries[2]!.source;
  const changedSource={...sourceToChange,authorKey:'reddit:t2_replacement',authorDisplayName:'replacement'};
  await store.set('market_sources',sourceToChange.id,{...changedSource,contentHash:marketSourceContentHash(changedSource)},true);
  const afterChange=await(await call(`/apps/${app.id}/market`)).json() as any;
  assert.equal(afterChange.snapshotId,snapshotId);assert.equal(afterChange.sources[0].collectedCount,4);
  assert.equal(afterChange.problems[0].peopleCount,2,'changed evidence is excluded before Firestore TTL cleanup');
  assert.equal(afterChange.problems[0].title,overview.problems[0].title,'an older page keeps wording from its own snapshot');
});

test('Market cursors are signed and scoped to account, app, revision, snapshot and problem filter',async t=>{
  const store=testStore(),userId=`market-cursor-${randomUUID()}`,app=await addApp(store,userId),profile=makeProfile(userId,app.id),problem=makeProblem(userId,app.id,randomUUID());
  await store.set('lead_profiles',documentKey(userId,app.id),profile);
  const items=['alice','bob','carol'].map((name,index)=>{
    const source=makeSource({id:`reddit:post:person${index}`,authorKey:`reddit:t2_${name}`,authorDisplayName:name,threadId:`thread${index}`});
    return {source,observation:makeObservation(source,userId,app.id,profile.revision,problem.id)};
  });
  const snapshotId=await addSnapshot(store,userId,app.id,profile.revision,items,problem),{call}=await serve(t,store,userId);
  const first=await(await call(`/apps/${app.id}/market/people?problemId=${problem.id}&limit=1`)).json() as any;
  assert.ok(first.nextCursor);
  const bad=await call(`/apps/${app.id}/market/people?problemId=${problem.id}&limit=1&cursor=${encodeURIComponent(first.nextCursor+'x')}`);
  assert.equal(bad.status,400);assert.equal((await bad.json() as any).code,'INVALID_CURSOR');
  const changedFilter=await call(`/apps/${app.id}/market/people?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`);
  assert.equal(changedFilter.status,400);
  const otherApp=await addApp(store,userId,'Another app');await store.set('lead_profiles',documentKey(userId,otherApp.id),makeProfile(userId,otherApp.id));
  const crossApp=await call(`/apps/${otherApp.id}/market/people?problemId=${problem.id}&limit=1&snapshotId=${snapshotId}&cursor=${encodeURIComponent(first.nextCursor)}`);
  assert.equal(crossApp.status,400);
  const otherUser=`market-cursor-other-${randomUUID()}`;
  const bothUsers=await serve(t,store,userId,{...routeEnv(userId),REDDIT_BETA_USER_IDS:`${userId},${otherUser}`});
  const crossUser=await bothUsers.call(`/apps/${app.id}/market/people?problemId=${problem.id}&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,'GET',undefined,otherUser);
  assert.equal(crossUser.status,404);
});

test('people pages retain the evidence that determines the person summary',async t=>{
  const store=testStore(),userId=`market-person-evidence-${randomUUID()}`,app=await addApp(store,userId),profile=makeProfile(userId,app.id),problem=makeProblem(userId,app.id,randomUUID());
  await store.set('lead_profiles',documentKey(userId,app.id),profile);
  const items=Array.from({length:11},(_,index)=>{
    const source=makeSource({id:`reddit:post:many${index}`,authorKey:'reddit:t2_singleauthor',authorDisplayName:'singleauthor',
      threadId:`manythread${index}`,createdAt:now-(index+1)*60_000});
    const base=makeObservation(source,userId,app.id,profile.revision,problem.id);
    const observation:MarketObservation={...base,prospectStatus:'not_a_prospect',prospectReason:'This previously reported need is now resolved.'};
    return {source,observation};
  });
  const oldest=items.at(-1)!;
  items[10]={...oldest,observation:{...oldest.observation,prospectStatus:'potential_fit',prospectReason:'This source describes the unresolved need.'}};
  await addSnapshot(store,userId,app.id,profile.revision,items,problem);
  const {call}=await serve(t,store,userId);
  const page=await(await call(`/apps/${app.id}/market/people`)).json() as any;
  assert.equal(page.people.length,1);
  assert.equal(page.people[0].prospectStatus,'potential_fit');
  assert.equal(page.people[0].prospectReason,'This source describes the unresolved need.');
  assert(page.people[0].evidence.some((row:any)=>row.id===oldest.observation.id));
});

test('Market endpoints enforce feature, ownership and confirmed profile; scan requests are revisioned and idempotent',async t=>{
  const store=testStore(),userId=`market-scan-${randomUUID()}`,app=await addApp(store,userId),profile=makeProfile(userId,app.id);
  await store.set('lead_profiles',documentKey(userId,app.id),profile);
  const {call}=await serve(t,store,userId);
  const scanInput={expectedRevision:profile.revision,idempotencyKey:randomUUID()};
  const first=await call(`/apps/${app.id}/market/scan`,'POST',scanInput);assert.equal(first.status,202);
  const firstBody=await first.json() as any;assert.equal(firstBody.scan.profileRevision,profile.revision);assert.equal(firstBody.scan.status,'queued');
  const replay=await call(`/apps/${app.id}/market/scan`,'POST',scanInput);assert.equal(replay.status,202);
  assert.equal((await replay.json() as any).scan.id,firstBody.scan.id);
  const status=await call(`/apps/${app.id}/market/scans/${firstBody.scan.id}`);assert.equal(status.status,200);
  assert.equal((await status.json() as any).id,firstBody.scan.id);
  assert.equal((await call(`/apps/${app.id}/market/scan`,'POST',{...scanInput,expectedRevision:profile.revision+1})).status,409);
  const foreign=await addApp(store,`market-foreign-${randomUUID()}`);
  assert.equal((await call(`/apps/${foreign.id}/market`)).status,404);
  const unconfirmed=await addApp(store,userId,'No profile');
  const missing=await call(`/apps/${unconfirmed.id}/market`);assert.equal(missing.status,409);assert.equal((await missing.json() as any).code,'MISSING_PROFILE');
  const disabled=await serve(t,store,userId,{...routeEnv(userId),MARKET_ENABLED:'false'});
  const unavailable=await disabled.call(`/apps/${app.id}/market`);assert.equal(unavailable.status,403);assert.equal((await unavailable.json() as any).code,'FEATURE_UNAVAILABLE');
});

test('web research remains owner-scoped and exposes citations without inventing people or quotes',async t=>{
  const store=testStore(),userId=`market-research-${randomUUID()}`,app=await addApp(store,userId),profile=makeProfile(userId,app.id),problem=makeProblem(userId,app.id,randomUUID());
  await store.set('lead_profiles',documentKey(userId,app.id),profile);
  const snapshotId=await addSnapshot(store,userId,app.id,profile.revision,[],problem);
  const research={findings:[{title:'Maintaining collection lists',summary:'Public discussions suggest that keeping lists current can be difficult.',sources:[{title:'Collector discussion',url:'https://forum.example.com/thread'}]}]};
  await store.set('market_snapshots',snapshotId,{research},true);
  const {call}=await serve(t,store,userId);
  const result=await (await call(`/apps/${app.id}/market`)).json() as any;
  assert.deepEqual(result.research,research);assert.equal(result.problems[0].peopleCount,0);assert.equal(result.problems[0].conversationCount,0);assert.deepEqual(result.evidence,[]);
  assert.deepEqual(result.sources,[{provider:'web',collectedCount:1}]);
  const expanded={...research,landscape:[{title:'An existing alternative',summary:'Official listing describes collection tracking.',sources:[{title:'Vendor listing',url:'https://vendor.example/app'}]}],peopleCoverage:'One thread inspected.'};
  await store.set('market_snapshots',snapshotId,{research:expanded},true);
  const updated=await (await call(`/apps/${app.id}/market`)).json() as any;
  assert.deepEqual(updated.research,expanded);assert.deepEqual(updated.problems,result.problems);
  assert.deepEqual(updated.sources,[{provider:'web',collectedCount:2}]);
  const other=await call(`/apps/${app.id}/market`,'GET',undefined,'other-account');assert.notEqual(other.status,200);
});

test('verified research prospects appear in owner-scoped People, with stable IDs, filters and cursors',async t=>{
 const store=testStore(),userId=`market-web-people-${randomUUID()}`,app=await addApp(store,userId),profile=makeProfile(userId,app.id),problem=makeProblem(userId,app.id,randomUUID());
 await store.set('lead_profiles',documentKey(userId,app.id),profile);
 const snapshotId=await addSnapshot(store,userId,app.id,profile.revision,[],problem);
 const url='https://www.youtube.com/watch?v=abcdefghijk';
 const prospects=['a','b'].map(letter=>({id:letter.repeat(40),provider:'youtube',publicHandle:'@Creator'+letter,displayName:'Creator '+letter,profileUrl:'https://www.youtube.com/@Creator'+letter,
 relationship:'creator_partner',status:'needs_review',problem:'Keeping collection records',fitReason:'Discusses collection inventory workflows',matchedCapabilityIds:[profile.capabilities[0]!.id],
 evidence:[{url,title:'How I track my collection',excerpt:'track my collection',publishedAt:null,verifiedAt:new Date(now).toISOString(),verification:'video_metadata'}]}));
 const research={findings:[{title:'Collection inventory workflows',summary:'Creators discuss keeping a reliable inventory.',sources:[{title:'Inventory video',url}]}],prospects};
 await store.set('market_snapshots',snapshotId,{research},true);
 const {call}=await serve(t,store,userId);
 const overview=await(await call(`/apps/${app.id}/market`)).json() as any;assert.equal(overview.problems[0].peopleCount,2);
 const path=`/apps/${app.id}/market/people?problemId=${overview.problems[0].id}&limit=1`;
 const page=await(await call(path)).json() as any;assert.equal(page.people.length,1);assert.equal(page.people[0].researchProspect.relationship,'creator_partner');assert.equal(page.people[0].prospectStatus,'needs_review');assert.ok(page.nextCursor);
 const next=await(await call(path+'&cursor='+encodeURIComponent(page.nextCursor))).json() as any;assert.equal(next.people.length,1);assert.notEqual(next.people[0].id,page.people[0].id);assert.equal(next.nextCursor,null);
 const all=await(await call(`/apps/${app.id}/market/people`)).json() as any;assert.equal(all.people[0].id,page.people[0].id);
 assert.notEqual((await call(`/apps/${app.id}/market/people`,'GET',undefined,'different-owner')).status,200);
 await store.set('market_snapshots',snapshotId,{expireAt:Timestamp.fromMillis(now-1)},true);
 assert.equal((await call(`/apps/${app.id}/market/people?snapshotId=${snapshotId}`)).status,409);
});
