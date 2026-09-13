import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Timestamp} from 'firebase-admin/firestore';
import {createApplication} from '../src/app.js';
import {purgeAccount,requestAccountDeletion} from '../src/account-deletion.js';
import {documentKey,type AppRow} from '../src/database.js';
import {ServiceError} from '../src/firebase.js';
import {testStore,firebaseOptions,rows} from './firebase-fixture.js';
import {appleCredential} from './apple-auth-fixture.js';

async function fixture(t:any) {
  const store=testStore();
  const app=createApplication({...firebaseOptions,store,port:0,host:'127.0.0.1',publicUrl:'http://localhost:4317',production:false,
    registrationEnabled:true,demoEnabled:false,appleRootDirectory:'/not-used',apns:null});
  const server=app.app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve())));
  const address=server.address();assert(address && typeof address!=='string');
  const request=async(path:string,token?:string,body?:unknown)=>{
    const response=await fetch(`http://127.0.0.1:${address.port}${path}`,{method:body ? 'POST' : 'GET',
      headers:{'Content-Type':'application/json',...(token ? {Authorization:`Bearer ${token}`} : {})},body:body ? JSON.stringify(body) : undefined});
    return {status:response.status,body:await response.json() as any};
  };
  const email=`deletion-${randomUUID()}@example.test`;
  const login=await request('/api/auth/apple',undefined,appleCredential(email));assert.equal(login.status,200);
  const token=login.body.token,uid=login.body.user.id;
  let revocations=0;
  t.mock.method(store.identity,'revokeAppleAuthorization',async(expected:string,idToken:string,nonce:string,code:string)=>{
    assert(code.length>0);
    const result=await store.identity.signInWithApple(idToken,nonce);
    if(result.user.id!==expected) throw new ServiceError(403,'Use the same Apple Account.');
    revocations++;
  });
  return {store,request,email,token,uid,revocations:()=>revocations};
}

test('deletion requires fresh Apple confirmation for the same account and blocks all sessions immediately',async t=>{
  const f=await fixture(t);
  const wrong=await f.request('/api/account/delete',f.token,{...appleCredential(`other-${randomUUID()}@example.test`),authorizationCode:'other'});
  assert.equal(wrong.status,403);assert.equal(f.revocations(),0);
  assert.equal(await f.store.accountDeleting(f.uid),false);
  const reused=appleCredential(f.email);
  await f.request('/api/auth/apple',undefined,reused);
  assert.equal((await f.request('/api/account/delete',f.token,{...reused,authorizationCode:'reused'})).status,401);
  const credential=appleCredential(f.email);
  const deletion=await f.request('/api/account/delete',f.token,{...credential,authorizationCode:'fresh'});
  assert.equal(deletion.status,202);
  assert.equal((await f.request('/api/account/deletion-status',undefined,{receipt:deletion.body.receipt})).body.status,'deleting');
  assert.equal(f.revocations(),1);
  assert.equal((await f.request('/api/auth/me',f.token)).status,401);
  assert.equal((await f.request('/api/auth/apple',undefined,appleCredential(f.email))).status,409);
  const stored=JSON.stringify(await rows(f.store,'account_deletions'));
  assert(!stored.includes(f.email));assert(!stored.includes(credential.rawNonce));assert(!stored.includes(credential.idToken));
  assert.equal((await f.store.get<any>('account_deletions',f.uid)).expireAt,undefined);
  await purgeAccount(f.store,f.uid);
  assert.equal((await f.request('/api/account/deletion-status',undefined,{receipt:deletion.body.receipt})).body.status,'complete');
  assert.equal((await f.request('/api/account/deletion-status',undefined,{receipt:'x'.repeat(43)})).body.status,'unavailable');
});

test('upstream Apple revocation failure does not delete data or claim success',async t=>{
  const f=await fixture(t);
  t.mock.method(f.store.identity,'revokeAppleAuthorization',async()=>{throw new ServiceError(503,'Apple unavailable');});
  assert.equal((await f.request('/api/account/delete',f.token,{...appleCredential(f.email),authorizationCode:'code'})).status,503);
  assert.equal(await f.store.accountDeleting(f.uid),false);
  assert.equal((await f.request('/api/auth/me',f.token)).status,200);
});

test('purge removes data across batches, inactive apps and device registries while protecting another owner',async t=>{
  const f=await fixture(t);
  const app:AppRow={id:randomUUID(),user_id:f.uid,name:'Fixture',bundle_id:'example.delete',apple_id:'123',source:'apple',
    icon_url:null,webhook_secret:'old-webhook-secret',created_at:new Date().toISOString(),last_production_at:null,last_sandbox_at:null,active:false};
  await f.store.set('apps',app.id,app);
  await f.store.set('app_keys',documentKey(f.uid,app.bundle_id),{app_id:app.id});
  await f.store.set('webhook_keys',documentKey(app.webhook_secret),{app_id:app.id});
  for(let offset=0;offset<405;offset+=200) {
    const batch=f.store.db.batch();
    for(let i=offset;i<Math.min(405,offset+200);i++) batch.set(f.store.collection('notifications').doc(String(i)),{app_id:app.id});
    await batch.commit();
  }
  for(const [collection,field] of [['events','appId'],['economic_events','app_id'],['delivery_jobs','app_id'],['forwarding_jobs','app_id']]) {
    await f.store.set(collection,'mine',{[field]:app.id,user_id:f.uid,body:'private-payload',destination:'https://secret.example'});
    await f.store.set(collection,'other',{[field]:'other-app',user_id:'other-owner'});
  }
  await f.store.set('devices','old',{id:'old',user_id:f.uid,token:'old-token',environment:'production'});
  await f.store.set('device_tokens',documentKey('old-token','production'),{device_id:'old'});
  await f.store.set('devices','transferred',{id:'transferred',user_id:f.uid,token:'shared-token',environment:'production'});
  await f.store.set('device_tokens',documentKey('shared-token','production'),{device_id:'other-device'});
  await f.store.set('browser_pairings','pairing',{approved_user_id:f.uid});
  await f.store.set('preferences',f.uid,{sales:true});
  await requestAccountDeletion(f.store,f.uid);
  assert.equal(await f.store.getApp(app.id),undefined);
  await purgeAccount(f.store,f.uid);
  await purgeAccount(f.store,f.uid);
  for(const collection of ['users','preferences','sessions','apps','app_keys','webhook_keys','notifications','devices','browser_pairings']) assert.equal((await rows(f.store,collection)).length,0,collection);
  for(const collection of ['events','economic_events','delivery_jobs','forwarding_jobs']) assert.deepEqual(await rows(f.store,collection),[{[collection==='events' ? 'appId' : 'app_id']:'other-app',user_id:'other-owner'}]);
  assert.deepEqual(await rows(f.store,'device_tokens'),[{device_id:'other-device'}]);
  await assert.rejects(f.store.identity.auth.getUser(f.uid),{code:'auth/user-not-found'});
  const receipt=await f.store.get<any>('account_deletions',f.uid);
  assert.equal(receipt.state,'complete');assert(receipt.expireAt instanceof Timestamp);
});

test('a failed cleanup remains pending and safely resumes',async t=>{
  const f=await fixture(t);await requestAccountDeletion(f.store,f.uid);
  const original=f.store.identity.auth.deleteUser.bind(f.store.identity.auth);
  const failure=t.mock.method(f.store.identity.auth,'deleteUser',async()=>{throw new Error('temporary');});
  await assert.rejects(purgeAccount(f.store,f.uid));
  assert.equal((await f.store.get<any>('account_deletions',f.uid)).state,'pending');
  failure.mock.restore();
  await purgeAccount(f.store,f.uid);
  assert.equal((await f.store.get<any>('account_deletions',f.uid)).state,'complete');
  await assert.rejects(original(f.uid),{code:'auth/user-not-found'});
});
