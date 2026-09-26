import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Timestamp} from 'firebase-admin/firestore';
import {testStore} from './firebase-fixture.js';
import {documentKey,type AppRow} from '../src/database.js';
import {normalizeRedditPost} from '../src/reddit-apify.js';
import {enqueueLeadCandidates,leadContentHash} from '../src/leads-candidates.js';
import {processLeadQualificationJob,queueLeadReply,processLeadReplyJob} from '../src/leads-jobs.js';
import {leadAISettings,maximumCostMicroUsd} from '../src/leads-ai.js';
import {IMAGE_INPUT_TOKEN_ALLOWANCE} from '../src/reddit-images.js';
import {MAX_OUTPUT_TOKENS,type LeadAIProvider,type LeadJob,type LeadProfile,type LeadQualification} from '../src/leads-types.js';
import {MAX_REPLY_OUTPUT} from '../src/lead-replies.js';
import {replyFixture} from './lead-reply-fixture.js';

async function fixture() {
  const store=testStore(),now=Date.now(),userId=randomUUID(),appId=randomUUID();
  const env={LEADS_ENABLED:'true',LEADS_AI_ENABLED:'true',REDDIT_MONITORING_ENABLED:'true',REDDIT_PUBLIC_ACCESS:'true',
    LEADS_MODEL_ID:'gpt-6-luna',LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION:'.125',LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION:'.5',OPENAI_API_KEY:'fixture-only-secret'};
  const app:AppRow={id:appId,user_id:userId,name:'Blind Box Tracker',bundle_id:'test.figures',apple_id:'123',source:'apple',icon_url:null,
    webhook_secret:randomUUID(),created_at:new Date(now).toISOString(),last_production_at:null,last_sandbox_at:null,active:true};
  const profile:LeadProfile={user_id:userId,app_id:appId,schemaVersion:1,revision:1,enabled:true,problems:[],
    capabilities:[{id:'a9fbf79f-95a4-4e7f-96d8-22bb8ef01954',text:'Track owned figures, duplicates and wishlists',source:'user_confirmed'}],
    communities:['smiskis'],keywords:[],descriptionSource:null,confirmedAt:app.created_at,updatedAt:app.created_at};
  const normalized=normalizeRedditPost({dataType:'post',id:'image123',subredditName:'smiskis',title:'Help?',body:'',
    createdAt:new Date(now-60000).toISOString(),postType:'gallery',galleryImages:['https://i.redd.it/first.png','https://i.redd.it/second.jpg','https://i.redd.it/third.png']});
  assert.ok(normalized);
  const post={...normalized,expireAt:Timestamp.fromMillis(now+86400000)};
  await store.set('apps',appId,app);await store.set('lead_profiles',documentKey(userId,appId),profile);await store.set('reddit_posts',post.id,post);
  assert.equal(await enqueueLeadCandidates(store,userId,appId,profile,{now}),1);
  const job=(await store.list<LeadJob>('lead_jobs'))[0];
  const qualification:LeadQualification={decision:'qualified',explicitIntent:true,intentQuote:'',fitEvidenceQuotes:[],
    capabilityIds:[profile.capabilities[0].id],whyItFits:'Keep owned figures and duplicate counts together.',
    imageEvidence:[{imageIndex:2,observation:'The screenshot asks for a simpler way to track owned figures and duplicate pulls.'}]};
  const promptBytes=Buffer.byteLength(JSON.stringify({post:{title:post.title,body:post.body.slice(0,4000)},profile:{problems:profile.problems,capabilities:profile.capabilities}}))+18000;
  const textReservation=maximumCostMicroUsd(promptBytes,leadAISettings(env),MAX_OUTPUT_TOKENS);
  return {store,now,userId,appId,env,profile,post,job,qualification,promptBytes,textReservation};
}

test('OP images survive collection and qualification, settle actual usage, and do not repeat on worker retry',async()=>{
  const f=await fixture();let calls=0,reserved=0;
  const provider={qualifyPost:async(post)=>{
    calls++;assert.deepEqual(post.images,f.post.images);assert.equal(post.images?.length,2);
    const budget=await f.store.get<any>('lead_ai_budgets',new Date(f.now).toISOString().slice(0,7));reserved=budget.reservedMicroUsd;
    return {model:'gpt-6-luna',usage:{inputTokens:3000,outputTokens:100},value:f.qualification};
  }} as LeadAIProvider;
  await processLeadQualificationJob(f.store,f.job.id,provider,f.env,f.now);
  assert.equal(reserved,f.textReservation+2*IMAGE_INPUT_TOKEN_ALLOWANCE*.125);
  const assessments=await f.store.list<any>('lead_assessments');assert.equal(assessments.length,1);
  assert.equal(assessments[0].decision,'qualified');assert.deepEqual(assessments[0].imageEvidence,f.qualification.imageEvidence);
  assert.deepEqual(assessments[0].sourceEvidenceQuotes,[]);assert.equal(assessments[0].postContentHash,leadContentHash(f.post));
  const budget=await f.store.get<any>('lead_ai_budgets',new Date(f.now).toISOString().slice(0,7));
  assert.equal(budget.reservedMicroUsd,0);assert.equal(budget.spentMicroUsd,425);
  await processLeadQualificationJob(f.store,f.job.id,provider,f.env,f.now+1);assert.equal(calls,1);
});

test('changed OP images fence late visual evidence while accounting for the completed model call',async()=>{
  const f=await fixture();
  const provider={qualifyPost:async()=>{
    await f.store.set('reddit_posts',f.post.id,{...f.post,images:['https://i.redd.it/changed.png']});
    return {model:'gpt-6-luna',usage:{inputTokens:3000,outputTokens:100},value:f.qualification};
  }} as LeadAIProvider;
  await processLeadQualificationJob(f.store,f.job.id,provider,f.env,f.now);
  assert.equal((await f.store.get<LeadJob>('lead_jobs',f.job.id))?.state,'cancelled');
  assert.equal((await f.store.list('lead_assessments')).length,0);
  const budget=await f.store.get<any>('lead_ai_budgets',new Date(f.now).toISOString().slice(0,7));
  assert.equal(budget.reservedMicroUsd,0);assert.equal(budget.spentMicroUsd,425);
});

test('image allowance can pause a qualification before any provider charge',async()=>{
  const f=await fixture();let calls=0;
  const provider={qualifyPost:async()=>{calls++;throw new Error('Must not be called');}} as unknown as LeadAIProvider;
  const env={...f.env,LEADS_AI_ACCOUNT_CAP_USD:String((f.textReservation+1)/1_000_000)};
  await processLeadQualificationJob(f.store,f.job.id,provider,env,f.now);
  assert.equal(calls,0);const job=await f.store.get<LeadJob>('lead_jobs',f.job.id);
  assert.equal(job?.state,'pending');assert.equal(job?.reasonCode,'BUDGET_PAUSED');
  assert.equal((await f.store.list('lead_ai_reservations')).length,0);
});

test('reply jobs on image posts pass only text and reserve no image tokens',async()=>{
  const f=await fixture(),job=await queueLeadReply(f.store,f.userId,f.appId,f.post.id,1,f.env,f.now);let calls=0;
  const provider={draftReplies:async(post)=>{
    calls++;assert.deepEqual(post,{title:f.post.title,body:f.post.body,subreddit:f.post.subreddit});assert.equal('images' in post,false);
    const budget=await f.store.get<any>('lead_ai_budgets',new Date(f.now).toISOString().slice(0,7));
    assert.equal(budget.reservedMicroUsd,maximumCostMicroUsd(f.promptBytes,leadAISettings(f.env),MAX_REPLY_OUTPUT));
    return {model:'gpt-6-luna',usage:{inputTokens:100,outputTokens:220},value:replyFixture};
  }} as LeadAIProvider;
  await processLeadReplyJob(f.store,job.id,provider,f.env,f.now);
  assert.equal(calls,1);assert.equal((await f.store.get<LeadJob>('lead_jobs',job.id))?.state,'succeeded');
});
