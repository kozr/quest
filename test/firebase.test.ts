import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {testStore,rows,jobs,firebaseOptions} from './firebase-fixture.js';
import {Store,newWebhookSecret,type AppRow,type Job} from '../src/database.js';
import {createSession,tokenHash} from '../src/auth.js';
import {DeliveryWorker,RetryDelivery} from '../src/worker.js';
import {readConfiguration} from '../src/config.js';
import {createApplication} from '../src/app.js';
import {purgeApp} from '../src/functions.js';
import type {ActivityEvent} from '../src/types.js';

async function fixture(t:TestContext) {
  const store=testStore();const password='Firestore-integration-password!';const email=`firebase-${randomUUID()}@example.test`;
  const identity=await store.identity.signIn(email,password,true);const uid=identity.user.id;
  await store.set('users',uid,identity.user);
  const token=await createSession(store,uid,identity.authTime);
  const app:AppRow={id:randomUUID(),user_id:uid,name:'Firestore fixture',bundle_id:'test.firestore.fixture',apple_id:'123456789',source:'apple',icon_url:null,webhook_secret:newWebhookSecret(),created_at:new Date().toISOString(),last_production_at:null,last_sandbox_at:null,active:true};
  await store.createApp(app);
  const device=await store.registerDevice(uid,tokenHash(token),{token:randomUUID().replaceAll('-','').repeat(2),name:'Fixture phone',environment:'sandbox'});
  const now=new Date().toISOString();
  const event:ActivityEvent={id:randomUUID(),appId:app.id,appName:app.name,kind:'sale',title:'New sale',detail:'Verified fixture',amountMilliunits:4990,currency:'USD',productId:'fixture.product',transactionId:'tx-fixture',environment:'Production',occurredAt:now,receivedAt:now,notificationType:'ONE_TIME_CHARGE',subtype:null,isMonetary:true};
  t.after(async()=>{await store.identity.auth.deleteUser(uid);});
  return {store,identity,uid,password,email,token,app,device,event};
}
test('concurrent Firestore webhook retries commit exactly one receipt, event, and outbox job',async t=>{
  const f=await fixture(t);
  const results=await Promise.all(Array.from({length:5},()=>f.store.saveEvent({...f.event,id:randomUUID()},f.uid,'purchase:tx',Date.now(),{uuid:'same-apple-uuid',secret:f.app.webhook_secret})));
  assert.equal(results.filter(r=>r==='received').length,1);
  assert.equal((await rows(f.store,'notifications')).length,1);assert.equal((await rows(f.store,'events')).length,1);assert.equal((await jobs(f.store)).length,1);
});
test('concurrent different Apple UUIDs still deduplicate the same economic transition',async t=>{
  const f=await fixture(t);
  const results=await Promise.all(Array.from({length:3},()=>f.store.saveEvent({...f.event,id:randomUUID()},f.uid,'purchase:tx',Date.now(),{uuid:randomUUID(),secret:f.app.webhook_secret})));
  assert.equal(results.filter(r=>r==='received').length,1);assert.equal((await jobs(f.store)).length,1);assert.equal((await rows(f.store,'notifications')).length,3);
});
test('Firestore uniqueness survives concurrent app creation',async t=>{
  const f=await fixture(t);
  const result=await Promise.allSettled(Array.from({length:3},()=>f.store.createApp({...f.app,id:randomUUID(),bundle_id:'another.unique.bundle',webhook_secret:newWebhookSecret()})));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal((await f.store.apps(f.uid)).length,2);
});
test('concurrent task dispatches share a single fenced delivery lease',async t=>{
  const f=await fixture(t);const id=await f.store.enqueue(f.device.id,f.uid);
  let release!:()=>void;let started!:()=>void;const running=new Promise<void>(r=>{started=r;});let sends=0;
  const worker=new DeliveryWorker(f.store,{send:async()=>{sends++;started();await new Promise<void>(r=>{release=r;});return {ok:true};}});
  const first=worker.deliver(id);await running;
  await assert.rejects(worker.deliver(id),RetryDelivery);release();await first;
  await worker.deliver(id);assert.equal(sends,1);assert.equal((await f.store.get<Job>('delivery_jobs',id))!.state,'sent');
});
test('a late worker cannot overwrite a replacement lease result',async t=>{
  const f=await fixture(t);const id=await f.store.enqueue(f.device.id,f.uid);
  let release!:()=>void;let started!:()=>void;const running=new Promise<void>(r=>{started=r;});
  const worker=new DeliveryWorker(f.store,{send:async()=>{started();await new Promise<void>(r=>{release=r;});return {ok:false,invalidDevice:true};}});
  const first=worker.deliver(id);await running;
  await f.store.set('delivery_jobs',id,{state:'sent',lease_id:'replacement-lease'},true);release();await first;
  assert.equal((await f.store.get<Job>('delivery_jobs',id))!.state,'sent');assert.equal((await f.store.get<any>('devices',f.device.id))!.active,1);
});
test('app tombstones hide activity, reject old endpoints, cancel delivery, and allow resumable purge',async t=>{
  const f=await fixture(t);await f.store.saveEvent(f.event,f.uid,'purchase:tx',Date.now(),{uuid:'delete-fixture',secret:f.app.webhook_secret});
  await f.store.removeApp(f.app.id,f.uid);
  assert.equal(await f.store.appForSecret(f.app.webhook_secret),undefined);
  assert.equal((await f.store.activity(f.uid,{environment:'all',limit:50})).events.length,0);
  let sends=0;const worker=new DeliveryWorker(f.store,{send:async()=>{sends++;return {ok:true};}});await worker.tick();assert.equal(sends,0);
  assert.equal((await jobs(f.store))[0].state,'cancelled');
  await purgeApp(f.store,f.app.id);await purgeApp(f.store,f.app.id);
  for(const name of ['events','notifications','economic_events','delivery_jobs']) assert.equal((await rows(f.store,name)).length,0);
});
test('Firebase disabled/deleted accounts invalidate existing service sessions and pending pushes',async t=>{
  const f=await fixture(t);await f.store.enqueue(f.device.id,f.uid);
  await f.store.identity.auth.updateUser(f.uid,{disabled:true});assert.equal(await f.store.session(tokenHash(f.token)),undefined);
  let sends=0;const worker=new DeliveryWorker(f.store,{send:async()=>{sends++;return {ok:true};}});await worker.tick();assert.equal(sends,0);assert.equal((await jobs(f.store))[0].state,'cancelled');
});
test('Firebase revocation time invalidates a service session even if its 30-day expiry is still valid',async t=>{
  const f=await fixture(t);
  await f.store.set('sessions',tokenHash(f.token),{auth_time:f.identity.authTime-60},true);
  await f.store.identity.auth.revokeRefreshTokens(f.uid);assert.equal(await f.store.session(tokenHash(f.token)),undefined);
});
test('closed-beta login does not admit accounts created directly through Firebase Auth',async t=>{
  const f=await fixture(t);await f.store.delete('users',f.uid);
  const app=createApplication({port:4317,host:'127.0.0.1',publicUrl:'http://localhost:4317',...firebaseOptions,production:false,registrationEnabled:false,demoEnabled:false,appleRootDirectory:'/unused',apns:null,store:f.store}).app;
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise<void>(r=>server.close(()=>r())));
  const address=server.address();assert(address && typeof address!=='string');
  const response=await fetch(`http://127.0.0.1:${address.port}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.email,password:f.password,client:'ios'})});
  assert.equal(response.status,403);assert.equal(response.headers.get('set-cookie'),null);
});
test('Firestore rules deny direct reads/writes even to an authenticated owner',async t=>{
  const f=await fixture(t);
  const auth=await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:f.email,password:f.password,returnSecureToken:true})});
  const {idToken}=await auth.json() as {idToken:string};assert.ok(idToken);
  const url=`http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/demo-iap-notifications/databases/(default)/documents/${f.store.prefix}users/${f.uid}`;
  for(const authorization of ['',`Bearer ${idToken}`]) {
    const headers:Record<string,string>={'Content-Type':'application/json',...(authorization ? {Authorization:authorization} : {})};
    assert.equal((await fetch(url,{headers})).status,403);
    assert.equal((await fetch(url,{method:'PATCH',headers,body:JSON.stringify({fields:{email:{stringValue:'attacker@example.test'}}})})).status,403);
  }
});
test('production configuration cannot accidentally accept Auth emulator tokens',()=>{
  const base={NODE_ENV:'production',PUBLIC_URL:'https://example.test',FIREBASE_PROJECT_ID:'production-project',IAP_FIREBASE_WEB_API_KEY:'fixture'};
  assert.throws(()=>readConfiguration({...base,FIRESTORE_EMULATOR_HOST:'127.0.0.1:8088',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9098'}));
  assert.throws(()=>readConfiguration({...base,NODE_ENV:'development',FIREBASE_PROJECT_ID:'demo-local',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9098'}));
  assert.equal(readConfiguration(base).firebaseProjectId,'production-project');
});
