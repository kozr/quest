import { test } from 'node:test';
import assert from 'node:assert/strict';
import {FieldValue} from 'firebase-admin/firestore';
import {tokenHash} from '../src/auth.js';
import { once } from 'node:events';
import {firebaseOptions,testStore,resetAccounts,rows,jobs,pairBrowser} from './firebase-fixture.js';
import {appleCredential} from './apple-auth-fixture.js';
import {Store} from '../src/database.js';
import { createApplication, type ApplicationOptions } from '../src/app.js';
import { AppleVerificationError, type VerifiedAppleNotification } from '../src/apple.js';
import type { PushTransport, PushResult } from '../src/apns.js';

const options: ApplicationOptions={port:4317,host:'127.0.0.1',publicUrl:'http://localhost:4317',...firebaseOptions,production:false,
  registrationEnabled:true,demoEnabled:true,appleRootDirectory:'/not-configured',apns:null};
const input={name:'Test App',bundleId:'com.example.test',appleId:'123456789',source:'apple'};
const encoded=(payload:object)=>`eyJhbGciOiJFUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.test`;

function verified(uuid='notification-one',environment:'Production'|'Sandbox'='Production',type='ONE_TIME_CHARGE',price=4990,signedDate=Date.now()): VerifiedAppleNotification {
  return {context:{bundleId:input.bundleId,appleId:Number(input.appleId),environment},notification:{notificationUUID:uuid,signedDate,notificationType:type,version:'2.0',data:{environment,bundleId:input.bundleId,appAppleId:Number(input.appleId)}},
    transaction:{bundleId:input.bundleId,environment,transactionId:'transaction-one',originalTransactionId:'transaction-one',productId:'test.product',price,currency:'USD',inAppOwnershipType:'PURCHASED',purchaseDate:signedDate,revocationType:type==='REFUND' ? 'REFUND_FULL' : undefined},renewal:null};
}

async function fixture(overrides: Partial<ApplicationOptions>={}) {
  const store=overrides.store ?? testStore();
  if(!overrides.store) await resetAccounts(store,['first@example.test','second@example.test','browser@example.test','other@example.test']);
  const instance=createApplication({...options,...overrides,store});
  const server=instance.app.listen(0,'127.0.0.1');
  await once(server,'listening');
  const address=server.address();
  assert(address && typeof address!=='string');
  const base=`http://127.0.0.1:${address.port}`;
  async function request(path:string,{method='GET',body,token,cookie,origin}: {method?:string,body?:unknown,token?:string,cookie?:string,origin?:string}={}) {
    const response=await fetch(`${base}${path}`,{method,headers:{...(body!==undefined ? {'Content-Type':'application/json'} : {}),...(token ? {Authorization:`Bearer ${token}`} : {}),...(cookie ? {Cookie:cookie} : {}),...(origin ? {Origin:origin} : {})},body:body===undefined ? undefined : JSON.stringify(body)});
    return {status:response.status,body:await response.json() as any,headers:response.headers};
  }
  async function register(email='first@example.test') {
    const result=await request('/api/auth/apple',{method:'POST',body:appleCredential(email)});
    assert.equal(result.status,200,JSON.stringify(result.body));return result.body.token as string;
  }
  async function add(token:string,source='apple') {
    const result=await request('/api/apps',{method:'POST',token,body:{...input,source}});
    assert.equal(result.status,201);return result.body.app;
  }
  async function close() {await instance.worker.stop(); await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()));instance.store.close();}
  return {...instance,request,register,add,close};
}

test('Firebase Auth protects accounts; Firestore stores hashed sessions but no passwords',async()=>{
  const f=await fixture();try {
    assert.equal((await f.request('/api/apps')).status,401);
    const token=await f.register();
    const me=await f.request('/api/auth/me',{token});assert.equal(me.body.user.email,'first@example.test');
    const session=(await rows(f.store,'sessions'))[0];
    assert.notEqual(session.token_hash,token);
    assert.equal((await rows(f.store,'users'))[0].password_hash,undefined);
    assert.equal((await f.store.identity.auth.getUserByEmail('first@example.test')).uid,me.body.user.id);
    assert.equal((await f.request('/api/auth/login',{method:'POST',body:{email:'first@example.test',password:'wrong-but-long-password'}})).status,410);
    await f.request('/api/auth/logout',{method:'POST',token});
    assert.equal((await f.request('/api/auth/me',{token})).status,401);
  } finally {await f.close();}
});

test('Apple sign-in is single-use under concurrent replay and keeps raw credentials out of Firestore',async()=>{
  const f=await fixture();try {
    const credential=appleCredential('first@example.test');
    const results=await Promise.all([0,1,2].map(()=>f.request('/api/auth/apple',{method:'POST',body:credential})));
    assert.deepEqual(results.map(result=>result.status).sort(),[200,401,401]);
    const sessions=await rows(f.store,'sessions');assert.equal(sessions.length,1);assert.equal(sessions[0].provider,'apple.com');
    assert.equal((await rows(f.store,'apple_sign_ins')).length,1);
    const stored=JSON.stringify([sessions,await rows(f.store,'apple_sign_ins'),await rows(f.store,'users')]);
    assert(!stored.includes(credential.rawNonce));assert(!stored.includes(credential.idToken));
    assert.equal((await f.request('/api/auth/apple',{method:'POST',body:credential})).status,401);
    const fresh=await f.request('/api/auth/apple',{method:'POST',body:appleCredential('first@example.test')});
    assert.equal(fresh.status,200);assert.equal(fresh.body.user.id,results.find(result=>result.status===200)!.body.user.id);
  } finally {await f.close();}
});

test('Apple nonce mismatch, expired credentials, stale/future issue time, and foreign issuer fail closed',async()=>{
  const f=await fixture();try {
    const now=Math.floor(Date.now()/1000);
    for(const claims of [{nonce:'wrong'},{exp:now-1},{iat:now-301},{iat:now+120},{iss:'https://accounts.google.com'}]) {
      assert.equal((await f.request('/api/auth/apple',{method:'POST',body:appleCredential('first@example.test',claims)})).status,401);
    }
    assert.equal((await rows(f.store,'sessions')).length,0);
    assert.equal((await rows(f.store,'users')).length,0);
  } finally {await f.close();}
});

test('Apple login requires the native contract; no password route or web-cookie fallback remains',async()=>{
  const f=await fixture();try {
    for(const action of ['login','register']) {
      const result=await f.request(`/api/auth/${action}`,{method:'POST',body:{email:'first@example.test',password:'No-longer-supported!'}});
      assert.equal(result.status,410);assert.equal(result.body.token,undefined);assert.equal(result.headers.get('set-cookie'),null);
    }
    for(const client of [undefined,'web']) {
      assert.equal((await f.request('/api/auth/apple',{method:'POST',body:{...appleCredential('first@example.test'),client}})).status,400);
    }
    const result=await f.request('/api/auth/apple',{method:'POST',body:appleCredential('first@example.test')});
    assert.equal(result.status,200);assert.equal(result.headers.get('set-cookie'),null);
  } finally {await f.close();}
});

test('legacy sessions and sessions whose Apple provider was removed are rejected',async()=>{
  const f=await fixture();try {
    const legacy=await f.register();
    await f.store.collection('sessions').doc(tokenHash(legacy)).update({provider:FieldValue.delete()});
    assert.equal((await f.request('/api/auth/me',{token:legacy})).status,401);
    const fresh=await f.register();
    const {user}=(await f.request('/api/auth/me',{token:fresh})).body;
    await f.store.identity.auth.updateUser(user.id,{providersToUnlink:['apple.com']});
    assert.equal((await f.request('/api/auth/me',{token:fresh})).status,401);
  } finally {await f.close();}
});

test('Hide My Email accounts sign in without requiring a personal email address',async()=>{
  const f=await fixture();try {
    const email=`relay-${Date.now()}@privaterelay.appleid.com`;
    const token=await f.register(email);
    assert.equal((await f.request('/api/auth/me',{token})).body.user.email,email);
  } finally {await f.close();}
});

test('browser cookies are HttpOnly, do not return tokens, and require same-origin mutations',async()=>{
  const f=await fixture();try {
    const response=await pairBrowser(f.request,await f.register('browser@example.test'),options.publicUrl);
    assert.equal(response.status,200);assert.equal(response.body.token,undefined);
    const cookie=response.headers.getSetCookie().find(value=>value.startsWith('iap_session='))!;assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);
    const value=cookie.split(';')[0];
    assert.equal((await f.request('/api/apps',{method:'POST',cookie:value,body:input})).status,403);
    assert.equal((await f.request('/api/apps',{method:'POST',cookie:value,origin:'https://evil.example',body:input})).status,403);
    assert.equal((await f.request('/api/apps',{method:'POST',cookie:value,origin:options.publicUrl,body:input})).status,201);
    assert.equal((await f.request('/api/auth/apple',{method:'POST',origin:'https://evil.example',body:appleCredential('browser@example.test')})).status,403);
  } finally {await f.close();}
});

test('apps, activity, cursors, preferences and devices are tenant isolated',async()=>{
  const f=await fixture();try {
    const a=await f.register();const b=await f.register('second@example.test');const app=await f.add(a);
    assert.equal((await f.request('/api/apps',{token:b})).body.apps.length,0);
    assert.equal((await f.request(`/api/apps/${app.id}`,{method:'DELETE',token:b})).status,404);
    assert.equal((await f.request(`/api/apps/${app.id}/demo`,{method:'POST',token:b,body:{kind:'sale'}})).status,404);
    const demo=await f.request(`/api/apps/${app.id}/demo`,{method:'POST',token:a,body:{kind:'sale'}});
    assert.equal((await f.request('/api/events?environment=all',{token:b})).body.events.length,0);
    assert.equal((await f.request(`/api/events?before=${demo.body.event.id}`,{token:b})).status,400);
    await f.request('/api/preferences',{method:'PATCH',token:a,body:{sandbox:true}});
    assert.equal((await f.request('/api/preferences',{token:b})).body.preferences.sandbox,false);
    const device=await f.request('/api/devices',{method:'POST',token:a,body:{token:'a'.repeat(64),name:'Test iPhone',environment:'sandbox'}});
    assert.equal((await f.request('/api/devices',{token:b})).body.devices.length,0);
    assert.equal((await f.request(`/api/devices/${device.body.device.id}`,{method:'DELETE',token:b})).status,404);
  } finally {await f.close();}
});

test('demo is explicitly separate from Apple connection status and production activity',async()=>{
  const f=await fixture();try {
    const token=await f.register();const app=await f.add(token);
    const demo=await f.request(`/api/apps/${app.id}/demo`,{method:'POST',token,body:{kind:'refund'}});
    assert.equal(demo.status,201);assert.equal(demo.body.event.environment,'Demo');assert.equal(demo.body.event.isMonetary,false);
    assert.equal((await f.request('/api/events',{token})).body.events.length,0);
    assert.equal((await f.request('/api/events?environment=Demo',{token})).body.events.length,1);
    const current=(await f.request('/api/apps',{token})).body.apps[0];
    assert.equal(current.lastProductionEventAt,null);assert.equal(current.lastSandboxEventAt,null);
  } finally {await f.close();}
});

test('production can disable self registration and demonstration endpoints',async()=>{
  const f=await fixture({demoEnabled:false});try {
    const token=await f.register();const app=await f.add(token);
    assert.equal((await f.request(`/api/apps/${app.id}/demo`,{method:'POST',token,body:{kind:'sale'}})).status,403);
  }finally{await f.close();}
  const closed=await fixture({registrationEnabled:false});try {
    assert.equal((await closed.request('/api/auth/apple',{method:'POST',body:appleCredential('x@y.test')})).status,403);
  }finally{await closed.close();}
});

test('real webhook rejects unsigned input; cannot be enabled by a demo flag',async()=>{
  const f=await fixture();try {
    const token=await f.register();const app=await f.add(token);
    const url=new URL(app.webhookUrls.production).pathname;
    // Missing trust roots make a syntactically valid JWS unavailable, never trusted.
    assert.equal((await f.request(url,{method:'POST',body:{signedPayload:encoded({data:{environment:'Production'}})}})).status,503);
    assert.equal((await f.request(url,{method:'POST',body:{notificationType:'ONE_TIME_CHARGE',price:4990}})).status,400);
    assert.equal((await f.request('/api/events?environment=all',{token})).body.events.length,0);
  }finally{await f.close();}
});

test('verified duplicate deliveries and duplicate economic transitions produce one activity and push',async()=>{
  let value=verified();
  const f=await fixture({verify:async()=>value});try {
    const token=await f.register();const app=await f.add(token);
    await f.request('/api/devices',{method:'POST',token,body:{token:'b'.repeat(64),name:'Phone',environment:'sandbox'}});
    const url=new URL(app.webhookUrls.production).pathname;
    const send=()=>f.request(url,{method:'POST',body:{signedPayload:'test-fixture'}});
    assert.equal((await send()).status,200);assert.equal((await send()).body.status,'duplicate');
    value=verified('notification-two');assert.equal((await send()).body.status,'duplicate');
    assert.equal((await f.request('/api/events',{token})).body.events.length,1);
    assert.equal((await f.request('/api/deliveries',{token})).body.deliveries.length,1);
    assert.notEqual((await f.request('/api/apps',{token})).body.apps[0].lastProductionEventAt,null);
  }finally{await f.close();}
});

test('a sale, refund and refund reversal remain distinct economic transitions',async()=>{
  let value=verified();
  const f=await fixture({verify:async()=>value});try{
    const token=await f.register();const app=await f.add(token);const url=new URL(app.webhookUrls.production).pathname;
    const send=()=>f.request(url,{method:'POST',body:{signedPayload:'fixture'}});
    await send();value=verified('refund','Production','REFUND');await send();
    value=verified('reversed','Production','REFUND_REVERSED');await send();
    const events=(await f.request('/api/events',{token})).body.events;
    assert.deepEqual(events.map((e:any)=>e.kind),['refund_reversed','refund','sale']);
    assert.equal(events[1].amountMilliunits,-4990);assert.equal(events[0].amountMilliunits,null);
  }finally{await f.close();}
});

test('newer snapshots replace older values without duplicate pushes; older snapshots cannot regress them',async()=>{
  const time=Date.now();let value=verified('first','Production','ONE_TIME_CHARGE',4990,time);
  const f=await fixture({verify:async()=>value});try{
    const token=await f.register();const app=await f.add(token);const url=new URL(app.webhookUrls.production).pathname;
    const send=()=>f.request(url,{method:'POST',body:{signedPayload:'fixture'}});
    await send();value=verified('new','Production','ONE_TIME_CHARGE',9990,time+1000);await send();
    value=verified('old','Production','ONE_TIME_CHARGE',1990,time-1000);await send();
    const events=(await f.request('/api/events',{token})).body.events;assert.equal(events.length,1);assert.equal(events[0].amountMilliunits,9990);
  }finally{await f.close();}
});

test('sandbox receipt does not mark production verified and is muted by default',async()=>{
  const f=await fixture({verify:async(_payload,context)=>verified('sandbox',context.environment)});try{
    const token=await f.register();const app=await f.add(token);
    await f.request('/api/devices',{method:'POST',token,body:{token:'c'.repeat(64),name:'Phone',environment:'sandbox'}});
    assert.equal((await f.request(new URL(app.webhookUrls.sandbox).pathname,{method:'POST',body:{signedPayload:'fixture'}})).status,200);
    const state=(await f.request('/api/apps',{token})).body.apps[0];assert.equal(state.lastProductionEventAt,null);assert.ok(state.lastSandboxEventAt);
    assert.equal((await f.request('/api/events',{token})).body.events.length,0);
    assert.equal((await f.request('/api/events?environment=Sandbox',{token})).body.events.length,1);
    assert.equal((await f.request('/api/deliveries',{token})).body.deliveries.length,0);
  }finally{await f.close();}
});

test('RevenueCat forwarding uses only an environment hint then invokes binding-aware verifier',async()=>{
  let actualContext:any;
  const f=await fixture({verify:async(_payload,context)=>{actualContext=context;return verified('forwarded',context.environment);}});try{
    const token=await f.register();const app=await f.add(token,'revenuecat');
    const url=new URL(app.forwardingUrl).pathname;
    assert.equal((await f.request(url,{method:'POST',body:{signedPayload:encoded({data:{environment:'Sandbox'}})}})).status,200);
    assert.deepEqual(actualContext,{bundleId:input.bundleId,appleId:input.appleId,environment:'Sandbox'});
    assert.equal((await f.request(url,{method:'POST',body:{signedPayload:encoded({data:{environment:'Xcode'}})}})).status,400);
  }finally{await f.close();}
});

test('verification errors are rejected or retried without marking app connected',async()=>{
  let unavailable=false;
  const f=await fixture({verify:async()=>{throw new AppleVerificationError(unavailable?'verifier_unavailable':'invalid_signature','Test verification failure.');}});try{
    const token=await f.register();const app=await f.add(token);const url=new URL(app.webhookUrls.production).pathname;
    assert.equal((await f.request(url,{method:'POST',body:{signedPayload:'fixture'}})).status,400);
    unavailable=true;assert.equal((await f.request(url,{method:'POST',body:{signedPayload:'fixture'}})).status,503);
    assert.equal((await f.request('/api/apps',{token})).body.apps[0].lastProductionEventAt,null);
  }finally{await f.close();}
});

test('rotating a URL retires old endpoints and resets verification state',async()=>{
  const f=await fixture({verify:async()=>verified()});try{
    const token=await f.register();const app=await f.add(token);const url=new URL(app.webhookUrls.production).pathname;
    await f.request(url,{method:'POST',body:{signedPayload:'fixture'}});
    const rotated=(await f.request(`/api/apps/${app.id}/rotate-webhook`,{method:'POST',token})).body.app;
    assert.notEqual(rotated.webhookUrls.production,app.webhookUrls.production);assert.equal(rotated.lastProductionEventAt,null);
    assert.equal((await f.request(url,{method:'POST',body:{signedPayload:'fixture'}})).status,404);
  }finally{await f.close();}
});

test('a storage failure rolls back acknowledgment records and events',async()=>{
  const original=Store.prototype.set;
  const f=await fixture({verify:async()=>verified()});try{
    const token=await f.register();const app=await f.add(token);
    Store.prototype.set=async function(name,id,value,merge) {if(name==='events') throw new Error('Simulated write failure');return original.call(this,name,id,value,merge);};
    assert.equal((await f.request(new URL(app.webhookUrls.production).pathname,{method:'POST',body:{signedPayload:'fixture'}})).status,503);
    assert.equal((await rows(f.store,'notifications')).length,0);
    assert.equal((await f.request('/api/apps',{token})).body.apps[0].lastProductionEventAt,null);
    Store.prototype.set=original;
    assert.equal((await f.request(new URL(app.webhookUrls.production).pathname,{method:'POST',body:{signedPayload:'fixture'}})).status,200);
  }finally{Store.prototype.set=original;await f.close();}
});

test('device logout, revocation and token ownership change cancel stale delivery access',async()=>{
  const f=await fixture();try{
    const a=await f.register();const b=await f.register('other@example.test');const app=await f.add(a);
    const payload={token:'d'.repeat(64),name:'Shared phone',environment:'sandbox'};
    const first=(await f.request('/api/devices',{method:'POST',token:a,body:payload})).body.device;
    await f.request(`/api/apps/${app.id}/demo`,{method:'POST',token:a,body:{kind:'sale'}});
    assert.equal((await f.request('/api/deliveries',{token:a})).body.deliveries.length,1);
    await f.request('/api/devices',{method:'POST',token:b,body:payload});
    assert.equal((await f.request('/api/devices',{token:a})).body.devices[0].active,false);
    // Firestore keeps a tenant-owned audit trail. Old jobs can never follow the new owner.
    assert.equal((await f.request('/api/deliveries',{token:b})).body.deliveries.length,0);
    await f.request('/api/auth/logout',{method:'POST',token:b});
    assert.equal((await f.request('/api/auth/me',{token:b})).status,401);
  }finally{await f.close();}
});

test('missing APNs is an explicit unavailable state, never false delivery success',async()=>{
  const f=await fixture();try{
    const token=await f.register();const device=(await f.request('/api/devices',{method:'POST',token,body:{token:'e'.repeat(64),name:'Phone',environment:'sandbox'}})).body.device;
    assert.equal((await f.request('/api/config')).body.apnsConfigured,false);
    assert.equal((await f.request(`/api/devices/${device.id}/test`,{method:'POST',token})).status,503);
  }finally{await f.close();}
});

test('durable worker retries failures then records APNs acceptance and respects current privacy preference',async()=>{
  const results:PushResult[]=[{ok:false,retryable:true,error:'Temporarily offline'},{ok:true}];const sent:any[]=[];
  const transport:PushTransport={send:async(_device,payload)=>{sent.push(payload);return results.shift()!;}};
  const f=await fixture({pushTransport:transport});try{
    const token=await f.register();const app=await f.add(token);
    await f.request('/api/devices',{method:'POST',token,body:{token:'f'.repeat(64),name:'Phone',environment:'sandbox'}});
    await f.request(`/api/apps/${app.id}/demo`,{method:'POST',token,body:{kind:'sale'}});
    await f.worker.tick();let job=(await jobs(f.store))[0];assert.equal(job.state,'pending');assert.equal(job.attempts,1);
    await f.request('/api/preferences',{method:'PATCH',token,body:{hideAmounts:true}});
    await f.store.set('delivery_jobs',job.id,{next_attempt_at:0},true);
    await f.worker.tick();job=(await jobs(f.store))[0];assert.equal(job.state,'sent');assert.equal(job.attempts,2);
    assert.match(sent[0].aps.alert.body,/USD/);assert.doesNotMatch(sent[1].aps.alert.body,/USD/);
  }finally{await f.close();}
});

test('invalid APNs token disables the device and cancels further jobs',async()=>{
  let calls=0;const f=await fixture({pushTransport:{send:async()=>{calls++;return {ok:false,invalidDevice:true,error:'Unregistered'};}}});try{
    const token=await f.register();const app=await f.add(token);
    await f.request('/api/devices',{method:'POST',token,body:{token:'1'.repeat(64),name:'Phone',environment:'sandbox'}});
    await f.request(`/api/apps/${app.id}/demo`,{method:'POST',token,body:{kind:'sale'}});
    await f.request(`/api/apps/${app.id}/demo`,{method:'POST',token,body:{kind:'refund'}});
    await f.worker.tick();assert.equal(calls,1);
    assert.deepEqual((await jobs(f.store)).map(r=>r.state),['failed','cancelled']);
    assert.equal((await f.request('/api/devices',{token})).body.devices[0].active,false);
  }finally{await f.close();}
});

test('activity and pending jobs survive closing and reopening a Firestore-backed server',async()=>{
    const store=testStore();await resetAccounts(store,['first@example.test']);
    const first=await fixture({store});let token='';
    try {token=await first.register();const app=await first.add(token);
      await first.request('/api/devices',{method:'POST',token,body:{token:'2'.repeat(64),name:'Phone',environment:'sandbox'}});
      await first.request(`/api/apps/${app.id}/demo`,{method:'POST',token,body:{kind:'sale'}});
    }finally{await first.close();}
    const second=await fixture({store:testStore(store.prefix),pushTransport:{send:async()=>({ok:true})}});
    try {assert.equal((await second.request('/api/events?environment=Demo',{token})).body.events.length,1);await second.worker.tick();
      assert.equal((await second.request('/api/deliveries',{token})).body.deliveries[0].state,'sent');
    }finally{await second.close();}
});

test('activity pagination is stable and avoids duplicate pages',async()=>{
  const f=await fixture();try{
    const token=await f.register();const app=await f.add(token);
    for(let i=0;i<3;i++) await f.request(`/api/apps/${app.id}/demo`,{method:'POST',token,body:{kind:'sale'}});
    const first=(await f.request('/api/events?environment=Demo&limit=2',{token})).body;
    assert.equal(first.events.length,2);assert.ok(first.nextCursor);
    const second=(await f.request(`/api/events?environment=Demo&limit=2&before=${first.nextCursor}`,{token})).body;
    assert.equal(second.events.length,1);assert.equal(second.nextCursor,null);
    assert.notEqual(first.events[0].id,second.events[0].id);
  }finally{await f.close();}
});
