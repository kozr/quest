import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import express from 'express';
import {testStore} from './firebase-fixture.js';
import {Timestamp} from 'firebase-admin/firestore';
import {documentKey} from '../src/database.js';
import type {Store,AppRow} from '../src/database.js';
import {marketingSubscription,marketingTransaction,syncMarketingTransaction,selectMarketingApps,hasMarketingAccess,marketingBillingRouter,marketingWebhookRouter,purgeMarketingAccount} from '../src/marketing-billing.js';
const env={MARKETING_BILLING_ENABLED:'true',MARKETING_APP_APPLE_ID:'123456789'};
async function fixture(store:Store) {
  const user=randomUUID(),other=randomUUID();
  await store.set('users',user,{id:user});await store.set('users',other,{id:other});
  const apps=[];
  for(let i=0;i<4;i++) {
    const app:AppRow={id:randomUUID(),user_id:user,name:`App ${i}`,bundle_id:`test.${randomUUID()}`,apple_id:'123456789',source:'apple',
      icon_url:null,webhook_secret:randomUUID(),created_at:new Date().toISOString(),last_production_at:null,last_sandbox_at:null,active:true};
    await store.set('apps',app.id,app);apps.push(app.id);
  }
  const access=await marketingSubscription(store,user,env),now=Date.now();
  const payload={bundleId:'com.kozr.quest',environment:'Production',type:'Auto-Renewable Subscription',inAppOwnershipType:'PURCHASED',
    productId:'com.kozr.quest.marketing.one.monthly',originalTransactionId:'100000000001',transactionId:'100000000002',appAccountToken:access.appAccountToken,
    purchaseDate:now-10000,expiresDate:now+86400000,signedDate:now};
  return {user,other,apps,now,payload,tx:marketingTransaction(payload,env,now)};
}

test('verified subscriptions bind to account, enforce owned app coverage, and expire at the deadline',async()=>{
  const store=testStore(),f=await fixture(store);
  assert.equal(await hasMarketingAccess(store,f.user,f.apps[0],env),false);
  assert.equal(await hasMarketingAccess(store,f.user,f.apps[0],{}),true,'disabled rollout preserves beta');
  const paid=await syncMarketingTransaction(store,f.user,f.tx,[f.apps[0]],env);
  assert.equal(paid.active,true);assert.equal(paid.appLimit,1);
  assert.equal(await hasMarketingAccess(store,f.user,f.apps[0],env),true);
  assert.equal(await hasMarketingAccess(store,f.user,f.apps[1],env),false);
  assert.equal(await hasMarketingAccess(store,f.user,f.apps[0],env,f.tx.expiresAt),false);
  await assert.rejects(selectMarketingApps(store,f.user,f.apps.slice(0,2),env),(e:any)=>e.code==='MARKETING_APP_LIMIT');
  await assert.rejects(selectMarketingApps(store,f.user,[randomUUID()],env),(e:any)=>e.code==='APP_NOT_FOUND');
  await assert.rejects(syncMarketingTransaction(store,f.other,f.tx,[],env),(e:any)=>e.code==='MARKETING_ACCOUNT_MISMATCH');
  const other=await marketingSubscription(store,f.other,env);
  await assert.rejects(syncMarketingTransaction(store,f.other,{...f.tx,appAccountToken:other.appAccountToken},[],env),(e:any)=>e.code==='MARKETING_ACCOUNT_MISMATCH');
});
test('renewal, downgrade, refund, replay and removed app transitions never regrant stale coverage',async()=>{
  const store=testStore(),f=await fixture(store);
  const three={...f.tx,productID:'com.kozr.quest.marketing.three.annual' as const};
  await syncMarketingTransaction(store,f.user,three,f.apps.slice(0,3),env);
  const one={...f.tx,transactionID:'100000000003',purchaseDate:f.now,expiresAt:f.now+172800000,signedDate:f.now+1};
  const downgraded=await syncMarketingTransaction(store,f.user,one,undefined,env,f.now+2);
  assert.equal(downgraded.appLimit,1);assert.deepEqual(downgraded.appIDs,[f.apps[0]]);
  await store.set('apps',f.apps[0],{active:false},true);
  assert.deepEqual((await marketingSubscription(store,f.user,env)).appIDs,[]);
  const refund=await syncMarketingTransaction(store,f.user,{...one,revoked:true,signedDate:f.now+3},undefined,env,f.now+4);
  assert.equal(refund.active,false,'deleted coverage cannot prevent refund processing');
  assert.equal((await syncMarketingTransaction(store,f.user,one,[f.apps[1]],env,f.now+5)).active,false,'old restore cannot undo refund');
  await purgeMarketingAccount(store,f.user);
  const rebuilt=await marketingSubscription(store,f.user,env);
  await assert.rejects(syncMarketingTransaction(store,f.user,{...one,appAccountToken:rebuilt.appAccountToken},[],env),(e:any)=>e.code==='MARKETING_ACCOUNT_MISMATCH');
});
test('subscription router rejects unverified input; signed lifecycle webhook activates and revokes independently of phone',async t=>{
  const store=testStore(),f=await fixture(store);
  let payload={...f.payload};
  const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).user={id:f.user};next();});
  app.use('/api',marketingBillingRouter(store,{env,verifyTransaction:async signed=>{if(signed!=='verified-fixture') throw new Error('bad signature');return payload;}}));
  app.use('/webhooks',marketingWebhookRouter(store,{env,verifyNotification:async signed=>{
    if(signed!=='verified-notification') throw new Error('bad signature');
    return {transaction:payload,renewal:null,context:{bundleId:'com.kozr.quest',appleId:123456789,environment:'Production'},
      notification:{notificationType:payload.revocationDate?'REFUND':'DID_RENEW',signedDate:Date.now()}} as any;
  }}));
  app.use((error:any,_req:any,res:any,_next:any)=>res.status(error.status??400).json({error:error.message,code:error.code}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const url=`http://127.0.0.1:${(server.address() as any).port}`;
  const post=async(path:string,body:object)=>{const r=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json() as any};};
  assert.equal((await post('/api/marketing/subscription',{signedTransaction:'forged',appIDs:[f.apps[0]]})).status,400);
  assert.equal((await marketingSubscription(store,f.user,env)).active,false);
  assert.equal((await post('/webhooks/marketing/apple',{signedPayload:'verified-notification'})).status,200);
  const restored=await post('/api/marketing/subscription',{signedTransaction:'verified-fixture',appIDs:[]});
  assert.equal(restored.status,200);assert.equal(restored.body.active,true);assert.deepEqual(restored.body.appIDs,[]);
  await selectMarketingApps(store,f.user,[f.apps[0]],env);
  payload={...payload,revocationDate:Date.now(),signedDate:Date.now()+1} as typeof payload;
  assert.equal((await post('/webhooks/marketing/apple',{signedPayload:'verified-notification'})).status,200);
  assert.equal((await marketingSubscription(store,f.user,env)).active,false);
});

test('paid gates stop new research and old beta trials while leaving app setup available',async t=>{
  const {queueInitialLeadScan}=await import('../src/leads-initial-scan.js');
  const {queueMarketScan}=await import('../src/market-jobs.js');
  const {queueLeadReply}=await import('../src/leads-jobs.js');
  const {onboardingRouter,requireQuestAccess}=await import('../src/onboarding.js');
  const {leadsRouter}=await import('../src/leads.js');
  const {redditRouter}=await import('../src/reddit.js');
  const store=testStore(),f=await fixture(store);
  const settings={...env,LEADS_ENABLED:'true',REDDIT_MONITORING_ENABLED:'true',REDDIT_PUBLIC_ACCESS:'true'};
  const prior=Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));Object.assign(process.env,settings);
  t.after(()=>{for(const [key,value] of Object.entries(prior)) {if(value===undefined) delete process.env[key];else process.env[key]=value;}});
  const denied=(e:any)=>e.code==='MARKETING_SUBSCRIPTION_REQUIRED';
  await assert.rejects(queueInitialLeadScan(store,f.user,f.apps[0],1,f.now,settings),denied);
  await assert.rejects(queueMarketScan(store,f.user,f.apps[0],{expectedRevision:1,idempotencyKey:randomUUID()},settings,f.now),denied);
  await assert.rejects(queueLeadReply(store,f.user,f.apps[0],'post1',1,settings,f.now),denied);
  await store.set('users',f.user,{questOnboarding:{stage:'complete',legacy:true}},true);
  await assert.rejects(requireQuestAccess(store,f.user,f.apps[0],'post1'),denied);
  const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as any).user={id:f.user};next();});
  app.use('/api',onboardingRouter(store));app.use('/api',leadsRouter(store));app.use('/api/reddit',redditRouter(store));
  app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status??400).json({code:e.code,error:e.message}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
  const url=`http://127.0.0.1:${(server.address() as any).port}/api`;
  assert.equal((await fetch(`${url}/apps/${f.apps[0]}/leads`)).status,403);
  assert.equal((await fetch(`${url}/apps/${f.apps[0]}/leads/profile`)).status,200,'profile preparation stays available');
  assert.equal((await fetch(`${url}/onboarding/trial`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,410);
  await syncMarketingTransaction(store,f.user,f.tx,[f.apps[0]],env);
  await requireQuestAccess(store,f.user,f.apps[0],'post1');
  assert.equal((await fetch(`${url}/apps/${f.apps[0]}/leads`)).status,200,'paid account escapes legacy free quest lock');
  // Account-level legacy settings cannot expand a one-app subscription's scope.
  await store.set('reddit_settings',f.user,{user_id:f.user,enabled:true,communities:['uncovered'],keywords:[],updatedAt:new Date().toISOString()});
  await store.set('lead_profiles',documentKey(f.user,f.apps[0]),{user_id:f.user,app_id:f.apps[0],enabled:true,communities:['covered'],keywords:['journal']});
  await store.set('lead_profiles',documentKey(f.user,f.apps[1]),{user_id:f.user,app_id:f.apps[1],enabled:true,communities:['uncovered'],keywords:[]});
  for(const community of ['covered','uncovered']) await store.set('reddit_posts',community,{id:community,subreddit:community,title:'Need a journal',body:'journal',url:`https://www.reddit.com/r/${community}/comments/${community}/`,
    createdAt:new Date().toISOString(),score:1,comments:1,expireAt:Timestamp.fromMillis(Date.now()+86400000)});
  const feed=await (await fetch(`${url}/reddit/posts`)).json() as any;
  assert.deepEqual(feed.posts.map((post:any)=>post.id),['covered']);
  const settingsResponse=await (await fetch(`${url}/reddit/settings`)).json() as any;
  assert.deepEqual(settingsResponse.settings.communities,['covered']);
  assert.equal((await fetch(`${url}/reddit/settings`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:true,communities:['uncovered'],keywords:[]})})).status,409);
  assert.equal((await fetch(`${url}/reddit/posts/uncovered`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'saved'})})).status,404);

});
