import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once,EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Store} from '../src/database.js';
import {createApplication} from '../src/app.js';
import {AppleVerificationError,type VerifiedAppleNotification} from '../src/apple.js';
import {forwardingUrl,forwardingAddresses,isPublicAddress,HttpsForwardTransport,type ForwardingJob,type ForwardResult} from '../src/forwarding.js';
import {RetryDelivery} from '../src/worker.js';
import {firebaseOptions,testStore,rows} from './firebase-fixture.js';
import {appleCredential} from './apple-auth-fixture.js';

const publicUrl='https://quest.example.com';
const resolvePublic=async()=>[{address:'8.8.8.8',family:4}];
const destinations={productionUrl:'https://backend.example.com/apple?secret=private',sandboxUrl:'https://sandbox.example.com/apple'};

test('forwarding URL validation rejects private networks, alternate IP encodings, credentials, and Quest loops',async()=>{
  for(const url of ['http://backend.example.com','https://user:pass@backend.example.com','https://backend.example.com:8443','https://backend.example.com/#secret',
    'https://localhost','https://localhost.','https://a.local','https://a.internal','https://127.1','https://2130706433','https://0x7f000001',
    'https://[::1]','https://[::ffff:127.0.0.1]','https://10.0.0.1','https://169.254.169.254','https://quest.example.com./a','https://alias.example.com/webhooks/apple/secret/production']) {
    assert.throws(()=>forwardingUrl(url,publicUrl),undefined,url);
  }
  for(const address of ['0.0.0.0','100.64.0.1','192.168.1.1','198.18.0.1','224.0.0.1','240.1.1.1','::','fc00::1','fe80::1','ff02::1','2001:db8::1','2002:7f00:1::','3fff::1']) assert.equal(isPublicAddress(address),false,address);
  for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicAddress(address),true,address);
  const url=forwardingUrl(destinations.productionUrl,publicUrl);
  assert.equal(url.href,destinations.productionUrl);
  await assert.rejects(forwardingAddresses(url,async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]),/public IP/);
  await assert.rejects(forwardingAddresses(url,async()=>[]),/public IP/);
  await assert.rejects(forwardingAddresses(url,async()=>{throw new Error('private DNS data');}),error=>!String(error).includes('private DNS data'));
});

test('HTTPS transport pins validated DNS, posts exact bytes, never follows redirects, and sanitizes failures',async()=>{
  let calls=0;let status=204;let dnsPrivate=false;const body=' { "signedPayload" : "original-signed-data" }\n';
  const transport=new HttpsForwardTransport(publicUrl,{resolve:async()=>[{address:dnsPrivate ? '127.0.0.1' : '8.8.8.8',family:4}],request:((url:any,options:any,callback:any)=>{
    calls++;assert.equal(url.href,destinations.productionUrl);assert.equal(options.method,'POST');assert.equal(options.agent,false);assert.equal(options.minVersion,'TLSv1.2');
    assert.deepEqual(Object.keys(options.headers).sort(),['Content-Length','Content-Type','User-Agent']);
    options.lookup('backend.example.com',{},(error:any,address:string,family:number)=>{assert.equal(error,null);assert.equal(address,'8.8.8.8');assert.equal(family,4);});
    options.lookup('backend.example.com',{all:true},(error:any,addresses:any)=>assert.deepEqual(addresses,[{address:'8.8.8.8',family:4}]));
    const req=new EventEmitter() as any;
    req.end=(sent:string)=>{assert.equal(sent,body);assert.equal(options.headers['Content-Length'],Buffer.byteLength(body));queueMicrotask(()=>status ? callback({statusCode:status,destroy(){},headers:{location:'https://127.0.0.1/'}}) : req.emit('error',new Error('secret destination credentials')));};
    req.destroy=()=>{};return req;
  }) as any});
  assert.equal((await transport.send(destinations.productionUrl,body)).ok,true);
  status=302;assert.equal((await transport.send(destinations.productionUrl,body)).retryable,false);assert.equal(calls,2);
  status=503;assert.equal((await transport.send(destinations.productionUrl,body)).retryable,true);
  status=401;assert.equal((await transport.send(destinations.productionUrl,body)).retryable,true);
  status=0;assert(!JSON.stringify(await transport.send(destinations.productionUrl,body)).includes('credentials'));
  dnsPrivate=true;assert.equal((await transport.send(destinations.productionUrl,body)).retryable,false);assert.equal(calls,5);
});

async function fixture() {
  const store=testStore();const sent:{url:string;body:string}[]=[];
  let result:ForwardResult={ok:true,retryable:false,status:204};
  let sendHook:((url:string,body:string)=>Promise<ForwardResult>)|undefined;
  const instance=createApplication({port:0,host:'127.0.0.1',publicUrl,...firebaseOptions,production:false,registrationEnabled:true,demoEnabled:true,appleRootDirectory:'/unused',apns:null,store,
    forwardingResolve:resolvePublic,forwardingTransport:{async send(url,body){sent.push({url,body});return sendHook ? sendHook(url,body) : result;}},
    verify:async(payload,context)=>{
      if(payload==='invalid') throw new AppleVerificationError('invalid_signature','Invalid signature.');
      const value=JSON.parse(Buffer.from(payload.split('.')[1],'base64url').toString());
      return {context:{...context,appleId:Number(context.appleId)},notification:{notificationUUID:value.uuid,signedDate:Date.now(),notificationType:value.type ?? 'ONE_TIME_CHARGE',version:'2.0',data:{...context,appAppleId:Number(context.appleId)}},
        transaction:{bundleId:context.bundleId,environment:context.environment,inAppOwnershipType:'PURCHASED',transactionId:value.transaction ?? 'same-transaction',originalTransactionId:'original',productId:'product',price:4990,currency:'USD',purchaseDate:Date.now()},renewal:null} as VerifiedAppleNotification;
    },
  });
  const server=instance.app.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${(server.address() as any).port}`;
  const request=async(path:string,method='GET',body?:unknown,token?:string,raw?:string)=>{
    const response=await fetch(`${base}${path}`,{method,headers:{'Content-Type':'application/json',...(token ? {Authorization:`Bearer ${token}`} : {})},body:raw ?? (body===undefined ? undefined : JSON.stringify(body))});
    return {status:response.status,body:await response.json() as any};
  };
  const signIn=async()=>{const res=await request('/api/auth/apple','POST',appleCredential(`forward-${randomUUID()}@example.test`));assert.equal(res.status,200);return res.body.token as string;};
  const token=await signIn();
  const res=await request('/api/apps','POST',{name:'Forwarded app',bundleId:'com.example.forward',appleId:'123456789',source:'apple'},token);
  assert.equal(res.status,201);const app=res.body.app;
  const configure=async(urls=destinations)=>{const res=await request(`/api/apps/${app.id}/forwarding`,'PUT',urls,token);assert.equal(res.status,200,JSON.stringify(res.body));return res.body.app;};
  const post=(uuid:string,environment='production',type='ONE_TIME_CHARGE',transaction?:string)=>{
    const payload=`header.${Buffer.from(JSON.stringify({uuid,type,transaction,data:{environment:environment==='sandbox' ? 'Sandbox' : 'Production'}})).toString('base64url')}.signature`;
    const raw=` { "signedPayload" : "${payload}" }\n`;
    return {raw,send:()=>request(new URL(app.webhookUrls[environment]).pathname,'POST',undefined,undefined,raw)};
  };
  return {...instance,app,request,token,signIn,configure,post,sent,setResult:(value:ForwardResult)=>{result=value;},setSendHook:(hook:typeof sendHook)=>{sendHook=hook;},
    async close(){await Promise.all([instance.worker.stop(),instance.forwardingWorker.stop()]);await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

test('forwarding settings are owner-only, validated, environment-specific, and compatible with existing apps',async()=>{
  const f=await fixture();try {
    assert.deepEqual(f.app.forwarding,{productionUrl:null,sandboxUrl:null});
    const path=`/api/apps/${f.app.id}/forwarding`;
    assert.equal((await f.request(path,'PUT',destinations)).status,401);
    assert.equal((await f.request(path,'PUT',destinations,await f.signIn())).status,404);
    assert.equal((await f.request(`${path}/deliveries`,'GET',undefined,await f.signIn())).status,404);
    assert.equal((await f.request(path,'PUT',{productionUrl:'https://127.1',sandboxUrl:null},f.token)).status,400);
    assert.equal((await f.request(path,'PUT',{productionUrl:destinations.productionUrl},f.token)).status,400);
    assert.deepEqual((await f.configure()).forwarding,destinations);
    const before=await f.store.getApp(f.app.id);await f.configure();
    assert.deepEqual((await f.store.getApp(f.app.id))?.forwarding,before?.forwarding);
    await f.store.set('apps',f.app.id,{source:'revenuecat'},true);
    assert.equal((await f.request(path,'PUT',destinations,f.token)).status,400);
  } finally {await f.close();}
});

test('durable forwarding sends original payloads once per UUID, even for economically deduplicated updates and TEST',async()=>{
  const f=await fixture();try {
    await f.configure();const event=f.post('one');
    const responses=await Promise.all([event.send(),event.send(),event.send()]);
    assert(responses.every(r=>r.status===200));assert.equal(f.sent.length,0);
    assert.equal((await rows(f.store,'forwarding_jobs')).length,1);
    await f.post('two').send();await f.post('three','sandbox').send();await f.post('test','production','TEST','test-transaction').send();
    assert.equal((await rows(f.store,'forwarding_jobs')).length,4);
    assert.equal((await rows(f.store,'events')).length,3);assert.equal((await rows(f.store,'delivery_jobs')).length,0);
    const job=(await rows(f.store,'forwarding_jobs')).find(j=>j.notification_uuid==='one');
    assert.equal(job.body,event.raw);
    await f.forwardingWorker.tick();assert.equal(f.sent.length,4);assert(f.sent.some(s=>s.body===event.raw && s.url===destinations.productionUrl));
    assert.equal(f.sent.filter(s=>s.url===destinations.sandboxUrl).length,1);
    assert((await rows(f.store,'forwarding_jobs')).every(j=>j.state==='sent' && j.body===null && j.destination===null));
    await event.send();await f.forwardingWorker.deliver(job.id);assert.equal(f.sent.length,4);
    const delivery=await f.request(`/api/apps/${f.app.id}/forwarding/deliveries`,'GET',undefined,f.token);
    assert.equal(delivery.body.deliveries.length,4);assert(!JSON.stringify(delivery.body).includes('signedPayload'));assert(!JSON.stringify(delivery.body).includes('private'));
  } finally {await f.close();}
});

test('forwarding retries survive worker recreation, suppress concurrent sends, and fence late completions',async()=>{
  const f=await fixture();try {
    await f.configure();await f.post('retry').send();let [job]=await rows(f.store,'forwarding_jobs');
    f.setResult({ok:false,retryable:true,status:503,error:'Forwarding server returned HTTP 503.'});
    await assert.rejects(f.forwardingWorker.deliver(job.id),RetryDelivery);
    job=await f.store.get('forwarding_jobs',job.id);assert.equal(job.state,'pending');assert.equal(job.attempts,1);assert(job.body);assert(job.next_attempt_at>Date.now());
    await assert.rejects(f.forwardingWorker.deliver(job.id),RetryDelivery);assert.equal(f.sent.length,1);
    await f.store.set('forwarding_jobs',job.id,{next_attempt_at:Date.now()-1},true);
    let release!:(result:ForwardResult)=>void;let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
    f.setSendHook(()=>{began();return new Promise(resolve=>{release=resolve;});});
    const first=f.forwardingWorker.deliver(job.id);await started;
    await assert.rejects(f.forwardingWorker.deliver(job.id),RetryDelivery);
    await f.store.set('forwarding_jobs',job.id,{lease_until:Date.now()-1},true);
    f.setSendHook(undefined);f.setResult({ok:true,retryable:false,status:200});
    // A fresh worker uses the same persisted outbox after a process restart.
    const {ForwardingWorker}=await import('../src/forwarding.js');
    const restarted=new ForwardingWorker(f.store,{send:async()=>({ok:true,retryable:false,status:200})});
    await restarted.deliver(job.id);release({ok:false,retryable:true,status:500});await assert.rejects(first,RetryDelivery);
    job=await f.store.get('forwarding_jobs',job.id);assert.equal(job.state,'sent');assert.equal(job.status_code,200);assert.equal(job.body,null);
  } finally {await f.close();}
});

test('changing destinations cancels old jobs without affecting the other environment; removal purges forwarding',async()=>{
  const f=await fixture();try {
    await f.configure();await f.post('prod').send();await f.post('sandbox','sandbox').send();
    const sandboxGeneration=(await f.store.getApp(f.app.id))?.forwarding?.sandbox?.generation;
    await f.configure({...destinations,productionUrl:'https://new.example.com/apple'});
    assert.equal((await f.store.getApp(f.app.id))?.forwarding?.sandbox?.generation,sandboxGeneration);
    await f.forwardingWorker.tick();assert.equal(f.sent.length,1);assert.equal(f.sent[0].url,destinations.sandboxUrl);
    const cancelled=(await rows(f.store,'forwarding_jobs')).find(j=>j.environment==='Production');assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.body,null);
    await f.post('new').send();await f.request(`/api/apps/${f.app.id}`,'DELETE',undefined,f.token);await f.forwardingWorker.tick();assert.equal(f.sent.length,1);
    assert.deepEqual((await f.store.get<any>('apps',f.app.id)).forwarding,{production:null,sandbox:null});
    const {purgeApp}=await import('../src/functions.js');await purgeApp(f.store,f.app.id);
    assert.equal((await rows(f.store,'forwarding_jobs')).length,0);
  } finally {await f.close();}
});

test('disabled forwarding, demo, invalid signatures, and history never forward; first live arrival after import does',async()=>{
  const f=await fixture();try {
    await f.post('disabled').send();assert.equal((await rows(f.store,'forwarding_jobs')).length,0);
    await f.configure();
    assert.equal((await f.request(new URL(f.app.webhookUrls.production).pathname,'POST',{signedPayload:'invalid'})).status,400);
    await f.request(`/api/apps/${f.app.id}/demo`,'POST',{kind:'sale'},f.token);
    // A historical receipt shares dedupe storage with the webhook, but cannot swallow forwarding.
    const app=(await f.store.getApp(f.app.id))!;
    const template=(await rows(f.store,'events')).find(e=>e.environment==='Production');
    await f.store.saveEvent({...f.store.eventResponse(template),id:randomUUID()},app.user_id,null,Date.now(),{uuid:'imported',secret:app.webhook_secret,body:'must not be forwarded'},true);
    assert.equal((await rows(f.store,'forwarding_jobs')).length,0);
    await f.post('disabled').send();assert.equal((await rows(f.store,'forwarding_jobs')).length,0);
    const live=f.post('imported');await live.send();await live.send();
    assert.equal((await rows(f.store,'forwarding_jobs')).length,1);
    assert.equal((await rows(f.store,'forwarding_jobs'))[0].body,live.raw);
    await f.request(`/api/apps/${f.app.id}/forwarding`,'PUT',{productionUrl:destinations.productionUrl,sandboxUrl:null},f.token);
    await f.post('sandbox-disabled','sandbox').send();assert.equal((await rows(f.store,'forwarding_jobs')).length,1);
  } finally {await f.close();}
});

test('outbox write failure rolls back receipt and activity, allowing Apple retry',async t=>{
  const f=await fixture();try {
    await f.configure();const original=Store.prototype.set;
    const mock=t.mock.method(Store.prototype,'set',async function(this:Store,name:string,id:string,value:object,merge=false){
      if(name==='forwarding_jobs') throw new Error('Storage unavailable');return original.call(this,name,id,value,merge);
    });
    const event=f.post('atomic');assert.equal((await event.send()).status,503);
    assert.equal((await rows(f.store,'events')).length,0);assert.equal((await rows(f.store,'notifications')).length,0);
    assert.equal((await f.store.getApp(f.app.id))?.last_production_at,null);
    mock.mock.restore();assert.equal((await event.send()).status,200);assert.equal((await rows(f.store,'forwarding_jobs')).length,1);
  } finally {await f.close();}
});

test('expired deliveries and terminal rejection scrub sensitive payloads',async()=>{
  const f=await fixture();try {
    await f.configure();await f.post('expired').send();const [job]=await rows(f.store,'forwarding_jobs');
    await f.store.set('forwarding_jobs',job.id,{created_at:new Date(Date.now()-86400001).toISOString()},true);
    await f.forwardingWorker.deliver(job.id);assert.equal(f.sent.length,0);
    assert.equal((await f.store.get<ForwardingJob>('forwarding_jobs',job.id))?.state,'failed');
    await f.post('redirect').send();f.setResult({ok:false,retryable:false,status:302,error:'Forwarding server returned HTTP 302.'});await f.forwardingWorker.tick();
    assert((await rows(f.store,'forwarding_jobs')).every(j=>j.state==='failed' && j.body===null && j.destination===null));
  } finally {await f.close();}
});
