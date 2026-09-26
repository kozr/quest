import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Timestamp} from 'firebase-admin/firestore';
import {testStore} from './firebase-fixture.js';
import {documentKey,type AppRow} from '../src/database.js';
import {queueLeadReply,processLeadReplyJob} from '../src/leads-jobs.js';
import type {LeadAIProvider,LeadJob,LeadProfile} from '../src/leads-types.js';
import {replyFixture} from './lead-reply-fixture.js';
import express from 'express';
import {once} from 'node:events';
import {leadsRouter} from '../src/leads.js';
import {leadContentHash} from '../src/leads-candidates.js';

async function fixture() {
  const store=testStore(),userId=randomUUID(),appId=randomUUID(),now=Date.now();
  const env={LEADS_ENABLED:'true',LEADS_AI_ENABLED:'true',REDDIT_MONITORING_ENABLED:'true',REDDIT_PUBLIC_ACCESS:'true',
    LEADS_MODEL_ID:'gpt-6-luna',LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION:'1',LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION:'4',OPENAI_API_KEY:'fixture-secret'};
  const app:AppRow={id:appId,user_id:userId,name:'Figure Shelf',bundle_id:'test.figures',apple_id:'123',source:'apple',icon_url:null,
    webhook_secret:randomUUID(),created_at:new Date(now).toISOString(),last_production_at:null,last_sandbox_at:null,active:true};
  const profile:LeadProfile={user_id:userId,app_id:appId,schemaVersion:1,revision:1,enabled:true,problems:[{id:'p',text:'Track figures'}],
    capabilities:[{id:'c',text:'Track owned figures',source:'user_confirmed'}],communities:['actionfigures'],keywords:[],descriptionSource:null,
    confirmedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()};
  await store.set('apps',appId,app);await store.set('lead_profiles',documentKey(userId,appId),profile);
  await store.set('reddit_posts','abc123',{id:'abc123',subreddit:'actionfigures',title:'How do I track my figures?',body:'I keep buying duplicates.',
    url:'https://www.reddit.com/r/actionfigures/comments/abc123/',createdAt:new Date(now-60000).toISOString(),expireAt:Timestamp.fromMillis(now+86400000)});
  return {store,userId,appId,env,now,profile};
}
test('concurrent reply opens share a job and cached result with one settled AI charge',async()=>{
  const f=await fixture();
  const queued=await Promise.all(Array.from({length:5},()=>queueLeadReply(f.store,f.userId,f.appId,'abc123',1,f.env,f.now)));
  assert.equal(new Set(queued.map(j=>j.id)).size,1);
  let calls=0;
  const provider={draftReplies:async()=>{calls++;return {value:replyFixture,model:'gpt-6-luna',usage:{inputTokens:100,outputTokens:220}};}} as LeadAIProvider;
  await processLeadReplyJob(f.store,queued[0].id,provider,f.env,f.now);
  await processLeadReplyJob(f.store,queued[0].id,provider,f.env,f.now+1);
  const cached=await queueLeadReply(f.store,f.userId,f.appId,'abc123',1,f.env,f.now+2);
  assert.equal(calls,1);assert.equal(cached.state,'succeeded');assert.deepEqual(cached.replyPlan,replyFixture);
  const budget=await f.store.get<any>('lead_ai_budgets',new Date(f.now).toISOString().slice(0,7));
  assert.equal(budget.reservedMicroUsd,0);assert.equal(budget.spentMicroUsd,980);
  await assert.rejects(queueLeadReply(f.store,'foreign',f.appId,'abc123',1,f.env),/STALE/);
  await assert.rejects(queueLeadReply(f.store,f.userId,f.appId,'abc123',2,f.env),/STALE/);
});
test('a changed profile fences a late reply result and provider uncertainty does not replay',async()=>{
  const f=await fixture(),job=await queueLeadReply(f.store,f.userId,f.appId,'abc123',1,f.env);
  const provider={draftReplies:async()=>{
    await f.store.set('lead_profiles',documentKey(f.userId,f.appId),{...f.profile,revision:2});
    return {value:replyFixture,model:'gpt-6-luna',usage:{inputTokens:100,outputTokens:220}};
  }} as LeadAIProvider;
  await processLeadReplyJob(f.store,job.id,provider,f.env);
  const late=await f.store.get<LeadJob>('lead_jobs',job.id);
  assert.equal(late?.state,'cancelled');assert.equal(late?.replyPlan,undefined);
  const second=await queueLeadReply(f.store,f.userId,f.appId,'abc123',2,f.env);let calls=0;
  const failing={draftReplies:async()=>{calls++;throw new Error('Ambiguous network failure');}} as unknown as LeadAIProvider;
  await processLeadReplyJob(f.store,second.id,failing,f.env);
  await processLeadReplyJob(f.store,second.id,failing,f.env);
  assert.equal(calls,1);assert.equal((await f.store.get<LeadJob>('lead_jobs',second.id))?.state,'uncertain');
});

test('reply endpoints require a current qualified lead and never expose another account’s drafts',async()=>{
  const f=await fixture(),prior={...process.env};Object.assign(process.env,f.env);
  const job=await queueLeadReply(f.store,f.userId,f.appId,'abc123',1,f.env);
  await processLeadReplyJob(f.store,job.id,{draftReplies:async()=>({value:replyFixture,model:'gpt-6-luna',usage:{inputTokens:100,outputTokens:220}})} as LeadAIProvider,f.env);
  const post=await f.store.get<any>('reddit_posts','abc123');
  await f.store.set('lead_assessments','assessment',{user_id:f.userId,app_id:f.appId,profileRevision:1,postId:'abc123',decision:'qualified',
    postContentHash:leadContentHash(post),expireAt:Timestamp.fromMillis(Date.now()+86400000)});
  const api=express();api.use(express.json());
  api.use((req,_res,next)=>{(req as any).user={id:req.headers['x-fixture-user']??f.userId};next();});
  api.use(leadsRouter(f.store));api.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??500).json({error:error.message}));
  const server=api.listen(0,'127.0.0.1');await once(server,'listening');
  const origin=`http://127.0.0.1:${(server.address() as any).port}`,path=`/apps/${f.appId}/leads/abc123/replies`;
  try {
    const get=await fetch(origin+path+'/'+job.id);assert.equal(get.status,200);assert.deepEqual((await get.json()).plan,replyFixture);
    const cached=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:1})});
    assert.equal(cached.status,200);assert.equal((await cached.json()).jobId,job.id);
    const foreign=await fetch(origin+path+'/'+job.id,{headers:{'x-fixture-user':'other-account'}});assert.equal(foreign.status,404);
    await f.store.delete('lead_assessments','assessment');
    assert.equal((await fetch(origin+path+'/'+job.id)).status,404);
    assert.equal((await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:1})})).status,404);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    for(const key of Object.keys(f.env)) if(prior[key]===undefined) delete process.env[key];else process.env[key]=prior[key];
  }
});
