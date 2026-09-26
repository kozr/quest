import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import express from 'express';
import {Timestamp} from 'firebase-admin/firestore';
import {testStore,firebaseOptions} from './firebase-fixture.js';
import {appleCredential} from './apple-auth-fixture.js';
import {createApplication} from '../src/app.js';
import {documentKey,type Store,type AppRow} from '../src/database.js';
import {onboardingRouter,readOnboarding,hasQuestAccess,QUEST_TRIAL_MS,requireQuestAccess} from '../src/onboarding.js';
import {leadsRouter} from '../src/leads.js';
import {publicAIConfigFingerprint} from '../src/lead-access.js';
import {leadContentHash} from '../src/leads-candidates.js';
import type {LeadProfile,LeadAssessment} from '../src/leads-types.js';
import type {StoredRedditPost} from '../src/reddit.js';

test('trial access expires exactly at its deadline; existing beta access remains intact',()=>{
  assert.equal(hasQuestAccess(undefined),true);
  assert.equal(hasQuestAccess({stage:'complete',legacy:true}),true);
  assert.equal(hasQuestAccess({stage:'first'},100),false);
  assert.equal(hasQuestAccess({stage:'complete',trialEndsAt:101},100),true);
  assert.equal(hasQuestAccess({stage:'complete',trialEndsAt:100},100),false);
});

async function fixture(store:Store,userId:string) {
  const app:AppRow={id:randomUUID(),user_id:userId,name:'Orbit Journal',bundle_id:`test.${randomUUID()}`,apple_id:'123456789',source:'apple',icon_url:null,
    webhook_secret:randomUUID(),created_at:new Date().toISOString(),last_production_at:null,last_sandbox_at:null,active:true};
  await store.set('apps',app.id,app);
  const profile:LeadProfile={user_id:userId,app_id:app.id,schemaVersion:1,revision:1,enabled:true,
    problems:[{id:randomUUID(),text:'Remember daily events'}],capabilities:[{id:randomUUID(),text:'Write and revisit entries',source:'user_confirmed'}],
    communities:['journaling'],keywords:[],descriptionSource:null,confirmedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await store.set('lead_profiles',documentKey(userId,app.id),profile);
  const addPost=async(id:string,createdAt=new Date().toISOString())=>{
    const post:StoredRedditPost={id,subreddit:'journaling',title:`PRIVATE TITLE ${id}`,body:`PRIVATE BODY ${id}`,url:`https://www.reddit.com/r/journaling/comments/${id}/`,
      createdAt,score:1,comments:1,expireAt:Timestamp.fromMillis(Date.now()+86400000)};
    const assessment:LeadAssessment={user_id:userId,app_id:app.id,profileRevision:1,postId:id,postContentHash:leadContentHash(post),postCreatedAt:createdAt,
      decision:'qualified',explicitIntent:true,intentQuote:post.title,capabilityIds:[profile.capabilities[0].id],sourceEvidenceQuotes:[post.title],whyItFits:'Write and revisit daily entries.',
      modelVersion:'fixture',promptVersion:'fixture',assessedAt:new Date().toISOString(),expireAt:post.expireAt};
    await store.set('reddit_posts',id,post);
    await store.set('lead_assessments',documentKey(userId,app.id,id),assessment);
  };
  return {app,addPost};
}

test('onboarding API resumes, protects the free quest, and starts a trial once across devices',async t=>{
  const store=testStore(),userId=randomUUID(),other=randomUUID();
  await store.set('users',userId,{id:userId,email:'fixture@example.test'});
  const settings={LEADS_ENABLED:'true',LEADS_AI_ENABLED:'true',LEADS_MODEL_ID:'gpt-6-luna',
    LEADS_INPUT_PRICE_CEILING_USD_PER_MILLION:'1',LEADS_OUTPUT_PRICE_CEILING_USD_PER_MILLION:'4',OPENAI_API_KEY:'fixture-only',
    REDDIT_MONITORING_ENABLED:'true',REDDIT_BETA_USER_IDS:[userId,other].join(',')};
  const prior=Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));
  Object.assign(process.env,settings);
  t.after(()=>{for(const [key,value] of Object.entries(prior)) {if(value===undefined) delete process.env[key];else process.env[key]=value;}});
  await store.set('lead_control','provider',{ready:true,configFingerprint:publicAIConfigFingerprint(),checkedAt:Date.now()});
  const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).user={id:req.headers['x-test-user']};next();});
  app.use('/api',onboardingRouter(store));app.use('/api',leadsRouter(store));
  app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??400).json({error:error.message,code:error.code}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const port=(server.address() as {port:number}).port;
  const call=async(path:string,method='GET',body?:object,owner=userId)=>{
    const result=await fetch(`http://127.0.0.1:${port}/api${path}`,{method,headers:{'x-test-user':owner,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
    return {status:result.status,body:await result.json() as any};
  };
  assert.equal((await call('/onboarding/bootstrap','POST',{})).body.stage,'app');
  const {app:connected,addPost}=await fixture(store,userId);
  assert.equal((await call('/onboarding','PUT',{stage:'quest',appId:connected.id})).status,200);
  assert.equal((await call('/onboarding/bootstrap','POST',{})).body.appId,connected.id,'resume keeps selected app');
  await call('/onboarding/bootstrap','POST',{},other);
  assert.equal((await call('/onboarding','PUT',{stage:'quest',appId:connected.id},other)).status,404,'cannot select another account’s app');
  await addPost('one',new Date(Date.now()-60000).toISOString());
  await addPost('two',new Date(Date.now()-120000).toISOString());
  const initial=await call(`/apps/${connected.id}/leads`);
  assert.equal(initial.status,200);assert.equal(initial.body.leads.length,1);assert.equal(initial.body.leads[0].postId,'one');
  assert.equal(initial.body.locked.count,1);assert.deepEqual(Object.keys(initial.body.locked.previews[0]).sort(),['community','id']);
  assert.equal(JSON.stringify(initial.body).includes('PRIVATE TITLE two'),false);
  assert.equal(JSON.stringify(initial.body).includes('PRIVATE BODY two'),false);
  await requireQuestAccess(store,userId,connected.id,'one');
  await assert.rejects(requireQuestAccess(store,userId,connected.id,'two'),(error:any)=>error.code==='QUEST_LOCKED');
  const reply=await call(`/apps/${connected.id}/leads/two/replies`,'POST',{expectedRevision:1});
  assert.equal(reply.status,403);assert.equal(reply.body.code,'QUEST_LOCKED');
  await addPost('newest');
  const newer=await call(`/apps/${connected.id}/leads`);
  assert.equal(newer.body.leads[0].postId,'one','new arrivals cannot replace the free quest');assert.equal(newer.body.locked.count,2);
  await store.set('lead_control','provider',{ready:false},true);
  assert.equal((await call('/onboarding/trial','POST',{})).status,503);
  assert.equal((await readOnboarding(store,userId))?.trialStartedAt,undefined,'unavailable discovery never consumes the trial');
  await store.set('lead_control','provider',{ready:true},true);
  const starts=await Promise.all([call('/onboarding/trial','POST',{}),call('/onboarding/trial','POST',{})]);
  assert.ok(starts.every(result=>result.status===200));
  assert.equal(starts[0].body.trialStartedAt,starts[1].body.trialStartedAt);
  assert.equal(starts[0].body.trialEndsAt-starts[0].body.trialStartedAt,QUEST_TRIAL_MS);
  assert.equal((await call(`/apps/${connected.id}/leads`)).body.leads.length,3);
  await call('/onboarding','PUT',{stage:'complete'});
  assert.equal((await call('/onboarding/bootstrap','POST',{})).body.stage,'complete');
  const state=(await readOnboarding(store,userId))!;
  await store.set('users',userId,{questOnboarding:{...state,trialEndsAt:Date.now()-1}},true);
  const expired=await call(`/apps/${connected.id}/leads`);
  assert.equal(expired.body.leads.length,1);assert.equal(expired.body.leads[0].postId,'one');
  const retry=await call('/onboarding/trial','POST',{});
  assert.equal(retry.body.trialStartedAt,state.trialStartedAt);assert.equal(retry.body.trialActive,false);
  const account=await store.get<any>('users',userId);assert.equal(account.email,'fixture@example.test','progress preserves account fields');
});

test('existing accounts with connected apps are not forced through onboarding',async()=>{
  const store=testStore(),userId=randomUUID();
  await fixture(store,userId);
  assert.equal(hasQuestAccess(await readOnboarding(store,userId)),true);
});

test('a new Apple account is enrolled before it can bypass bootstrap through an older client',async t=>{
  const store=testStore();
  const instance=createApplication({port:0,host:'127.0.0.1',publicUrl:'https://quest.example.com',...firebaseOptions,
    production:false,registrationEnabled:true,demoEnabled:true,appleRootDirectory:'/unused',apns:null,store});
  const server=instance.app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const port=(server.address() as {port:number}).port;
  const credential=appleCredential(`onboarding-${randomUUID()}@example.test`);
  const response=await fetch(`http://127.0.0.1:${port}/api/auth/apple`,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...credential,client:'ios'})});
  assert.equal(response.status,200);
  const account=await response.json() as any;
  const state=await readOnboarding(store,account.user.id);
  assert.equal(state?.stage,'app');assert.equal(hasQuestAccess(state),false);
  await fixture(store,account.user.id);
  const bootstrap=await fetch(`http://127.0.0.1:${port}/api/onboarding/bootstrap`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${account.token}`},body:'{}'});
  assert.equal(bootstrap.status,200);
  assert.equal((await bootstrap.json() as any).stage,'app','creating an app before bootstrap cannot grant legacy access');
});
