import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Timestamp} from 'firebase-admin/firestore';
import {OpenAIResponsesLeadAIProvider} from '../src/leads-ai.js';
import {testStore} from './firebase-fixture.js';
import {documentKey,type AppRow,type DeviceRow,type Job} from '../src/database.js';
import {queueInitialLeadScan,type InitialLeadScan} from '../src/leads-initial-scan.js';
import {enqueueHistoricalCandidates,leadContentHash,createQualificationAssessment} from '../src/leads-candidates.js';
import {processLeadQualificationJob,queueLeadDiscovery,processLeadDiscoveryJob} from '../src/leads-jobs.js';
import {claimLeadSlot,releaseLeadSlot} from '../src/leads-worker-slots.js';
import {readLeadProgress} from '../src/leads-progress.js';
import {queueLeadReadyNotification,leadReadyPayload} from '../src/leads-notifications.js';
import type {LeadAIProvider,LeadProfile,LeadJob,LeadDiscoveryContext} from '../src/leads-types.js';

const now=Date.now(),expiry=Timestamp.fromMillis(now+86400000);
const env={LEADS_ENABLED:'true',LEADS_AI_ENABLED:'true',REDDIT_MONITORING_ENABLED:'true',REDDIT_PUBLIC_ACCESS:'true',
  LEADS_MODEL_ID:'gpt-6-sol',OPENAI_API_KEY:'fixture',LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION:'2',LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION:'10',
  LEADS_AI_ACCOUNT_CAP_USD:'4',LEADS_AI_GLOBAL_CAP_USD:'5'};
const rejected={decision:'rejected' as const,explicitIntent:false,intentQuote:'',capabilityIds:[],fitEvidenceQuotes:[],whyItFits:''};
const profile:LeadProfile={user_id:'owner',app_id:'app',schemaVersion:1,revision:1,enabled:true,
  communities:['journaling'],keywords:[],problems:[{id:randomUUID(),text:'Keep notes together'}],
  capabilities:[{id:randomUUID(),text:'Organize daily journal entries',source:'user_confirmed'}],descriptionSource:null,
  confirmedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
const source=(id:string)=>({id,subreddit:'journaling',title:'How do I keep my journal entries together?',body:'My notes are scattered.',
  createdAt:'2024-01-01T00:00:00.000Z',url:`https://www.reddit.com/r/journaling/comments/${id}/`,score:0,comments:0,expireAt:expiry});

test('quick and background discovery share the model and evaluator, while only discovery breadth changes',async()=>{
  const requests:any[]=[];
  const fetcher=(async(_url:unknown,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));requests.push(body);
    const search=body.tools!==undefined;
    return new Response(JSON.stringify({model:'gpt-6-sol',usage:{input_tokens:30,output_tokens:20},
      output_text:JSON.stringify(search?{urls:[source('one').url]}:rejected),
      output:search?[{type:'web_search_call',action:{type:'search',sources:[{url:source('one').url}]}}]:[]}));
  }) as typeof fetch;
  const ai=new OpenAIResponsesLeadAIProvider('fixture','gpt-6-sol',fetcher);
  const context:LeadDiscoveryContext={round:0,totalRounds:3,phase:'quick',excludeURLs:[],previousQueries:[]};
  await ai.discoverThreads(profile,'Journal',context);await ai.qualifyPost(source('one'),profile);
  await ai.discoverThreads(profile,'Journal',{...context,round:1,phase:'background'});await ai.qualifyPost(source('one'),profile);
  assert.equal(requests[0].max_tool_calls,2);assert.equal(requests[2].max_tool_calls,6);
  assert.equal(requests[0].text.format.schema.properties.urls.maxItems,5);
  assert.equal(requests[2].text.format.schema.properties.urls.maxItems,20);
  assert.match(requests[0].input[0].content,/one or two short/);assert.doesNotMatch(requests[0].input[0].content,/at least four/);
  assert.deepEqual(requests[1],requests[3]);
  for(const request of requests) {assert.equal(request.model,'gpt-6-sol');assert.deepEqual(request.reasoning,{effort:'medium'});}
});

test('quick discovery rejects an oversized batch rather than silently weakening its limit',async()=>{
  const urls=Array.from({length:6},(_,i)=>source(`p${i}`).url);
  const fetcher=(async()=>new Response(JSON.stringify({model:'gpt-6-sol',usage:{input_tokens:30,output_tokens:20},output_text:JSON.stringify({urls}),
    output:[{type:'web_search_call',action:{type:'search',sources:urls.map(url=>({url}))}}]}))) as typeof fetch;
  const ai=new OpenAIResponsesLeadAIProvider('fixture','gpt-6-sol',fetcher);
  await assert.rejects(ai.discoverThreads(profile,'Journal',{round:0,totalRounds:3,phase:'quick',excludeURLs:[],previousQueries:[]}));
});

async function fixture() {
  const store=testStore(),userId=randomUUID(),appId=randomUUID(),p={...profile,user_id:userId,app_id:appId};
  const app:AppRow={id:appId,user_id:userId,name:'Journal',bundle_id:'test.journal',apple_id:'123',source:'apple',icon_url:null,
    webhook_secret:randomUUID(),created_at:new Date(now).toISOString(),last_production_at:null,last_sandbox_at:null,active:true};
  await store.set('apps',appId,app);await store.set('lead_profiles',documentKey(userId,appId),p);
  const {scan}=await queueInitialLeadScan(store,userId,appId,1,now,env);
  return {store,userId,appId,profile:p,scan};
}

test('three post reviews run together; discovery is independent; duplicate delivery never repeats a paid review',async()=>{
  const f=await fixture();
  for(const id of ['a','b','c','d']) await f.store.set('reddit_posts',id,source(id));
  await enqueueHistoricalCandidates(f.store,f.profile,['a','b','c','d'],now);
  const jobs=await f.store.list<LeadJob>('lead_jobs');
  let release!:()=>void,allEntered!:()=>void,calls=0;
  const held=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{allEntered=r;});
  const ai={qualifyPost:async()=>{if(++calls===3)allEntered();await held;return {model:'gpt-6-sol',usage:{inputTokens:30,outputTokens:20},value:rejected};},
    discoverThreads:async()=>({model:'gpt-6-sol',usage:{inputTokens:30,outputTokens:20,searchCalls:1},value:{urls:[]}})} as unknown as LeadAIProvider;
  const running=jobs.slice(0,3).map(job=>processLeadQualificationJob(f.store,job.id,ai,env,now));
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    await Promise.race([entered,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Reviews were serialized.')),10_000);})]);
    assert.equal((await processLeadQualificationJob(f.store,jobs[3].id,ai,env,now)).reasonCode,'WORKER_BUSY');
    const search=await queueLeadDiscovery(f.store,f.scan.id,f.profile,now,{round:0,totalRounds:3,phase:'quick',excludeURLs:[],previousQueries:[]});
    assert.equal((await processLeadDiscoveryJob(f.store,search,ai,env,now)).processed,1);
  } finally {if(timer)clearTimeout(timer);release();await Promise.all(running);}
  await processLeadQualificationJob(f.store,jobs[0].id,ai,env,now);assert.equal(calls,3);
  await processLeadQualificationJob(f.store,jobs[3].id,ai,env,now);assert.equal(calls,4);
  assert.equal((await f.store.list<any>('lead_ai_budgets')).every(b=>b.reservedMicroUsd===0),true);
  assert.equal((await f.store.list<any>('lead_daily_usage'))[0].qualify,4);
});

test('expired worker slots can be reclaimed and a stale release cannot unlock a new owner',async()=>{
  const {store}=await fixture(),first=await claimLeadSlot(store,'discover',now);assert.ok(first);
  assert.equal(await claimLeadSlot(store,'discover',now),undefined);
  const next=await claimLeadSlot(store,'discover',now+211000);assert.ok(next);
  await releaseLeadSlot(store,first);
  assert.equal(await claimLeadSlot(store,'discover',now+211000),undefined);
  await releaseLeadSlot(store,next);assert.ok(await claimLeadSlot(store,'discover',now+211000));
});

test('30 seconds changes presentation without cancelling or restarting the search',async()=>{
  const f=await fixture();
  assert.equal((await readLeadProgress(f.store,f.profile,undefined,false,now+29999)).background,false);
  assert.equal((await readLeadProgress(f.store,f.profile,undefined,false,now+30000)).background,true);
  const persisted=await f.store.get<InitialLeadScan>('lead_scans',f.scan.id);assert.equal(persisted?.state,'queued');
  assert.equal((await queueInitialLeadScan(f.store,f.userId,f.appId,1,now+31000,env)).started,false);
  await f.store.set('lead_scans',f.scan.id,{searchRound:1},true);
  assert.equal((await readLeadProgress(f.store,f.profile,undefined,false,now+1000)).background,true);
});

test('a verified match queues one alert per post and delivery rechecks edits, dismissals and ownership',async()=>{
  const f=await fixture(),post=source('one');await f.store.set('reddit_posts',post.id,post);
  const device:DeviceRow={id:randomUUID(),user_id:f.userId,session_hash:'session',token:'fixture',name:'Phone',environment:'sandbox',
    created_at:new Date(now).toISOString(),last_seen_at:new Date(now).toISOString(),active:1,generation:1};
  await f.store.set('devices',device.id,device);
  const assessment=createQualificationAssessment({userId:f.userId,appId:f.appId,profile:f.profile,post,contentHash:leadContentHash(post),model:'gpt-6-sol',historical:true,now,
    result:{decision:'qualified',explicitIntent:true,intentQuote:post.title,capabilityIds:[f.profile.capabilities[0].id],sourceEvidenceQuotes:[post.title],whyItFits:'Keep scattered journal entries together.'}});
  await f.store.set('lead_assessments','assessment',assessment);
  await Promise.all(Array.from({length:4},()=>queueLeadReadyNotification(f.store,'assessment',now+10000)));
  const jobs=await f.store.list<Job>('delivery_jobs');assert.equal(jobs.length,1);assert.equal(jobs[0].kind,'lead');
  const scan=await f.store.get<InitialLeadScan>('lead_scans',f.scan.id);assert.equal(scan?.firstMatchAt,now+10000);
  const next=source('two');await f.store.set('reddit_posts',next.id,next);
  await f.store.set('lead_assessments','second',{...assessment,postId:next.id,postContentHash:leadContentHash(next)});
  await queueLeadReadyNotification(f.store,'second',now+10500);
  assert.equal((await f.store.list<Job>('delivery_jobs')).length,2,'Later setup matches also send alerts.');
  assert.equal((await f.store.get<InitialLeadScan>('lead_scans',f.scan.id))?.notificationQueuedAt,now+10000);
  assert.equal((await leadReadyPayload(f.store,jobs[0],now+11000))?.kind,'lead');
  assert.equal(await leadReadyPayload(f.store,{...jobs[0],user_id:'other'},now+11000),null);
  await f.store.set('reddit_posts',post.id,{...post,body:'Edited question'});
  assert.equal(await leadReadyPayload(f.store,jobs[0],now+11000),null);
  await f.store.set('reddit_posts',post.id,post);
  await f.store.set('lead_dismissals',documentKey(f.userId,f.appId,post.id),{expireAt:expiry});
  assert.equal(await leadReadyPayload(f.store,jobs[0],now+11000),null);
});
